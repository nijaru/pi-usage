import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import piUsage, { STATUS_KEY } from "../extensions/index.ts";

function tokenWithAccount(accountId: string): string {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

/** Build an isolated two-way switch: fns hold pending releases. */
function deferredResponse(): { resolve(response: Response): void; promise: Promise<Response> } {
	let release: (response: Response) => void = () => {};
	const promise = new Promise<Response>((resolve) => {
		release = resolve;
	});
	return { resolve: release, promise };
}

const usageBody = (primaryUsed: number, secondaryUsed: number) =>
	JSON.stringify({
		rate_limit: {
			primary_window: { used_percent: primaryUsed, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: secondaryUsed, limit_window_seconds: 604_800 },
		},
	});

interface Harness {
	root: string;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	commandHandler?: (args: string, ctx: unknown) => Promise<void>;
	fetches: string[];
	previousFetch: typeof fetch;
	cleanup(): void;
}

function installHarness(): Harness {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-lifecycle-"));
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const fetches: string[] = [];
	const previousFetch = globalThis.fetch;
	const harness: Harness = {
		root,
		handlers,
		commandHandler: undefined,
		fetches,
		previousFetch,
		cleanup() {
			globalThis.fetch = previousFetch;
			rmSync(root, { recursive: true, force: true });
		},
	};
	globalThis.fetch = (async (url: string | URL) => {
		fetches.push(String(url));
		return new Response(usageBody(18, 36), { status: 200 });
	}) as unknown as typeof fetch;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			harness.commandHandler = command.handler;
		},
	} as unknown as Parameters<typeof piUsage>[0];
	piUsage(pi);
	return harness;
}

function makeContext(root: string, model: { provider: string } | undefined, token: string) {
	const statuses: [string, string | undefined][] = [];
	return {
		root,
		cwd: root,
		model,
		hasUI: true,
		statuses,
		ui: {
			setStatus(key: string, text: string | undefined) {
				statuses.push([key, text]);
			},
			notifications: [] as string[],
			notify(message: string) {
				this.notifications.push(message);
			},
		},
		modelRegistry: {
			async getProviderAuth() {
				return { auth: { apiKey: token } };
			},
		},
		isProjectTrusted: () => true,
	} as any;
}

test("polls only for Codex and clears status when switching providers", async () => {
	const harness = installHarness();
	const token = tokenWithAccount("account-123");
	try {
		const codex = makeContext(harness.root, { provider: "openai-codex" }, token);
		await harness.handlers.get("session_start")?.({}, codex);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(codex.statuses).toContainEqual([STATUS_KEY, "5h 82% · wk 64%"]);
		expect(harness.fetches).toHaveLength(1);

		const other = makeContext(harness.root, { provider: "anthropic" }, token);
		await harness.handlers.get("model_select")?.({}, other);
		expect(other.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		await harness.handlers.get("session_shutdown")?.({}, other);

		const nonInteractive = makeContext(harness.root, { provider: "openai-codex" }, token);
		nonInteractive.hasUI = false;
		await harness.handlers.get("session_start")?.({}, nonInteractive);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.fetches).toHaveLength(1);
		// start() bails without UI and stop() explicitly clears the status slot.
		expect(nonInteractive.statuses).toEqual([[STATUS_KEY, undefined]]);
	} finally {
		harness.cleanup();
	}
});

test("timer-driven refresh updates the status between turns", async () => {
	const harness = installHarness();
	const token = tokenWithAccount("account-123");
	try {
		// Force a short poll interval through project config so the test does
		// not wait a full minute.
		mkdirSync(join(harness.root, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(harness.root, ".pi", "extensions", "pi-usage.json"), JSON.stringify({ pollIntervalMs: 1000 }));

		const codex = makeContext(harness.root, { provider: "openai-codex" }, token);
		await harness.handlers.get("session_start")?.({}, codex);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.fetches).toHaveLength(1);

		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(harness.fetches.length).toBeGreaterThanOrEqual(2);
		expect(codex.statuses.filter(([key]: [string, string | undefined]) => key === STATUS_KEY).length).toBeGreaterThanOrEqual(2);

		await harness.handlers.get("session_shutdown")?.({}, codex);
	} finally {
		harness.cleanup();
	}
});

test("respects enabled=false without fetching or showing status", async () => {
	const harness = installHarness();
	const token = tokenWithAccount("account-123");
	try {
		mkdirSync(join(harness.root, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(harness.root, ".pi", "extensions", "pi-usage.json"), JSON.stringify({ enabled: false }));

		const codex = makeContext(harness.root, { provider: "openai-codex" }, token);
		await harness.handlers.get("session_start")?.({}, codex);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.fetches).toEqual([]);
		// Disabled config clears the status slot instead of leaving it untouched.
		expect(codex.statuses).toEqual([[STATUS_KEY, undefined]]);

		await harness.handlers.get("session_shutdown")?.({}, codex);
	} finally {
		harness.cleanup();
	}
});

test("/usage reports only for the Codex provider", async () => {
	const harness = installHarness();
	const token = tokenWithAccount("account-123");
	try {
		const anthropic = makeContext(harness.root, { provider: "anthropic" }, token);
		await harness.commandHandler?.("", anthropic);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.fetches).toEqual([]);
		expect(anthropic.ui.notifications).toEqual([
			"Codex usage is shown only for the openai-codex provider.",
		]);

		const codex = makeContext(harness.root, { provider: "openai-codex" }, token);
		await harness.commandHandler?.("", codex);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.fetches).toHaveLength(1);
		expect(codex.ui.notifications).toEqual(["Codex usage: 5h 82% · wk 64%"]);

		await harness.handlers.get("session_shutdown")?.({}, codex);
	} finally {
		harness.cleanup();
	}
});

test("does not publish a completed request after the Codex account changes", async () => {
	const harness = installHarness();
	const accountA = tokenWithAccount("account-a");
	const accountB = tokenWithAccount("account-b");
	let currentToken = accountA;
	let pending = deferredResponse();
	globalThis.fetch = (async () => pending.promise) as unknown as typeof fetch;
	try {
		const ctx = makeContext(harness.root, { provider: "openai-codex" }, accountA);
		ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: currentToken } });
		await harness.handlers.get("session_start")?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));

		currentToken = accountB;
		pending.resolve(new Response(usageBody(10, 0), { status: 200 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ctx.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		await harness.handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		harness.cleanup();
	}
});
