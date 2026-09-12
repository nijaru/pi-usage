/** Read-only provider balances, quota, and rated spend. Endpoint contracts are documented in README.md. */
import { createHash } from "node:crypto";

export interface ProviderModel { provider: string; id: string; baseUrl: string; }
export interface ResolvedAuth {
	ok: boolean; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string;
}
export interface Identity {
	provider: string; model: ProviderModel; token: string; fingerprint: string; origin?: string;
}
export interface Amount { currency: string; value: string; label: string; }
export interface ProviderReport {
	provider: string;
	kind: "balance" | "key-limit" | "quota" | "spend";
	amounts: Amount[];
	lines: string[];
	status?: string;
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
	"kimi-coding": ["https://api.kimi.com"],
	"opencode-go": ["https://opencode.ai"],
	zai: ["https://api.z.ai"],
	"zai-coding-cn": ["https://open.bigmodel.cn"],
	baseten: ["https://inference.baseten.co", "https://api.baseten.co"],
	fireworks: ["https://api.fireworks.ai"],
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
		const point = unsigned.split(".")[0].length + Number(exponent);
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

function effectiveOrigin(model: ProviderModel, auth: ResolvedAuth): string {
	let modelUrl: URL, authUrl: URL;
	try {
		modelUrl = new URL(model.baseUrl);
		authUrl = new URL(auth.baseUrl ?? model.baseUrl);
	} catch { throw new Error("Invalid provider endpoint"); }
	const origins = ORIGINS[model.provider];
	if (!origins || modelUrl.username || modelUrl.password || authUrl.username || authUrl.password || !origins.includes(modelUrl.origin) || !origins.includes(authUrl.origin)) {
		throw new Error("Usage requires this provider's official endpoint; proxy credentials are not forwarded");
	}
	if (modelUrl.origin !== authUrl.origin && !(model.provider === "baseten" && origins.includes(modelUrl.origin) && origins.includes(authUrl.origin))) {
		throw new Error("Usage auth origin does not match the selected provider origin");
	}
	return authUrl.origin;
}

export function officialIdentity(model: ProviderModel, auth: ResolvedAuth): Identity {
	if (!auth.ok) throw new Error("Provider authentication unavailable");
	const origin = effectiveOrigin(model, auth);
	const authorization = Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization");
	const token = authorization
		? (typeof authorization[1] === "string" ? /^Bearer\s+(.+)$/i.exec(authorization[1])?.[1] : undefined)
		: auth.apiKey;
	if (!token || /[\r\n]/.test(token)) throw new Error("Provider bearer credential unavailable");
	return { provider: model.provider, model, token, origin, fingerprint: fingerprint(`${model.provider}\0${origin}\0${token}`) };
}

async function getJsonHeaders(
	url: string, headers: Record<string, string>, signal: AbortSignal, fetcher: Fetcher = globalThis.fetch,
): Promise<unknown> {
	signal.throwIfAborted();
	const response = await fetcher(url, { method: "GET", headers: { ...headers, Accept: "application/json" }, redirect: "error", signal });
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

export async function getJson(
	url: string, token: string, signal: AbortSignal, fetcher: Fetcher = globalThis.fetch,
): Promise<unknown> {
	return getJsonHeaders(url, { Authorization: `Bearer ${token}` }, signal, fetcher);
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
function cleanLabel(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80) : fallback;
}
function percent(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined;
}
function resetText(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
	if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
	return undefined;
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
	const data = requireObject(requireObject(payload).data);
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
		const name = cleanLabel(row.model_name, "model");
		for (const [label, key] of [["rolling", "current_interval_remaining_percent"], ["weekly", "current_weekly_remaining_percent"]]) {
			const value = percent(row[key]);
			if (value === undefined) continue;
			result.lines.push(`${name} ${label}: ${value}% left`);
		}
	}
	if (!result.lines.length) throw new Error("MiniMax quota response has no unambiguous remaining percentages");
	result.status = `${provider} ${result.lines.slice(0, 2).map(line => line.replace(/^.*?: /, "")).join(" · ")}`;
	return result;
}

function fixedPointMajor(value: unknown): string | undefined {
	const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
	if (!text) return undefined;
	const raw = BigInt(text);
	const divisor = 100_000_000n;
	const whole = raw / divisor;
	const fraction = (raw % divisor).toString().padStart(8, "0").replace(/0+$/, "");
	return `${whole}${fraction ? `.${fraction}` : ""}`;
}
function windowMinutes(value: unknown): number | undefined {
	if (!object(value)) return undefined;
	const duration = Number(value.duration);
	if (!Number.isSafeInteger(duration) || duration <= 0) return undefined;
	const factor = value.timeUnit === "TIME_UNIT_MINUTE" ? 1 : value.timeUnit === "TIME_UNIT_HOUR" ? 60 : value.timeUnit === "TIME_UNIT_DAY" ? 1440 : value.timeUnit === "TIME_UNIT_WEEK" ? 10080 : undefined;
	return factor ? duration * factor : undefined;
}
function shortWindow(minutes: number): string {
	if (minutes === 10080) return "wk";
	if (minutes % 10080 === 0) return `${minutes / 10080}w`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

export function parseKimi(payload: unknown): ProviderReport {
	const root = requireObject(payload);
	const result = report("kimi-coding", "quota");
	const buckets: Array<{ minutes: number; remaining: number; reset?: string; label: string }> = [];
	const addRow = (raw: unknown, minutes: number, label: string) => {
		if (!object(raw)) return;
		const used = Number(raw.used), limit = Number(raw.limit);
		if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) return;
		const remaining = Math.max(0, 100 - (used / limit) * 100);
		buckets.push({ minutes, remaining, reset: resetText(raw.resetTime), label });
	};
	addRow(root.usage, 10080, "weekly");
	if (Array.isArray(root.limits)) {
		for (const raw of root.limits) {
			if (!object(raw)) continue;
			const minutes = windowMinutes(raw.window);
			if (minutes) addRow(raw.detail, minutes, cleanLabel(raw.name, shortWindow(minutes)));
		}
	}
	const byWindow = new Map<number, typeof buckets[number]>();
	const duplicate = new Set<number>();
	for (const bucket of buckets) {
		if (byWindow.has(bucket.minutes)) duplicate.add(bucket.minutes);
		else byWindow.set(bucket.minutes, bucket);
	}
	for (const minutes of duplicate) byWindow.delete(minutes);
	const windows = [...byWindow.values()].sort((a,b)=>a.minutes-b.minutes);
	for (const bucket of windows) result.lines.push(`${bucket.label}: ${bucket.remaining.toFixed(0)}% left${bucket.reset ? ` · resets ${bucket.reset}` : ""}`);
	if (object(root.boosterWallet) && object(root.boosterWallet.balance) && root.boosterWallet.balance.type === "BOOSTER") {
		const currency = object(root.boosterWallet.monthlyUsed) && typeof root.boosterWallet.monthlyUsed.currency === "string"
			? root.boosterWallet.monthlyUsed.currency.toUpperCase() : object(root.boosterWallet.monthlyChargeLimit) && typeof root.boosterWallet.monthlyChargeLimit.currency === "string" ? root.boosterWallet.monthlyChargeLimit.currency.toUpperCase() : undefined;
		const left = fixedPointMajor(root.boosterWallet.balance.amountLeft);
		if (currency && /^[A-Z]{3}$/.test(currency) && left !== undefined) result.amounts.push({ label: "booster balance", currency, value: left });
	}
	if (!windows.length && !result.amounts.length) throw new Error("Kimi Coding returned no displayable usage data");
	result.status = `kimi ${windows.slice(0,2).map(bucket => `${bucket.remaining.toFixed(0)}% ${shortWindow(bucket.minutes)}`).join(" · ") || result.amounts.map(a=>`${a.currency} ${a.value}`).join(" · ")}`;
	return result;
}

export function parseOpenCode(payload: unknown): ProviderReport {
	const root = requireObject(payload), usage = requireObject(root.usage);
	const result = report("opencode-go", "quota");
	const parts: string[] = [];
	for (const [key, label] of [["rolling","rolling"],["weekly","weekly"],["monthly","monthly"]] as const) {
		if (!object(usage[key])) continue;
		const state = usage[key];
		if (state.status !== "ok" && state.status !== "rate-limited") continue;
		const used = percent(state.percent);
		if (used === undefined) continue;
		const left = Math.max(0, 100 - used);
		parts.push(`${left.toFixed(0)}% ${label}`);
		result.lines.push(`${label}: ${left.toFixed(0)}% left${resetText(state.resetsAt) ? ` · resets ${resetText(state.resetsAt)}` : ""}`);
	}
	if (!parts.length) throw new Error("OpenCode Go returned no displayable usage data");
	result.status = `opencode ${parts.slice(0,2).join(" · ")}`;
	return result;
}

export function parseZai(provider: string, payload: unknown): ProviderReport {
	const root = requireObject(payload);
	const code = root.code;
	if (code !== undefined && code !== 0 && code !== "0" && code !== 200 && code !== "200") {
		if (String(code) === "1113") throw new Error("Z.AI balance or resource package unavailable");
		if (String(code) === "1309") throw new Error("Z.AI GLM Coding Plan expired");
		throw new Error(`Z.AI usage API failed (${String(code).slice(0,16)})`);
	}
	const data = requireObject(root.data);
	if (!Array.isArray(data.limits)) throw new Error("Z.AI returned no quota limits");
	const result = report(provider, "quota"), parts: string[] = [];
	for (const raw of data.limits) {
		if (!object(raw)) continue;
		const unit = Number(raw.unit), type = raw.type;
		if (type === "TIME_LIMIT") {
			const used = Number(raw.currentValue), limit = Number(raw.usage);
			if (Number.isFinite(used) && Number.isFinite(limit) && limit >= 0) result.lines.push(`MCP monthly: ${Math.max(0, limit-used)}/${limit} left`);
			continue;
		}
		if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
		if (unit === 3) {
			const used = percent(raw.percentage); if (used === undefined) continue;
			const hours = Number(raw.number), label = Number.isFinite(hours) && hours > 0 ? `${hours}h` : "5h";
			const left = Math.max(0, 100-used); parts.push(`${left.toFixed(0)}% ${label}`); result.lines.push(`${label}: ${left.toFixed(0)}% left${resetText(raw.nextResetTime) ? ` · resets ${resetText(raw.nextResetTime)}` : ""}`);
		} else if (unit === 6) {
			const usedCount = Number(raw.currentValue), limitCount = Number(raw.usage);
			if (Number.isFinite(usedCount) && Number.isFinite(limitCount) && limitCount > 0) {
				const left = Math.max(0, 100 - (usedCount/limitCount)*100); parts.push(`${left.toFixed(0)}% wk`); result.lines.push(`weekly: ${Math.max(0,limitCount-usedCount)}/${limitCount} left`);
			} else {
				const used = percent(raw.percentage); if (used === undefined) continue;
				const left = Math.max(0,100-used); parts.push(`${left.toFixed(0)}% wk`); result.lines.push(`weekly: ${left.toFixed(0)}% left`);
			}
		}
	}
	if (!parts.length && !result.lines.length) throw new Error("Z.AI returned no displayable quota data");
	if (typeof data.level === "string" && data.level.trim()) result.lines.push(`Plan: ${cleanLabel(data.level,"plan")}`);
	result.status = `${provider === "zai" ? "zai" : "zai-cn"} ${parts.slice(0,2).join(" · ")}`;
	return result;
}

export function parseBaseten(payload: unknown): ProviderReport {
	const root = requireObject(payload), result = report("baseten", "spend");
	if (root.model_apis_usage == null) { result.status = "baseten USD 0 net"; result.lines.push("No Model APIs usage in the last 30 days"); return result; }
	const usage = requireObject(root.model_apis_usage);
	for (const [label,key] of [["gross usage","total"],["credits used","credits_used"],["net subtotal","subtotal"]] as const) {
		const value = decimal(usage[key]); if (value === undefined || Number(value) < 0) throw new Error(`Invalid Baseten ${label}`);
		result.lines.push(`USD ${label}: ${value}`);
		if (key === "subtotal") result.amounts.push({ label: "net spend", currency: "USD", value });
	}
	result.status = `baseten USD ${result.amounts[0].value} net`;
	return result;
}

export function parseFireworksAccounts(payload: unknown): string[] {
	const root = requireObject(payload);
	if (!Array.isArray(root.accounts)) throw new Error("Fireworks accounts response missing accounts");
	const ids = root.accounts.map(raw => {
		if (!object(raw) || typeof raw.name !== "string") throw new Error("Invalid Fireworks account row");
		const match = /^accounts\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/.exec(raw.name);
		if (!match) throw new Error("Unsafe Fireworks account resource name");
		return match[1];
	});
	if (new Set(ids).size !== ids.length) throw new Error("Duplicate Fireworks account");
	return ids;
}
function fireworksMoney(value: unknown): { currency: string; nanos: bigint } {
	const money = requireObject(value), currency = money.currencyCode;
	if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid Fireworks currency");
	const parseInt64 = (v: unknown) => v === undefined ? 0n : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : typeof v === "string" && /^-?\d+$/.test(v) && v.length <= 20 ? BigInt(v) : (()=>{throw new Error("Invalid Fireworks money integer")})();
	const units = parseInt64(money.units), nanos = parseInt64(money.nanos);
	if (nanos <= -1_000_000_000n || nanos >= 1_000_000_000n || (units > 0n && nanos < 0n) || (units < 0n && nanos > 0n)) throw new Error("Invalid Fireworks money range");
	return { currency, nanos: units*1_000_000_000n+nanos };
}
function formatNanos(value: bigint): string {
	const negative = value < 0n, n = negative ? -value : value, whole = n/1_000_000_000n, frac=(n%1_000_000_000n).toString().padStart(9,"0").replace(/0+$/,"");
	return `${negative?"-":""}${whole}${frac?`.${frac}`:""}`;
}
export function parseFireworksBilling(payload: unknown): ProviderReport {
	const root = requireObject(payload), result = report("fireworks", "spend"), totals = new Map<string,bigint>();
	if (root.lineItems !== undefined && !Array.isArray(root.lineItems)) throw new Error("Invalid Fireworks lineItems");
	const lineItems = Array.isArray(root.lineItems) ? root.lineItems : [];
	for (const raw of lineItems) {
		if (!object(raw)) throw new Error("Invalid Fireworks line item");
		const money = fireworksMoney(raw.totalCost); totals.set(money.currency,(totals.get(money.currency)??0n)+money.nanos);
	}
	for (const [currency,nanos] of totals) result.amounts.push({ label:"30d rated spend", currency, value: formatNanos(nanos) });
	if (!result.amounts.length) result.lines.push("No rated line items in the last 30 days");
	result.lines.push("Rated spend may differ from the final invoice after credits or adjustments");
	result.status = `fireworks ${result.amounts.map(a=>`${a.currency} ${a.value}`).join(" · ") || "no 30d spend"}`;
	return result;
}

export interface CreditsBinding {
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

function identityOrigin(identity: Identity): string {
	return identity.origin ?? new URL(identity.model.baseUrl).origin;
}
function basetenUrl(now = Date.now()): string {
	const url = new URL("https://api.baseten.co/v1/billing/usage_summary");
	url.searchParams.set("start_date", new Date(now-30*24*60*60*1000).toISOString());
	url.searchParams.set("end_date", new Date(now).toISOString());
	return url.toString();
}
function fireworksBillingUrl(account: string, now = Date.now()): string {
	const day=24*60*60*1000, floor=(t:number)=>`${new Date(t).toISOString().slice(0,10)}T00:00:00Z`;
	const url=new URL(`/v1/accounts/${account}/billing/summary`,`https://api.fireworks.ai`);
	url.searchParams.set("startTime",floor(now-29*day)); url.searchParams.set("endTime",floor(now+day)); return url.toString();
}

export async function fetchBalance(
	identity: Identity, signal: AbortSignal, fetcher?: Fetcher, creditsKey?: string,
): Promise<ProviderReport> {
	const { provider, token } = identity;
	const origin = identityOrigin(identity);
	if (!ORIGINS[provider]) throw new Error("Unsupported balance provider");
	if (provider === "deepseek") return parseDeepSeek(await getJson("https://api.deepseek.com/user/balance", token, signal, fetcher));
	if (provider === "openrouter") {
		const result = parseOpenRouter(await getJson("https://openrouter.ai/api/v1/key", token, signal, fetcher));
		if (creditsKey) {
			try { return addOpenRouterCredits(result, await getJson("https://openrouter.ai/api/v1/credits", creditsKey, signal, fetcher)); }
			catch (error) { signal.throwIfAborted(); result.lines.push(`Account credit unavailable (${error instanceof Error ? error.message : "request failed"}); key data remains valid`); }
		} else result.lines.push("Account credit requires a bound management key in global pi-usage.json");
		return result;
	}
	if (provider.startsWith("moonshotai")) return parseMoonshot(provider, await getJson(`${origin}/v1/users/me/balance`, token, signal, fetcher));
	if (provider === "vercel-ai-gateway") return parseVercel(await getJson("https://ai-gateway.vercel.sh/v1/credits", token, signal, fetcher));
	if (provider.startsWith("minimax")) {
		const balance = token.startsWith("sk-api-");
		return parseMiniMax(provider, await getJson(`${origin}${balance ? "/account/query_balance" : "/v1/token_plan/remains"}`, token, signal, fetcher), balance);
	}
	if (provider === "kimi-coding") return parseKimi(await getJson("https://api.kimi.com/coding/v1/usages", token, signal, fetcher));
	if (provider === "opencode-go") return parseOpenCode(await getJson("https://opencode.ai/zen/go/v1/usage", token, signal, fetcher));
	if (provider === "zai" || provider === "zai-coding-cn") {
		return parseZai(provider, await getJsonHeaders(`${origin}/api/monitor/usage/quota/limit`, { Authorization: token }, signal, fetcher));
	}
	if (provider === "baseten") return parseBaseten(await getJson(basetenUrl(), token, signal, fetcher));
	if (provider === "fireworks") {
		const accounts = parseFireworksAccounts(await getJson("https://api.fireworks.ai/v1/accounts?pageSize=200", token, signal, fetcher));
		if (accounts.length === 0) throw new Error("Fireworks returned no visible billing accounts");
		if (accounts.length > 1) throw new Error("Fireworks account selection required; multiple billing accounts are visible");
		return parseFireworksBilling(await getJson(fireworksBillingUrl(accounts[0]), token, signal, fetcher));
	}
	throw new Error("No verified reporting parser for this credential type");
}

export function formatBalanceStatus(result: ProviderReport): string {
	if (result.status) return `${result.status}${result.available === false ? " · API unavailable" : ""}`;
	const amounts = result.amounts.map(({ currency, value, label }) => `${currency} ${value}${label === "key cap left" ? " key cap left" : ""}`);
	const content = amounts.join(" · ") || (result.kind === "key-limit" ? "key spend only" : result.kind === "quota" ? result.lines.join(" · ") : result.kind === "spend" ? "spend unavailable" : "balance unavailable");
	return `${result.provider} ${content}${result.available === false ? " · API unavailable" : ""}`;
}
export function formatBalanceReport(result: ProviderReport): string {
	return [formatBalanceStatus(result), ...result.lines, `As of ${new Date(result.capturedAt).toISOString()}`].join("\n");
}
