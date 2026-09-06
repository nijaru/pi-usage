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

	// reset_at is Unix seconds; accept milliseconds in case the field changes.
	const resetAtUnix = finiteNumber(value.reset_at);
	const resetAt = resetAtUnix === undefined ? undefined : resetAtUnix * 1000;

	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		windowSeconds: finiteNumber(value.limit_window_seconds),
		resetAt,
	};
}

function durationKind(seconds: number | undefined): "fiveHour" | "weekly" | undefined {
	if (seconds === undefined) return undefined;
	if (seconds >= 4 * 60 * 60 && seconds <= 6 * 60 * 60) return "fiveHour";
	if (seconds >= 6 * 24 * 60 * 60 && seconds <= 8 * 24 * 60 * 60) return "weekly";
	return undefined;
}

/**
 * Select a window from the primary/secondary pair. Duration is the ground
 * truth; the primary/secondary naming is only a hint, so a primary window
 * with weekly duration is reported as weekly. A window already used for the
 * other label is excluded, so conflicting metadata never double-labels one
 * window.
 */
function selectWindow(
	primary: UsageWindow | undefined,
	secondary: UsageWindow | undefined,
	kind: "fiveHour" | "weekly",
	taken?: UsageWindow,
): UsageWindow | undefined {
	const candidates = [
		{ value: primary, hint: "primary" as const },
		{ value: secondary, hint: "secondary" as const },
	];
	for (const candidate of candidates) {
		if (candidate.value && candidate.value !== taken && durationKind(candidate.value.windowSeconds) === kind) {
			return candidate.value;
		}
	}
	// A window can serve only one label: when both durations claim the same
	// kind, the second window is dropped rather than labeled on a guess.
	const untimed = candidates.filter((candidate) => candidate.value && durationKind(candidate.value.windowSeconds) === undefined);
	if (kind === "fiveHour" && primary) return primary;
	if (kind === "weekly" && secondary && untimed.length > 0) return secondary;
	return undefined;
}

/** Parse the private Codex usage response without exposing account identifiers or tokens. */
export function parseCodexUsage(payload: unknown): CodexUsage {
	if (!isRecord(payload)) throw new Error("Codex usage response was not an object");
	const rateLimit = payload.rate_limit;
	if (!isRecord(rateLimit)) throw new Error("Codex usage response has no rate-limit data");

	const primary = parseWindow(rateLimit.primary_window);
	const secondary = parseWindow(rateLimit.secondary_window);
	const fiveHour = selectWindow(primary, secondary, "fiveHour");
	const weekly = selectWindow(primary, secondary, "weekly", fiveHour);
	if (!fiveHour && !weekly) throw new Error("Codex usage response has no usable windows");

	return { fiveHour, weekly };
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

/** Format the compact value intended for Pi's normal footer/status bar. */
export function formatUsageStatus(
	usage: Pick<CodexUsage, "fiveHour" | "weekly">,
	now = Date.now(),
): string {
	const parts: string[] = [];
	// A weekly-exhausted quota blocks requests regardless of the five-hour
	// bucket's contents, so its remaining percent is not actionable and is
	// hidden rather than shown next to a blocking 0%.
	const weeklyBlocked = usage.weekly !== undefined && remainingPercent(usage.weekly) === 0;
	if (usage.fiveHour && !weeklyBlocked) parts.push(formatWindowStatus("5h", usage.fiveHour, now));
	if (usage.weekly) parts.push(formatWindowStatus("wk", usage.weekly, now));
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
