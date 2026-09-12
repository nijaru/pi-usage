import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedUsageConfig } from "./config.ts";
import { STATUS_KEY } from "./constants.ts";
import { accountIdFromAccessToken, fetchCodexUsage, formatUsageStatus, type CodexUsage } from "./usage.ts";
import {
	BALANCE_PROVIDERS, fetchBalance, fingerprint, formatBalanceReport, formatBalanceStatus,
	isBalanceProvider, officialIdentity, resolveCreditsKey, type ProviderReport,
} from "./providers.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;
type Report = { codex: CodexUsage } | { balance: ProviderReport };
interface Cached { identity: string; fetchedAt: number; report: Report; stale?: boolean; }
interface Credential { identity: string; token: string; accountId?: string; creditsKey?: string; }
const supported = (provider: string) => provider === "openai-codex" || isBalanceProvider(provider);
const status = (report: Report) => "codex" in report ? formatUsageStatus(report.codex) : formatBalanceStatus(report.balance);

/** One owner for refreshes, cancellation, identity checks, and the existing footer slot. */
export function registerUsage(pi: ExtensionAPI, readConfig: (ctx: ExtensionContext) => ResolvedUsageConfig): void {
	let generation = 0;
	let active = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const cache = new Map<string, Cached>();
	const requests = new Map<string, { identity: string; controller: AbortController; promise: Promise<Cached> }>();
	const controllers = new Set<AbortController>();
	const lastAttempt = new Map<string, number>();

	function stop(ctx: ExtensionContext): void {
		active = false;
		generation++;
		if (timer) clearInterval(timer);
		timer = undefined;
		for (const controller of controllers) controller.abort();
		controllers.clear(); requests.clear(); cache.clear(); lastAttempt.clear();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	async function credential(ctx: ExtensionContext, model: PiModel, config: ResolvedUsageConfig): Promise<Credential> {
		let auth;
		try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
		catch { throw new Error("Provider authentication unavailable"); }
		if (!auth.ok) throw new Error("Provider authentication unavailable");
		if (model.provider === "openai-codex") {
			for (const value of [model.baseUrl, auth.baseUrl ?? model.baseUrl, config.usageUrl]) {
				const url = new URL(value);
				if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw new Error("Codex usage requires the official ChatGPT origin");
			}
			const authorization = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization");
			const token = authorization ? (typeof authorization[1] === "string" ? /^Bearer\s+(.+)$/i.exec(authorization[1])?.[1] : undefined) : auth.apiKey;
			const accountHeader = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "chatgpt-account-id")?.[1];
			const accountId = typeof accountHeader === "string" ? accountHeader : token ? accountIdFromAccessToken(token) : undefined;
			if (!token || !accountId) throw new Error("Codex account unavailable");
			return { token, accountId, identity: fingerprint(`${model.provider}\0${auth.baseUrl ?? model.baseUrl}\0${token}\0${accountId}`) };
		}
		const resolved = officialIdentity(model, auth);
		const creditsKey = resolveCreditsKey(resolved, config.openrouterCredits);
		return { token: resolved.token, creditsKey, identity: fingerprint(`${resolved.fingerprint}\0${creditsKey ?? ""}`) };
	}

	async function query(ctx: ExtensionContext, model: PiModel, force = false): Promise<Cached> {
		const owner = generation, config = readConfig(ctx);
		if (!config.enabled) throw new Error("Usage display is disabled");
		const auth = await credential(ctx, model, config);
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
				const current = await credential(ctx, model, readConfig(ctx));
				if (owner !== generation || current.identity !== auth.identity) {
					if (cache.get(model.provider)?.identity === auth.identity) cache.delete(model.provider);
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
		if (!active || !ctx.hasUI || !model || !supported(model.provider)) return;
		if (!readConfig(ctx).enabled) { stop(ctx); return; }
		try {
			// Back off failures between frequent tool/assistant turns, but still check account identity.
			const auth = await credential(ctx, model, readConfig(ctx));
			const cached = cache.get(model.provider);
			if (cached && cached.identity !== auth.identity) { cache.delete(model.provider); ctx.ui.setStatus(STATUS_KEY, undefined); }
			const key = auth.identity;
			if (Date.now() - (lastAttempt.get(key) ?? 0) < Math.min(5000, readConfig(ctx).pollIntervalMs)) return;
			lastAttempt.set(key, Date.now());
			if (lastAttempt.size > 32) lastAttempt.delete(lastAttempt.keys().next().value!);
			const value = await query(ctx, model);
			if (owner === generation && ctx.model?.provider === model.provider && ctx.model?.id === model.id) ctx.ui.setStatus(STATUS_KEY, `${status(value.report)}${value.stale ? " · stale" : ""}`);
		} catch (error) {
			if (owner !== generation) return;
			const cancelled = error instanceof Error && error.name === "AbortError";
			const value = cache.get(model.provider);
			// Recheck identity even on failures; a stale display must never belong to another account.
			let same = false;
			try { same = value?.identity === (await credential(ctx, model, readConfig(ctx))).identity; } catch { /* Unavailable auth clears old values. */ }
			if (owner !== generation) return;
			ctx.ui.setStatus(STATUS_KEY, value && same ? `${status(value.report)}${value.stale || !cancelled ? " · stale" : ""}` : cancelled ? undefined : `${model.provider} usage unavailable`);
		}
	}
	function start(ctx: ExtensionContext): void {
		stop(ctx);
		const config = readConfig(ctx);
		if (!config.enabled || !ctx.hasUI || !ctx.model || !supported(ctx.model.provider)) return;
		active = true;
		timer = setInterval(() => { void refresh(ctx); }, config.pollIntervalMs);
		timer.unref?.();
		void refresh(ctx);
	}
	function choose(ctx: ExtensionContext, provider: string): PiModel | undefined {
		if (ctx.model?.provider === provider) return ctx.model;
		return ctx.modelRegistry.getAvailable().find(model => model.provider === provider);
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
			const owner = generation, results: string[] = new Array(providers.length);
			let next = 0;
			await Promise.all(Array.from({ length: Math.min(2, providers.length) }, async () => {
				while (next < providers.length && owner === generation) {
					const index = next++, provider = providers[index], model = choose(ctx, provider);
					if (!model) { results[index] = `${provider}: no authenticated model configured`; continue; }
					try {
						const value = await query(ctx, model, true);
						results[index] = "codex" in value.report ? `Codex usage: ${status(value.report)}` : formatBalanceReport(value.report.balance);
						if (ctx.model?.provider === model.provider && ctx.model?.id === model.id && owner === generation) ctx.ui.setStatus(STATUS_KEY, status(value.report));
					} catch (error) {
						results[index] = `${provider}: ${error instanceof Error ? error.message : "usage unavailable"}`;
					}
				}
			}));
			if (owner === generation) ctx.ui.notify(results.filter(Boolean).join("\n\n") || "No supported authenticated providers configured", "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => { start(ctx); });
	pi.on("model_select", async (_event, ctx) => { start(ctx); });
	pi.on("agent_settled", async (_event, ctx) => { await refresh(ctx); });
	pi.on("session_shutdown", async (_event, ctx) => { stop(ctx); });
}
