import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function context(cwd: string, model: { provider: string } | undefined, token: string) {
	return {
		cwd,
		model,
		hasUI: true,
		ui: {
			statuses: [] as [string, string | undefined][],
			setStatus(key: string, text: string | undefined) {
				this.statuses.push([key, text]);
			},
			notify() {},
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
	const root = mkdtempSync(join(tmpdir(), "pi-usage-lifecycle-"));
	const previousFetch = globalThis.fetch;
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	const statuses: [string, string | undefined][] = [];
	let fetchCount = 0;
	let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const token = tokenWithAccount("account-123");
	try {
		globalThis.fetch = (async () => {
			fetchCount += 1;
			return new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: { used_percent: 18, limit_window_seconds: 18_000 },
						secondary_window: { used_percent: 36, limit_window_seconds: 604_800 },
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const pi = {
			on(event: string, handler: (event: unknown, ctx: any) => unknown) {
				handlers.set(event, handler);
			},
			registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commandHandler = command.handler;
			},
		} as any;
		piUsage(pi);

		const codex = context(root, { provider: "openai-codex" }, token);
		codex.ui.statuses = statuses;
		await handlers.get("session_start")?.({}, codex);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(statuses).toContainEqual([STATUS_KEY, "5h 82% · wk 64%"]);
		expect(fetchCount).toBe(1);
		await commandHandler?.("", codex);
		expect(fetchCount).toBe(2);

		const other = context(root, { provider: "anthropic" }, token);
		other.ui.statuses = statuses;
		await handlers.get("model_select")?.({}, other);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		await handlers.get("session_shutdown")?.({}, other);

		const nonInteractive = context(root, { provider: "openai-codex" }, token);
		nonInteractive.hasUI = false;
		nonInteractive.ui.statuses = statuses;
		await handlers.get("session_start")?.({}, nonInteractive);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchCount).toBe(2);
	} finally {
		globalThis.fetch = previousFetch;
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not publish a completed request after the Codex account changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-account-"));
	const previousFetch = globalThis.fetch;
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	const statuses: [string, string | undefined][] = [];
	const accountA = tokenWithAccount("account-a");
	const accountB = tokenWithAccount("account-b");
	let currentToken = accountA;
	let releaseResponse: ((response: Response) => void) | undefined;
	try {
		globalThis.fetch = (async () =>
			new Promise<Response>((resolve) => {
				releaseResponse = resolve;
			})) as unknown as typeof fetch;

		const pi = {
			on(event: string, handler: (event: unknown, ctx: any) => unknown) {
				handlers.set(event, handler);
			},
			registerCommand() {},
		} as any;
		piUsage(pi);

		const ctx = context(root, { provider: "openai-codex" }, accountA);
		ctx.ui.statuses = statuses;
		ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: currentToken } });
		await handlers.get("session_start")?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(releaseResponse).toBeDefined();

		currentToken = accountB;
		releaseResponse?.(
			new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
					},
				}),
				{ status: 200 },
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		globalThis.fetch = previousFetch;
		rmSync(root, { recursive: true, force: true });
	}
});
