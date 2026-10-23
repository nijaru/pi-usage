import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedUsageConfig } from "./config.ts";
import { STATUS_KEY } from "./constants.ts";
import { accountIdFromAccessToken, fetchCodexUsage, formatUsageStatus, type CodexUsage } from "./usage.ts";
import {
	BALANCE_PROVIDERS, bearerToken, fetchBalance, fingerprint, formatBalanceReport, formatBalanceStatus,
	isBalanceProvider, officialIdentity, resolveCreditsKey, type ProviderReport,
} from "./providers.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;
type Report = { codex: CodexUsage } | { balance: ProviderReport };
interface Cached { identity: string; fetchedAt: number; report: Report; stale?: boolean; }
interface Credential { identity: string; token: string; accountId?: string; creditsKey?: string; config: ResolvedUsageConfig; }
const supported = (provider: string) => provider === "openai-codex" || isBalanceProvider(provider);
const status = (report: Report, stale = false) => {
	const text = "codex" in report ? formatUsageStatus(report.codex) : formatBalanceStatus(report.balance);
	// A short left marker survives Pi's right-side footer truncation.
	return text && stale ? `stale · ${text}` : text;
};
/** Footer values carry a leading separator; notifications and reports use `status` directly. */
const display = (text: string) => text ? `· ${text}` : undefined;

/**
 * Bound an auth resolution so a stalled credential resolver cannot hang a
 * handler. `Promise.race` cannot cancel the resolver, but it stops us waiting.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Operation timed out")), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** One owner for refreshes, cancellation, identity checks, and the existing footer slot. */
export function registerUsage(pi: ExtensionAPI, readConfig: (ctx: ExtensionContext) => ResolvedUsageConfig): void {
	let generation = 0;
	let active = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cache = new Map<string, Cached>();
	const requests = new Map<string, { identity: string; controller: AbortController; promise: Promise<Cached> }>();
	const controllers = new Set<AbortController>();
	const lastAttempt = new Map<string, number>();

	function stop(ctx: ExtensionContext): void {
		active = false;
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		for (const controller of controllers) controller.abort();
		controllers.clear(); requests.clear(); cache.clear(); lastAttempt.clear();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	async function credential(ctx: ExtensionContext, model: PiModel): Promise<Credential> {
		let auth;
		try { auth = await withTimeout(ctx.modelRegistry.getApiKeyAndHeaders(model), readConfig(ctx).requestTimeoutMs); }
		catch { throw new Error("Provider authentication unavailable"); }
		if (!auth.ok) throw new Error("Provider authentication unavailable");
		// Auth may run a slow command. Read preferences/bindings only afterward,
		// and reject a model whose route changed while its auth was resolving.
		const config = readConfig(ctx), current = choose(ctx, model.provider);
		if (!config.enabled) throw new Error("Usage display is disabled");
		if (!current || current.id !== model.id || current.api !== model.api || current.baseUrl !== model.baseUrl || JSON.stringify(current.headers) !== JSON.stringify(model.headers)) {
			throw new DOMException("Provider routing changed", "AbortError");
		}
		if (model.provider === "openai-codex") {
			for (const value of [model.baseUrl, auth.baseUrl ?? model.baseUrl, config.usageUrl]) {
				const url = new URL(value);
				if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw new Error("Codex usage requires the official ChatGPT origin");
			}
			const token = bearerToken(auth);
			const accountHeader = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "chatgpt-account-id")?.[1];
			const accountId = typeof accountHeader === "string" ? accountHeader : token ? accountIdFromAccessToken(token) : undefined;
			if (!token || !accountId) throw new Error("Codex account unavailable");
			return { token, accountId, config, identity: fingerprint(`${model.provider}\0${model.baseUrl}\0${auth.baseUrl ?? model.baseUrl}\0${config.usageUrl}\0${token}\0${accountId}`) };
		}
		const resolved = officialIdentity(model, auth);
		const creditsKey = resolveCreditsKey(resolved, config.openrouterCredits);
		return { token: resolved.token, creditsKey, config, identity: fingerprint(`${resolved.fingerprint}\0${model.baseUrl}\0${auth.baseUrl ?? model.baseUrl}\0${creditsKey ?? ""}`) };
	}

	async function query(ctx: ExtensionContext, model: PiModel, force = false, preAuth?: Credential): Promise<Cached> {
		const owner = generation;
		const auth = preAuth ?? await credential(ctx, model);
		const config = auth.config;
		if (owner !== generation) throw new DOMException("Session changed", "AbortError");
		const previous = cache.get(model.provider);
		if (previous && previous.identity !== auth.identity) {
			cache.delete(model.provider);
			if (ctx.model?.provider === model.provider) ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		if (!force && previous?.identity === auth.identity && Date.now() - previous.fetchedAt < config.pollIntervalMs) return previous;
		const pending = requests.get(model.provider);
		if (pending?.identity === auth.identity) return pending.promise;
		pending?.controller.abort();
		const controller = new AbortController();
		controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(new Error("Usage request timed out")), config.requestTimeoutMs);
		const promise = (async (): Promise<Cached> => {
			try {
				let result: Report;
				if (model.provider === "openai-codex") {
					result = { codex: await fetchCodexUsage({ accessToken: auth.token, accountId: auth.accountId!, usageUrl: config.usageUrl, timeoutMs: config.requestTimeoutMs, signal: controller.signal }) };
				} else {
					result = { balance: await fetchBalance({ provider: model.provider, model, token: auth.token, fingerprint: auth.identity }, controller.signal, undefined, auth.creditsKey) };
				}
				controller.signal.throwIfAborted();
				const current = await credential(ctx, model);
				if (owner !== generation || current.identity !== auth.identity) {
					// The same account may already have a fresh result in a newer
					// session. Identity alone does not authorize stale cleanup.
					if (owner === generation && cache.get(model.provider)?.identity === auth.identity) cache.delete(model.provider);
					throw new DOMException("Account or session changed", "AbortError");
				}
				const value: Cached = { identity: auth.identity, fetchedAt: Date.now(), report: result };
				cache.set(model.provider, value);
				if (cache.size > 32) cache.delete(cache.keys().next().value!);
				return value;
			} catch (error) {
				if (owner === generation && cache.get(model.provider)?.identity === auth.identity) {
					const value = cache.get(model.provider)!;
					value.stale = true;
				}
				throw error;
			} finally {
				clearTimeout(timeout); controllers.delete(controller);
				if (requests.get(model.provider)?.controller === controller) requests.delete(model.provider);
			}
		})();
		requests.set(model.provider, { identity: auth.identity, controller, promise });
		return promise;
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const model = ctx.model, owner = generation;
		if (!ctx.hasUI || !model || !supported(model.provider)) return;
		const config = readConfig(ctx);
		if (!config.enabled) { if (active) stop(ctx); return; }
		// Enabling the extension at runtime starts polling even without a
		// session/model event; start() schedules from the current interval.
		if (!active) { start(ctx); return; }
		try {
			// Back off failures between frequent tool/assistant turns, but still check account identity.
			const auth = await credential(ctx, model);
			if (owner !== generation) return;
			const cached = cache.get(model.provider);
			if (cached && cached.identity !== auth.identity) { cache.delete(model.provider); ctx.ui.setStatus(STATUS_KEY, undefined); }
			const key = auth.identity;
			if (Date.now() - (lastAttempt.get(key) ?? 0) < Math.min(5000, config.pollIntervalMs)) return;
			lastAttempt.set(key, Date.now());
			if (lastAttempt.size > 32) lastAttempt.delete(lastAttempt.keys().next().value!);
			const value = await query(ctx, model, false, auth);
			if (owner === generation && ctx.model?.provider === model.provider && ctx.model?.id === model.id) ctx.ui.setStatus(STATUS_KEY, display(status(value.report, value.stale)));
		} catch (error) {
			if (owner !== generation) return;
			const cancelled = error instanceof Error && error.name === "AbortError";
			const value = cache.get(model.provider);
			// Recheck identity even on failures; a stale display must never belong to another account.
			let same = false;
			try { same = value?.identity === (await credential(ctx, model)).identity; } catch { /* Unavailable auth clears old values. */ }
			if (owner !== generation) return;
			ctx.ui.setStatus(STATUS_KEY, value && same ? display(status(value.report, value.stale || !cancelled)) : cancelled ? undefined : display(`${model.provider} usage unavailable`));
		}
	}
	/** Reschedule from the current config after every refresh. */
	function schedule(ctx: ExtensionContext): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (!active) return;
		const config = readConfig(ctx), owner = generation;
		timer = setTimeout(async () => {
			if (owner !== generation) return;
			await refresh(ctx);
			// A model/session replacement may have installed a new polling loop
			// while authentication was pending. Never replace that loop with ours.
			if (owner === generation) schedule(ctx);
		}, config.pollIntervalMs);
		timer.unref?.();
	}
	function start(ctx: ExtensionContext): void {
		stop(ctx);
		const config = readConfig(ctx);
		if (!config.enabled || !ctx.hasUI || !ctx.model || !supported(ctx.model.provider)) return;
		active = true;
		schedule(ctx);
		void refresh(ctx);
	}
	function choose(ctx: ExtensionContext, provider: string): PiModel | undefined {
		if (ctx.model?.provider === provider) return ctx.model;
		return ctx.modelRegistry.getAvailable().find(model => model.provider === provider);
	}
	function discard(ctx: ExtensionContext, model: PiModel, value: Cached): void {
		const cached = cache.get(model.provider);
		// A concurrent refresh may already own a newer account's value.
		if (cached && cached.identity !== value.identity) return;
		cache.delete(model.provider);
		if (ctx.model?.provider === model.provider) ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	pi.registerCommand("usage", {
		description: "Show quota or balance: /usage [provider|all]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/usage requires an interactive UI");
			const selected = args.trim() || ctx.model?.provider;
			if (!selected || (selected !== "all" && !supported(selected))) {
				ctx.ui.notify(`Usage is available for openai-codex, ${BALANCE_PROVIDERS.join(", ")}.`, "info");
				return;
			}
			const providers = selected === "all"
				? [...new Set([ctx.model?.provider, ...ctx.modelRegistry.getAvailable().map(model => model.provider)])].filter((provider): provider is string => Boolean(provider && supported(provider)))
				: [selected];
			const owner = generation;
			if (!providers.length) { ctx.ui.notify("No supported authenticated providers configured", "info"); return; }
			let next = 0;
			await Promise.all(Array.from({ length: Math.min(2, providers.length) }, async () => {
				while (next < providers.length && owner === generation) {
					const provider = providers[next++], model = choose(ctx, provider);
					if (!model) { ctx.ui.notify(`${provider}: no authenticated model configured`, "info"); continue; }
					let value: Cached | undefined;
					try {
						value = await query(ctx, model, true);
						const current = choose(ctx, provider);
						if (!current || current.id !== model.id || (await credential(ctx, current)).identity !== value.identity) {
							throw new DOMException("Account or authentication changed", "AbortError");
						}
						if (owner !== generation) return;
						// Publish immediately after this account's validation. Holding a
						// validated report behind another provider's async work is unsafe.
						if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) ctx.ui.setStatus(STATUS_KEY, display(status(value.report)));
						ctx.ui.notify("codex" in value.report ? `Codex usage: ${status(value.report)}` : formatBalanceReport(value.report.balance), "info");
					} catch (error) {
						if (owner !== generation) return;
						if (value) discard(ctx, model, value);
						ctx.ui.notify(`${provider}: ${error instanceof Error ? error.message : "usage unavailable"}`, "info");
					}
				}
			}));
			// The active footer may predate a slower report. Clear a changed account
			// without repeating any billing request or touching a newer cached value.
			if (owner !== generation || selected !== "all" || !ctx.model) return;
			const model = ctx.model, value = cache.get(model.provider);
			if (!value) return;
			let same = false;
			try { same = (await credential(ctx, model)).identity === value.identity; } catch { /* Missing auth invalidates the old footer too. */ }
			if (owner === generation && !same) discard(ctx, model, value);
		},
	});
	pi.on("session_start", async (_event, ctx) => { start(ctx); });
	pi.on("model_select", async (_event, ctx) => { start(ctx); });
	// Pi 0.87 defers runs requested by other settled handlers until every handler
	// finishes, so awaiting a network refresh here would delay their continuations.
	pi.on("agent_settled", (_event, ctx) => { void refresh(ctx); });
	pi.on("session_shutdown", async (_event, ctx) => { stop(ctx); });
}
