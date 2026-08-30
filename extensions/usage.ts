import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS } from "./constants.ts";

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const USER_AGENT = "pi-usage";

type JsonRecord = Record<string, unknown>;

export interface UsageWindow {
	usedPercent: number;
	windowSeconds?: number;
	resetAt?: number;
}

export interface CodexUsage {
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	allowed?: boolean;
	limitReached?: boolean;
	planType?: string;
}

export interface FetchCodexUsageOptions {
	accessToken: string;
	accountId: string;
	usageUrl?: string;
	legacyUsageUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetcher?: FetchLike;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function parseResetAt(value: unknown): number | undefined {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) {
		// The current API uses Unix seconds. Accept milliseconds for older clients.
		return numeric > 100_000_000_000 ? numeric : numeric * 1000;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;

	const percentLeft = firstNumber(value, ["percent_left", "percentLeft"]);
	const usedPercent = firstNumber(value, ["used_percent", "usedPercent", "percent_used", "percentUsed"]);
	const rawUsedPercent = percentLeft !== undefined ? 100 - percentLeft : usedPercent;
	if (rawUsedPercent === undefined) return undefined;

	const windowSeconds = firstNumber(value, [
		"limit_window_seconds",
		"window_duration_seconds",
		"windowDurationSeconds",
	]);
	const durationMinutes = firstNumber(value, ["window_duration_mins", "windowDurationMins"]);
	const resetAt = parseResetAt(
		value.reset_at_unix ?? value.reset_time_ms ?? value.resetsAt ?? value.reset_at ?? value.resetAt,
	);

	return {
		usedPercent: Math.max(0, Math.min(100, rawUsedPercent)),
		windowSeconds: windowSeconds ?? (durationMinutes === undefined ? undefined : durationMinutes * 60),
		resetAt,
	};
}

function durationKind(seconds: number | undefined): "fiveHour" | "weekly" | undefined {
	if (seconds === undefined) return undefined;
	if (seconds >= 4 * 60 * 60 && seconds <= 6 * 60 * 60) return "fiveHour";
	if (seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60) return "weekly";
	return undefined;
}

interface WindowCandidate {
	value: UsageWindow;
	hint?: "fiveHour" | "weekly" | "primary" | "secondary";
}

function collectWindows(rateLimit: JsonRecord): WindowCandidate[] {
	const keys: readonly [string, WindowCandidate["hint"]][] = [
		["five_hour", "fiveHour"],
		["fiveHour", "fiveHour"],
		["weekly", "weekly"],
		["primary_window", "primary"],
		["primaryWindow", "primary"],
		["primary", "primary"],
		["secondary_window", "secondary"],
		["secondaryWindow", "secondary"],
		["secondary", "secondary"],
	];
	const candidates: WindowCandidate[] = [];
	const seen = new Set<unknown>();
	for (const [key, hint] of keys) {
		const raw = rateLimit[key];
		if (seen.has(raw)) continue;
		const value = parseWindow(raw);
		if (!value) continue;
		seen.add(raw);
		candidates.push({ value, hint });
	}
	return candidates;
}

function selectWindow(
	candidates: readonly WindowCandidate[],
	kind: "fiveHour" | "weekly",
	selected?: UsageWindow,
): UsageWindow | undefined {
	const byDuration = candidates.find(
		(candidate) => candidate.value !== selected && durationKind(candidate.value.windowSeconds) === kind,
	);
	if (byDuration) return byDuration.value;

	const byName = candidates.find(
		(candidate) =>
			candidate.value !== selected &&
			candidate.hint === kind &&
			(durationKind(candidate.value.windowSeconds) === undefined || durationKind(candidate.value.windowSeconds) === kind),
	);
	if (byName) return byName.value;

	const legacyName = kind === "fiveHour" ? "primary" : "secondary";
	const byLegacyName = candidates.find(
		(candidate) =>
			candidate.value !== selected &&
			candidate.hint === legacyName &&
			(durationKind(candidate.value.windowSeconds) === undefined || durationKind(candidate.value.windowSeconds) === kind),
	);
	if (byLegacyName) return byLegacyName.value;

	return undefined;
}

function rateLimitObject(payload: JsonRecord): JsonRecord | undefined {
	const direct = payload.rate_limit ?? payload.rate_limits ?? payload.rateLimit ?? payload.rateLimits;
	if (isRecord(direct)) return direct;
	if (Array.isArray(direct)) {
		const preferred = direct.find((entry) => isRecord(entry) && entry.limit_id === "codex");
		return isRecord(preferred) ? preferred : isRecord(direct[0]) ? direct[0] : undefined;
	}
	return undefined;
}

/** Parse the private Codex usage response without exposing account identifiers or tokens. */
export function parseCodexUsage(payload: unknown): CodexUsage {
	if (!isRecord(payload)) throw new Error("Codex usage response was not an object");
	const rateLimit = rateLimitObject(payload);
	if (!rateLimit) throw new Error("Codex usage response has no rate-limit data");

	const candidates = collectWindows(rateLimit);
	const fiveHour = selectWindow(candidates, "fiveHour");
	const weekly = selectWindow(candidates, "weekly", fiveHour);
	if (!fiveHour && !weekly) throw new Error("Codex usage response has no usable windows");

	return {
		fiveHour,
		weekly,
		allowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined,
		limitReached: typeof rateLimit.limit_reached === "boolean"
			? rateLimit.limit_reached
			: typeof rateLimit.limitReached === "boolean"
				? rateLimit.limitReached
				: undefined,
		planType: typeof payload.plan_type === "string"
			? payload.plan_type
			: typeof payload.planType === "string"
				? payload.planType
				: undefined,
	};
}

export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

/** Format the compact value intended for Pi's normal footer/status bar. */
export function formatUsageStatus(usage: Pick<CodexUsage, "fiveHour" | "weekly">): string {
	const parts: string[] = [];
	if (usage.fiveHour) parts.push(`5h ${remainingPercent(usage.fiveHour)}%`);
	if (usage.weekly) parts.push(`wk ${remainingPercent(usage.weekly)}%`);
	return parts.join(" · ");
}

/** Extract the account id from the current Pi/OpenAI Codex OAuth access token. */
export function accountIdFromAccessToken(accessToken: string): string | undefined {
	try {
		const payload = accessToken.split(".")[1];
		if (!payload) return undefined;
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const claims = JSON.parse(atob(normalized)) as unknown;
		if (!isRecord(claims)) return undefined;
		const auth = claims["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") return undefined;
		return auth.chatgpt_account_id || undefined;
	} catch {
		return undefined;
	}
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const abort = () => controller.abort();
	if (parent?.aborted) controller.abort();
	else parent?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		cancel() {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", abort);
		},
	};
}

function fallbackUsageUrl(url: string): string | undefined {
	if (url.endsWith("/wham/usage")) return `${url.slice(0, -"/wham/usage".length)}/codex/usage`;
	return undefined;
}

/** Fetch and parse usage, falling back to the older endpoint only on a missing route. */
export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<CodexUsage> {
	if (!options.accessToken) throw new Error("Codex usage requires an access token");
	if (!options.accountId) throw new Error("Codex usage requires an account id");

	const usageUrl = options.usageUrl ?? DEFAULT_USAGE_URL;
	const legacyUrl = options.legacyUsageUrl ?? fallbackUsageUrl(usageUrl);
	for (const url of [usageUrl, legacyUrl]) {
		if (!url) continue;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("Codex usage URL is invalid");
		}
		if (parsed.protocol !== "https:") throw new Error("Codex usage URL must use HTTPS");
	}
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.timeoutMs as number)))
		: DEFAULT_REQUEST_TIMEOUT_MS;
	const urls = [...new Set([usageUrl, legacyUrl].filter((url): url is string => Boolean(url)))];
	const fetcher = options.fetcher ?? globalThis.fetch;
	if (!fetcher) throw new Error("Fetch is unavailable");

	let lastStatus: number | undefined;
	for (const [index, url] of urls.entries()) {
		const linked = linkedSignal(options.signal, timeoutMs);
		try {
			const response = await fetcher(url, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${options.accessToken}`,
					"ChatGPT-Account-Id": options.accountId,
					Origin: "https://chatgpt.com",
					Referer: "https://chatgpt.com/",
					"User-Agent": USER_AGENT,
				},
				redirect: "error",
				signal: linked.signal,
			});
			lastStatus = response.status;
			if ((response.status === 404 || response.status === 405) && index < urls.length - 1) continue;
			if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);
			return parseCodexUsage(await response.json());
		} finally {
			linked.cancel();
		}
	}
	throw new Error(`Codex usage request failed (${lastStatus ?? "unknown status"})`);
}
