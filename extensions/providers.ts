/** Read-only provider balances. Endpoint contracts and scope are documented in README.md. */
import { createHash } from "node:crypto";

export interface ProviderModel { provider: string; id: string; baseUrl: string; }
export interface ResolvedAuth {
	ok: boolean; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string;
}
export interface Identity {
	provider: string; model: ProviderModel; token: string; fingerprint: string;
}
export interface Amount { currency: string; value: string; label: string; }
export interface ProviderReport {
	provider: string;
	kind: "balance" | "key-limit" | "quota";
	amounts: Amount[];
	lines: string[];
	available?: boolean;
	capturedAt: number;
}
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ORIGINS: Record<string, string[]> = {
	deepseek: ["https://api.deepseek.com"],
	openrouter: ["https://openrouter.ai"],
	moonshotai: ["https://api.moonshot.ai"],
	"moonshotai-cn": ["https://api.moonshot.cn"],
	minimax: ["https://api.minimax.io"],
	"minimax-cn": ["https://api.minimaxi.com"],
	"vercel-ai-gateway": ["https://ai-gateway.vercel.sh"],
};
export const BALANCE_PROVIDERS = Object.freeze(Object.keys(ORIGINS));
export const isBalanceProvider = (provider: string) => Object.hasOwn(ORIGINS, provider);
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function decimal(value: unknown): string | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		const text = String(value);
		if (!/[eE]/.test(text)) return text;
		const [mantissa, exponent] = text.toLowerCase().split("e");
		const negative = mantissa.startsWith("-");
		const unsigned = mantissa.replace(/^-/, "");
		const digits = unsigned.replace(".", "");
		const point = (unsigned.split(".")[0].length) + Number(exponent);
		const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
		return expanded.length <= 96 ? `${negative ? "-" : ""}${expanded}` : undefined;
	}
	return typeof value === "string" && value.length <= 96 && /^-?\d+(?:\.\d+)?$/.test(value) ? value : undefined;
}
/** Exact decimal subtraction; do not round account balances through binary floats. */
export function subtract(a: string, b: string): string {
	if (!decimal(a) || !decimal(b)) throw new Error("Invalid decimal amount");
	const places = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
	const units = (value: string) => {
		const sign = value.startsWith("-") ? -1n : 1n;
		const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
		return sign * BigInt(whole + fraction.padEnd(places, "0"));
	};
	const result = units(a) - units(b);
	const digits = (result < 0n ? -result : result).toString().padStart(places + 1, "0");
	return `${result < 0n ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
export function officialIdentity(model: ProviderModel, auth: ResolvedAuth): Identity {
	const origins = ORIGINS[model.provider];
	if (!origins || !auth.ok) throw new Error("Provider authentication unavailable");
	for (const value of [model.baseUrl, auth.baseUrl ?? model.baseUrl]) {
		let url: URL;
		try { url = new URL(value); } catch { throw new Error("Invalid provider endpoint"); }
		if (url.username || url.password || !origins.includes(url.origin)) {
			throw new Error("Usage requires this provider's official endpoint; proxy credentials are not forwarded");
		}
	}
	const authorization = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization");
	const token = authorization
		? (typeof authorization[1] === "string" ? /^Bearer\s+(.+)$/i.exec(authorization[1])?.[1] : undefined)
		: auth.apiKey;
	if (!token || /[\r\n]/.test(token)) throw new Error("Provider bearer credential unavailable");
	return { provider: model.provider, model, token, fingerprint: fingerprint(`${model.provider}\0${auth.baseUrl ?? model.baseUrl}\0${token}`) };
}

export async function getJson(
	url: string, token: string, signal: AbortSignal, fetcher: Fetcher = globalThis.fetch,
): Promise<unknown> {
	signal.throwIfAborted();
	const response = await fetcher(url, {
		method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		redirect: "error", signal,
	});
	if (!response.ok) throw new Error(`Usage request failed (${response.status})`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty usage response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 1024 * 1024) throw new Error("Usage response exceeds 1 MiB");
			chunks.push(value);
		}
		signal.throwIfAborted();
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		try { return JSON.parse(new TextDecoder().decode(bytes)); }
		catch { throw new Error("Invalid usage JSON"); }
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

const report = (provider: string, kind: ProviderReport["kind"] = "balance"): ProviderReport =>
	({ provider, kind, amounts: [], lines: [], capturedAt: Date.now() });
function add(target: ProviderReport, label: string, currency: string, raw: unknown): void {
	const value = decimal(raw);
	if (value === undefined) throw new Error(`Missing or invalid ${label}`);
	target.amounts.push({ label, currency, value });
}
function requireObject(payload: unknown): Record<string, unknown> {
	if (!object(payload)) throw new Error("Usage response is not an object");
	return payload;
}
export function parseDeepSeek(payload: unknown): ProviderReport {
	const data = requireObject(payload);
	if (typeof data.is_available !== "boolean" || !Array.isArray(data.balance_infos)) throw new Error("Invalid DeepSeek balance");
	const result = report("deepseek");
	result.available = data.is_available;
	const currencies = new Set<string>();
	for (const row of data.balance_infos) {
		if (!object(row) || (row.currency !== "USD" && row.currency !== "CNY") || currencies.has(row.currency)) throw new Error("Invalid DeepSeek currency record");
		currencies.add(row.currency);
		add(result, "balance", row.currency, row.total_balance);
		for (const [label, field] of [["granted", "granted_balance"], ["topped up", "topped_up_balance"]]) {
			const value = decimal(row[field]);
			if (value !== undefined) result.lines.push(`${row.currency} ${label}: ${value}`);
		}
	}
	if (!result.amounts.length) throw new Error("DeepSeek returned no balances");
	if (!result.available) result.lines.push("API currently unavailable for this balance");
	return result;
}
export function parseOpenRouter(payload: unknown): ProviderReport {
	const root = requireObject(payload);
	const data = requireObject(root.data);
	const result = report("openrouter", "key-limit");
	if (data.limit === null) result.lines.push("No per-key cap; account balance is separate");
	else if (decimal(data.limit) !== undefined) {
		result.lines.push(`USD key cap: ${decimal(data.limit)}`);
		if (decimal(data.limit_remaining) !== undefined) add(result, "key cap left", "USD", data.limit_remaining);
	} else result.lines.push("Per-key cap unavailable");
	for (const [label, field] of [["spent", "usage"], ["today", "usage_daily"], ["this week", "usage_weekly"], ["this month", "usage_monthly"]]) {
		const value = decimal(data[field]);
		if (value !== undefined) result.lines.push(`USD ${label}: ${value}`);
	}
	if (!result.amounts.length && !["usage", "usage_daily", "usage_weekly", "usage_monthly"].some(key => decimal(data[key]) !== undefined) && data.limit !== null) throw new Error("OpenRouter returned no usage data");
	return result;
}
export function addOpenRouterCredits(result: ProviderReport, payload: unknown): ProviderReport {
	const data = requireObject(requireObject(payload).data);
	const purchased = decimal(data.total_credits), used = decimal(data.total_usage);
	if (purchased === undefined || used === undefined) throw new Error("Invalid OpenRouter account credits");
	return { ...result, kind: "balance", amounts: [{ label: "account credit", currency: "USD", value: subtract(purchased, used) }, ...result.amounts] };
}
export function parseMoonshot(provider: string, payload: unknown): ProviderReport {
	const root = requireObject(payload);
	if (root.code !== 0 && root.code !== undefined) throw new Error("Moonshot balance unavailable");
	const data = requireObject(root.data);
	const result = report(provider);
	const currency = provider.endsWith("-cn") ? "CNY" : "USD";
	add(result, "balance", currency, data.available_balance);
	for (const [label, field] of [["cash", "cash_balance"], ["voucher", "voucher_balance"]]) {
		const value = decimal(data[field]);
		if (value !== undefined) result.lines.push(`${currency} ${label}: ${value}`);
	}
	return result;
}
export function parseVercel(payload: unknown): ProviderReport {
	const data = requireObject(payload);
	const result = report("vercel-ai-gateway");
	add(result, "credit", "USD", data.balance);
	if (decimal(data.total_used) !== undefined) result.lines.push(`USD total used: ${decimal(data.total_used)}`);
	return result;
}

export function parseMiniMax(provider: string, payload: unknown, balance: boolean): ProviderReport {
	const data = requireObject(payload);
	const base = requireObject(data.base_resp);
	if (base.status_code !== 0) throw new Error("MiniMax usage request was not successful");
	const result = report(provider, balance ? "balance" : "quota");
	if (balance) {
		const currency = provider.endsWith("-cn") ? "CNY" : "USD";
		add(result, "balance", currency, data.available_amount);
		for (const key of ["cash_balance", "voucher_balance", "credit_balance", "owed_amount"]) {
			const value = decimal(data[key]);
			if (value !== undefined) result.lines.push(`${currency} ${key}: ${value}`);
		}
		return result;
	}
	if (!Array.isArray(data.model_remains) || !data.model_remains.length) throw new Error("MiniMax returned no quota rows");
	for (const row of data.model_remains) {
		if (!object(row)) throw new Error("Invalid MiniMax quota row");
		const name = typeof row.model_name === "string" ? row.model_name.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80) : "model";
		for (const [label, key] of [["rolling", "current_interval_remaining_percent"], ["weekly", "current_weekly_remaining_percent"]]) {
			const value = decimal(row[key]);
			if (value === undefined || Number(value) < 0 || Number(value) > 100) continue;
			result.lines.push(`${name} ${label}: ${value}% left`);
		}
	}
	// Older usage_count fields changed meanings. Do not guess a remaining value.
	if (!result.lines.length) throw new Error("MiniMax quota response has no unambiguous remaining percentages");
	return result;
}

export interface CreditsBinding {
	/** Global user config binds a management key to one inference key by environment names. */
	managementKeyEnv: string;
	inferenceKeyEnv: string;
}
export function resolveCreditsKey(identity: Identity, binding: CreditsBinding | undefined, env = process.env): string | undefined {
	if (!binding || identity.provider !== "openrouter") return undefined;
	const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
	if (!validName.test(binding.managementKeyEnv) || !validName.test(binding.inferenceKeyEnv)) throw new Error("Invalid credits credential environment name");
	if (!env[binding.managementKeyEnv]) return undefined;
	if (env[binding.inferenceKeyEnv] !== identity.token) throw new Error("OpenRouter credits binding does not match the selected inference key");
	return env[binding.managementKeyEnv];
}
export async function fetchBalance(
	identity: Identity, signal: AbortSignal, fetcher?: Fetcher, creditsKey?: string,
): Promise<ProviderReport> {
	const { provider, token } = identity;
	const origin = ORIGINS[provider]?.[0];
	if (!origin) throw new Error("Unsupported balance provider");
	if (provider === "deepseek") return parseDeepSeek(await getJson(`${origin}/user/balance`, token, signal, fetcher));
	if (provider === "openrouter") {
		const result = parseOpenRouter(await getJson(`${origin}/api/v1/key`, token, signal, fetcher));
		if (creditsKey) {
			try { return addOpenRouterCredits(result, await getJson(`${origin}/api/v1/credits`, creditsKey, signal, fetcher)); }
			catch (error) {
				signal.throwIfAborted();
				result.lines.push(`Account credit unavailable (${error instanceof Error ? error.message : "request failed"}); key data remains valid`);
			}
		} else result.lines.push("Account credit requires a bound management key in global pi-usage.json");
		return result;
	}
	if (provider.startsWith("moonshotai")) return parseMoonshot(provider, await getJson(`${origin}/v1/users/me/balance`, token, signal, fetcher));
	if (provider === "vercel-ai-gateway") return parseVercel(await getJson(`${origin}/v1/credits`, token, signal, fetcher));
	if (provider.startsWith("minimax")) {
		const balance = token.startsWith("sk-api-");
		const payload = await getJson(`${origin}${balance ? "/account/query_balance" : "/v1/token_plan/remains"}`, token, signal, fetcher);
		return parseMiniMax(provider, payload, balance);
	}
	throw new Error("No verified balance parser for this credential type");
}
export function formatBalanceStatus(result: ProviderReport): string {
	const amounts = result.amounts.map(({ currency, value, label }) => `${currency} ${value}${label === "key cap left" ? " key cap left" : ""}`);
	const content = amounts.join(" · ") || (result.kind === "key-limit" ? "key spend only" : result.kind === "quota" ? result.lines.join(" · ") : "balance unavailable");
	return `${result.provider} ${content}${result.available === false ? " · API unavailable" : ""}`;
}
export function formatBalanceReport(result: ProviderReport): string {
	return [formatBalanceStatus(result), ...result.lines, `As of ${new Date(result.capturedAt).toISOString()}`].join("\n");
}
