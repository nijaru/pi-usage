import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS } from "./constants.ts";

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const USER_AGENT = "pi-usage";

export interface UsageWindow {
	usedPercent: number;
	windowSeconds?: number;
	resetAt?: number;
}

export interface CodexUsage {
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	otherWindows?: UsageWindow[];
}

export interface FetchCodexUsageOptions {
	accessToken: string;
	accountId: string;
	usageUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetcher?: FetchLike;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

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

/**
 * Parse a rate-limit window. The endpoint is undocumented and volatile, so
 * malformed or missing windows are skipped rather than rejected: one usable
 * window still produces a status.
 */
function parseWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;

	const usedPercent = finiteNumber(value.used_percent);
	if (usedPercent === undefined) return undefined;

	const rawWindowSeconds = finiteNumber(value.limit_window_seconds);
	const windowSeconds = rawWindowSeconds !== undefined && rawWindowSeconds > 0 ? rawWindowSeconds : undefined;
	// reset_at is currently Unix seconds. Treat values already in the normal
	// millisecond epoch range as milliseconds if the endpoint changes units.
	const rawResetAt = finiteNumber(value.reset_at);
	const resetAt = rawResetAt === undefined ? undefined : Math.abs(rawResetAt) >= 100_000_000_000 ? rawResetAt : rawResetAt * 1000;

	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowSeconds,
		resetAt,
	};
}

function durationKind(seconds: number | undefined): "fiveHour" | "weekly" | undefined {
	if (seconds === 5 * 60 * 60) return "fiveHour";
	if (seconds === 7 * 24 * 60 * 60) return "weekly";
	return undefined;
}

/**
 * Classify each backend slot from its duration, never from primary/secondary
 * position. The endpoint has moved a weekly-only quota into primary_window,
 * and other account types may expose different durations. Unknown durations
 * remain available for an honest generic/duration label instead of becoming
 * a made-up five-hour quota.
 */
function classifyWindows(primary: UsageWindow | undefined, secondary: UsageWindow | undefined): CodexUsage {
	const usage: CodexUsage = {};
	const otherWindows: UsageWindow[] = [];
	const seenOtherDurations = new Set<number | "unknown">();

	for (const window of [primary, secondary]) {
		if (!window) continue;
		const kind = durationKind(window.windowSeconds);
		if (kind) {
			// Conflicting metadata can present the same duration in both slots.
			// One user-facing label must correspond to at most one window.
			if (!usage[kind]) usage[kind] = window;
			continue;
		}

		const durationKey = window.windowSeconds ?? "unknown";
		if (seenOtherDurations.has(durationKey)) continue;
		seenOtherDurations.add(durationKey);
		otherWindows.push(window);
	}

	if (otherWindows.length > 0) usage.otherWindows = otherWindows;
	return usage;
}

/** Parse the private Codex usage response without exposing account identifiers or tokens. */
export function parseCodexUsage(payload: unknown): CodexUsage {
	if (!isRecord(payload)) throw new Error("Codex usage response was not an object");
	const rateLimit = payload.rate_limit;
	if (!isRecord(rateLimit)) throw new Error("Codex usage response has no rate-limit data");

	const usage = classifyWindows(parseWindow(rateLimit.primary_window), parseWindow(rateLimit.secondary_window));
	if (!usage.fiveHour && !usage.weekly && !usage.otherWindows?.length) {
		throw new Error("Codex usage response has no usable windows");
	}
	return usage;
}

export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

function formatResetCountdown(resetAt: number | undefined, now: number): string | undefined {
	if (resetAt === undefined || !Number.isFinite(resetAt)) return undefined;
	const totalMinutes = Math.ceil(Math.max(0, resetAt - now) / 60_000);
	if (totalMinutes === 0) return "now";

	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	return `${minutes}m`;
}

function formatWindowStatus(label: string, window: UsageWindow, now: number): string {
	const reset = formatResetCountdown(window.resetAt, now);
	return `${label} ${remainingPercent(window)}%${reset ? ` ↻${reset}` : ""}`;
}

function genericWindowLabel(windowSeconds: number | undefined): string {
	if (windowSeconds === undefined || !Number.isInteger(windowSeconds) || windowSeconds <= 0) return "quota";
	const day = 24 * 60 * 60;
	if (windowSeconds % day === 0) return `${windowSeconds / day}d`;
	if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`;
	if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
	return "quota";
}

/** Format the compact value intended for Pi's normal footer/status bar. */
export function formatUsageStatus(
	usage: Pick<CodexUsage, "fiveHour" | "weekly" | "otherWindows">,
	now = Date.now(),
): string {
	const weeklyBlocked = usage.weekly !== undefined && remainingPercent(usage.weekly) === 0;
	const windows: Array<{ label: string; window: UsageWindow }> = [];
	// A weekly-exhausted quota blocks requests regardless of shorter buckets,
	// so their remaining percentages are not actionable until weekly resets.
	if (usage.fiveHour && !weeklyBlocked) windows.push({ label: "5h", window: usage.fiveHour });
	if (!weeklyBlocked) {
		for (const window of usage.otherWindows ?? []) {
			windows.push({ label: genericWindowLabel(window.windowSeconds), window });
		}
	}
	if (usage.weekly) windows.push({ label: "wk", window: usage.weekly });

	windows.sort((left, right) => (left.window.windowSeconds ?? Number.POSITIVE_INFINITY) - (right.window.windowSeconds ?? Number.POSITIVE_INFINITY));
	return windows.map(({ label, window }) => formatWindowStatus(label, window, now)).join(" · ");
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

/** Fetch and parse the usage endpoint. */
export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<CodexUsage> {
	if (!options.accessToken) throw new Error("Codex usage requires an access token");
	if (!options.accountId) throw new Error("Codex usage requires an account id");

	const usageUrl = options.usageUrl ?? DEFAULT_USAGE_URL;
	let parsed: URL;
	try {
		parsed = new URL(usageUrl);
	} catch {
		throw new Error("Codex usage URL is invalid");
	}
	if (parsed.protocol !== "https:") throw new Error("Codex usage URL must use HTTPS");
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.max(1, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.timeoutMs as number)))
		: DEFAULT_REQUEST_TIMEOUT_MS;
	const fetcher = options.fetcher ?? globalThis.fetch;
	if (!fetcher) throw new Error("Fetch is unavailable");

	const linked = linkedSignal(options.signal, timeoutMs);
	try {
		const response = await fetcher(usageUrl, {
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
		if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);
		return parseCodexUsage(await response.json());
	} finally {
		linked.cancel();
	}
}
