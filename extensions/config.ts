import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_BASENAME, DEFAULT_POLL_INTERVAL_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_POLL_INTERVAL_MS, MAX_REQUEST_TIMEOUT_MS, STATUS_KEY } from "./constants.ts";
import { DEFAULT_USAGE_URL } from "./usage.ts";
import type { CreditsBinding } from "./providers.ts";

export interface UsageConfigFile {
	enabled?: boolean; pollIntervalMs?: number; requestTimeoutMs?: number; usageUrl?: string;
	openrouterCredits?: CreditsBinding;
}
export interface ResolvedUsageConfig {
	enabled: boolean; pollIntervalMs: number; requestTimeoutMs: number; usageUrl: string;
	openrouterCredits?: CreditsBinding;
}
function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
	return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function configPaths(cwd: string, agentDir = getAgentDir()): { project: string; global: string } {
	// Honor PI_CODING_AGENT_DIR like the rest of Pi instead of assuming ~/.pi/agent.
	return { project: join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME), global: join(agentDir, "extensions", CONFIG_BASENAME) };
}
export function readConfig(path: string): UsageConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		if (statSync(path).size > 64 * 1024) throw new Error("Configuration exceeds 64 KiB");
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return {};
		const config: UsageConfigFile = {};
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		const pollIntervalMs = finiteNumber(parsed.pollIntervalMs), requestTimeoutMs = finiteNumber(parsed.requestTimeoutMs);
		if (pollIntervalMs !== undefined) config.pollIntervalMs = pollIntervalMs;
		if (requestTimeoutMs !== undefined) config.requestTimeoutMs = requestTimeoutMs;
		if (typeof parsed.usageUrl === "string" && parsed.usageUrl.trim()) config.usageUrl = parsed.usageUrl.trim();
		if (isRecord(parsed.openrouterCredits)) {
			const { managementKeyEnv, inferenceKeyEnv } = parsed.openrouterCredits;
			if (typeof managementKeyEnv !== "string" || typeof inferenceKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(managementKeyEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(inferenceKeyEnv)) throw new Error("Credits binding must contain environment-variable names, not credentials");
			config.openrouterCredits = { managementKeyEnv, inferenceKeyEnv };
		}
		return config;
	} catch {
		console.warn(`[${STATUS_KEY}] Invalid usage configuration; repair the file before relying on overrides`);
		return undefined;
	}
}
export function resolveConfig(cwd: string, agentDir = getAgentDir(), includeProject = true): ResolvedUsageConfig {
	const paths = configPaths(cwd, agentDir), globalConfig = readConfig(paths.global) ?? {};
	const projectConfig = includeProject ? readConfig(paths.project) ?? {} : {};
	const merged = { ...globalConfig, ...projectConfig };
	const pollIntervalMs = merged.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, requestTimeoutMs = merged.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	return {
		enabled: merged.enabled ?? true,
		pollIntervalMs: Number.isFinite(pollIntervalMs) ? Math.min(MAX_POLL_INTERVAL_MS, Math.max(1_000, Math.floor(pollIntervalMs))) : DEFAULT_POLL_INTERVAL_MS,
		requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1_000, Math.floor(requestTimeoutMs))) : DEFAULT_REQUEST_TIMEOUT_MS,
		usageUrl: merged.usageUrl ?? DEFAULT_USAGE_URL,
		// Projects cannot choose a management credential or associate it with an inference account.
		...(globalConfig.openrouterCredits ? { openrouterCredits: globalConfig.openrouterCredits } : {}),
	};
}
