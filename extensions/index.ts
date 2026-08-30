import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolveConfig, type ResolvedUsageConfig } from "./config.ts";
import {
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	STATUS_KEY,
} from "./constants.ts";
import {
	accountIdFromAccessToken,
	CODEX_PROVIDER,
	DEFAULT_USAGE_URL,
	fetchCodexUsage,
	formatUsageStatus,
	type CodexUsage,
} from "./usage.ts";

export * from "./config.ts";
export * from "./constants.ts";
export * from "./usage.ts";

interface UsageCache {
	accountId: string;
	fetchedAt: number;
	usage: CodexUsage;
}

function isCodexModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === CODEX_PROVIDER;
}

function canShowStatus(ctx: ExtensionContext): boolean {
	return ctx.hasUI;
}

/**
 * Register the usage status extension. It never changes request handling: it
 * only reads the authenticated Codex usage endpoint and updates setStatus().
 */
export default function piUsage(pi: ExtensionAPI): void {
	let config: ResolvedUsageConfig = {
		enabled: true,
		pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		usageUrl: DEFAULT_USAGE_URL,
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestController: AbortController | undefined;
	let inFlight: Promise<void> | undefined;
	let generation = 0;
	let cache: UsageCache | undefined;
	let lastError: string | undefined;

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, cache ? formatUsageStatus(cache.usage) || undefined : undefined);
	}

	function stop(ctx: ExtensionContext): void {
		generation += 1;
		if (timer) clearInterval(timer);
		timer = undefined;
		requestController?.abort();
		requestController = undefined;
		inFlight = undefined;
		cache = undefined;
		lastError = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	async function resolveAccount(ctx: ExtensionContext): Promise<{ accessToken: string; accountId: string } | undefined> {
		const authResult = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
		const accessToken = authResult?.auth.apiKey;
		const accountId = accessToken ? accountIdFromAccessToken(accessToken) : undefined;
		return accessToken && accountId ? { accessToken, accountId } : undefined;
	}

	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (!config.enabled || !canShowStatus(ctx) || !isCodexModel(ctx)) return;
		if (inFlight) return inFlight;

		const runGeneration = generation;
		const controller = new AbortController();
		requestController = controller;
		inFlight = (async () => {
			try {
				const identity = await resolveAccount(ctx);
				if (runGeneration !== generation || controller.signal.aborted) return;
				if (!identity) {
					cache = undefined;
					lastError = undefined;
					setStatus(ctx);
					return;
				}
				const { accessToken, accountId } = identity;
				if (cache && cache.accountId !== accountId) {
					cache = undefined;
					setStatus(ctx);
				}

				const age = Date.now() - (cache?.accountId === accountId ? cache.fetchedAt : 0);
				if (!force && cache?.accountId === accountId && age < config.pollIntervalMs) {
					setStatus(ctx);
					return;
				}

				const usage = await fetchCodexUsage({
					accessToken,
					accountId,
					usageUrl: config.usageUrl,
					timeoutMs: config.requestTimeoutMs,
					signal: controller.signal,
				});
				if (runGeneration !== generation || controller.signal.aborted) return;
				const currentIdentity = await resolveAccount(ctx);
				if (!currentIdentity || currentIdentity.accountId !== accountId) {
					if (currentIdentity?.accountId !== accountId) {
						cache = undefined;
						setStatus(ctx);
					}
					return;
				}
				cache = { accountId, fetchedAt: Date.now(), usage };
				lastError = undefined;
				setStatus(ctx);
			} catch (error) {
				if (controller.signal.aborted || runGeneration !== generation) return;
				lastError = error instanceof Error ? error.message : String(error);
				// Keep the last successful value during transient failures.
				setStatus(ctx);
			} finally {
				if (runGeneration === generation) {
					requestController = undefined;
					inFlight = undefined;
				}
			}
		})();
		return inFlight;
	}

	function start(ctx: ExtensionContext, refreshImmediately = true): void {
		if (!config.enabled || !canShowStatus(ctx) || !isCodexModel(ctx)) {
			stop(ctx);
			return;
		}
		if (timer) return;
		generation += 1;
		const runGeneration = generation;
		timer = setInterval(() => {
			if (runGeneration !== generation) return;
			void refresh(ctx);
		}, config.pollIntervalMs);
		if (refreshImmediately) void refresh(ctx);
	}

	pi.registerCommand("usage", {
		description: "Refresh OpenAI Codex quota usage",
		handler: async (_args, ctx) => {
			config = resolveConfig(ctx.cwd, homedir(), ctx.isProjectTrusted());
			if (!isCodexModel(ctx)) {
				stop(ctx);
				ctx.ui.notify("Codex usage is shown only for the openai-codex provider.", "info");
				return;
			}
			start(ctx, false);
			await refresh(ctx, true);
			const status = cache ? formatUsageStatus(cache.usage) : undefined;
			ctx.ui.notify(
				status ? `Codex usage: ${status}` : `Codex usage unavailable${lastError ? ` (${lastError})` : ""}.`,
				status ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = resolveConfig(ctx.cwd, homedir(), ctx.isProjectTrusted());
		start(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		stop(ctx);
		config = resolveConfig(ctx.cwd, homedir(), ctx.isProjectTrusted());
		start(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
