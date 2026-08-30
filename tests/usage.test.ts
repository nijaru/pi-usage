import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	CONFIG_BASENAME,
	DEFAULT_USAGE_URL,
	accountIdFromAccessToken,
	configPaths,
	fetchCodexUsage,
	formatUsageStatus,
	parseCodexUsage,
	readConfig,
	resolveConfig,
} from "../extensions/index.ts";

const usageResponse = (primary: unknown, secondary: unknown) => ({
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: primary,
		secondary_window: secondary,
	},
});

function tokenWithAccount(accountId: string): string {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

describe("parseCodexUsage", () => {
	test("parses current five-hour and weekly windows", () => {
		const usage = parseCodexUsage(
			usageResponse(
				{ used_percent: 18, limit_window_seconds: 18_000, reset_at: 1_735_689_720 },
				{ used_percent: 36, limit_window_seconds: 604_800, reset_at: 1_736_000_000 },
			),
		);

		expect(usage.fiveHour?.usedPercent).toBe(18);
		expect(usage.weekly?.usedPercent).toBe(36);
		expect(formatUsageStatus(usage, 1_735_683_600_000)).toBe("5h 82% ↻1h42m · wk 64% ↻3d15h");
	});

	test("uses window duration instead of assuming primary is five-hour", () => {
		const usage = parseCodexUsage(
			usageResponse(
				{ used_percent: 25, limit_window_seconds: 604_800 },
				{ used_percent: 10, limit_window_seconds: 18_000 },
			),
		);

		expect(formatUsageStatus(usage)).toBe("5h 90% · wk 75%");
	});

	test("supports camel-case and percent-left aliases", () => {
		const usage = parseCodexUsage({
			rate_limits: {
				primary: { percent_left: 91, windowDurationMins: 300 },
				secondary: { percentLeft: 73, windowDurationMins: 10_080, resetsAt: "2030-01-02T03:04:05Z" },
			},
		});

		expect(formatUsageStatus(usage, Date.parse("2030-01-01T00:00:00Z"))).toBe("5h 91% · wk 73% ↻1d3h");
		expect(usage.weekly?.resetAt).toBe(Date.parse("2030-01-02T03:04:05Z"));
	});

	test("accepts one available window", () => {
		const usage = parseCodexUsage(usageResponse(null, { used_percent: 50, limit_window_seconds: 604_800 }));
		expect(usage.fiveHour).toBeUndefined();
		expect(formatUsageStatus(usage)).toBe("wk 50%");
	});

	test("does not use one window for both labels when metadata conflicts", () => {
		const usage = parseCodexUsage(
			usageResponse(
				{ used_percent: 10, limit_window_seconds: 18_000 },
				{ used_percent: 10, limit_window_seconds: 18_000 },
			),
		);
		expect(formatUsageStatus(usage)).toBe("5h 90%");
	});

	test("rejects responses without usable rate-limit windows", () => {
		expect(() => parseCodexUsage({})).toThrow("no rate-limit data");
		expect(() => parseCodexUsage(usageResponse(null, null))).toThrow("no usable windows");
	});

	test("formats reset countdowns next to each window", () => {
		const now = Date.parse("2030-01-01T00:00:00Z");
		expect(
			formatUsageStatus(
				{
					fiveHour: { usedPercent: 18, resetAt: now + (1 * 60 + 42) * 60_000 },
					weekly: { usedPercent: 36, resetAt: now + (3 * 24 + 6) * 60 * 60_000 },
				},
				now,
			),
		).toBe("5h 82% ↻1h42m · wk 64% ↻3d6h");
	});

	test("clamps remaining percentages to the display range", () => {
		expect(formatUsageStatus({ fiveHour: { usedPercent: -10 } })).toBe("5h 100%");
		expect(formatUsageStatus({ weekly: { usedPercent: 110 } })).toBe("wk 0%");
	});
});

describe("accountIdFromAccessToken", () => {
	test("extracts the Pi/OpenAI OAuth claim", () => {
		expect(accountIdFromAccessToken(tokenWithAccount("account-123"))).toBe("account-123");
	});

	test("does not throw for malformed or non-Codex tokens", () => {
		expect(accountIdFromAccessToken("not-a-jwt")).toBeUndefined();
		expect(accountIdFromAccessToken(tokenWithAccount(""))).toBeUndefined();
	});
});

describe("fetchCodexUsage", () => {
	const token = "access-token-that-must-not-appear-in-errors";
	const accountId = "account-123";
	const response = usageResponse({ used_percent: 12, limit_window_seconds: 18_000 }, null);

	test("uses bearer and account headers", async () => {
		let requestedUrl: string | URL | undefined;
		let requestedInit: RequestInit | undefined;
		const usage = await fetchCodexUsage({
			accessToken: token,
			accountId,
			fetcher: async (url, init) => {
				requestedUrl = url;
				requestedInit = init;
				return new Response(JSON.stringify(response), { status: 200 });
			},
		});

		expect(requestedUrl).toBe(DEFAULT_USAGE_URL);
		expect(new Headers(requestedInit?.headers).get("Authorization")).toBe(`Bearer ${token}`);
		expect(new Headers(requestedInit?.headers).get("ChatGPT-Account-Id")).toBe(accountId);
		expect(new Headers(requestedInit?.headers).get("Accept")).toBe("application/json");
		expect(usage.fiveHour?.usedPercent).toBe(12);
	});

	test("falls back to the older route only for a missing current route", async () => {
		const urls: string[] = [];
		const usage = await fetchCodexUsage({
			accessToken: token,
			accountId,
			fetcher: async (url) => {
				urls.push(String(url));
				if (urls.length === 1) return new Response("missing", { status: 404 });
				return new Response(JSON.stringify(response), { status: 200 });
			},
		});

		expect(urls).toEqual([
			DEFAULT_USAGE_URL,
			"https://chatgpt.com/backend-api/codex/usage",
		]);
		expect(usage.fiveHour?.usedPercent).toBe(12);
	});

	test("rejects insecure configured endpoints before sending credentials", async () => {
		await expect(
			fetchCodexUsage({
				accessToken: token,
				accountId,
				usageUrl: "http://localhost:1234/usage",
				fetcher: async () => {
					throw new Error("fetch should not be called");
				},
			}),
		).rejects.toThrow("must use HTTPS");
	});

	test("does not include credentials in request errors", async () => {
		await expect(
			fetchCodexUsage({
				accessToken: token,
				accountId,
				fetcher: async () => new Response("server body", { status: 500 }),
			}),
		).rejects.toThrow("Codex usage request failed (500)");
		try {
			await fetchCodexUsage({
				accessToken: token,
				accountId,
				fetcher: async () => new Response("server body", { status: 500 }),
			});
		} catch (error) {
			expect(String(error)).not.toContain(token);
			expect(String(error)).not.toContain(accountId);
		}
	});
});

describe("configuration", () => {
	test("merges project config over global config", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
		const home = join(root, "home");
		try {
			const paths = configPaths(root, home);
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			writeFileSync(paths.global, JSON.stringify({ pollIntervalMs: 30_000, requestTimeoutMs: 2_000 }));
			writeFileSync(paths.project, JSON.stringify({ enabled: false, pollIntervalMs: 90_000 }));

			expect(resolveConfig(root, home)).toEqual({
				enabled: false,
				pollIntervalMs: 90_000,
				requestTimeoutMs: 2_000,
				usageUrl: DEFAULT_USAGE_URL,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("clamps unsafe timer values", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
		try {
			const path = join(root, ".pi", "extensions", CONFIG_BASENAME);
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			writeFileSync(path, JSON.stringify({ pollIntervalMs: 1e20, requestTimeoutMs: 1e20 }));
			expect(resolveConfig(root, join(root, "home")).pollIntervalMs).toBe(86_400_000);
			expect(resolveConfig(root, join(root, "home")).requestTimeoutMs).toBe(120_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ignores malformed config", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
		try {
			const path = join(root, CONFIG_BASENAME);
			writeFileSync(path, "not json");
			expect(readConfig(path)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
