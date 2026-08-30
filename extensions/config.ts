import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_BASENAME,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	MAX_POLL_INTERVAL_MS,
	MAX_REQUEST_TIMEOUT_MS,
	STATUS_KEY,
} from "./constants.ts";
import { DEFAULT_USAGE_URL } from "./usage.ts";

export interface UsageConfigFile {
	enabled?: boolean;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
	usageUrl?: string;
}

export interface ResolvedUsageConfig {
	enabled: boolean;
	pollIntervalMs: number;
	requestTimeoutMs: number;
	usageUrl: string;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPaths(cwd: string, home = homedir()): { project: string; global: string } {
	return {
		project: join(cwd, CONFIG_DIR_NAME, "extensions", CONFIG_BASENAME),
		global: join(home, CONFIG_DIR_NAME, "agent", "extensions", CONFIG_BASENAME),
	};
}

export function readConfig(path: string): UsageConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return {};
		const config: UsageConfigFile = {};
		if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
		const pollIntervalMs = finiteNumber(parsed.pollIntervalMs);
		if (pollIntervalMs !== undefined) config.pollIntervalMs = pollIntervalMs;
		const requestTimeoutMs = finiteNumber(parsed.requestTimeoutMs);
		if (requestTimeoutMs !== undefined) config.requestTimeoutMs = requestTimeoutMs;
		if (typeof parsed.usageUrl === "string" && parsed.usageUrl.trim()) config.usageUrl = parsed.usageUrl.trim();
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to read ${path}: ${message}`);
		return undefined;
	}
}

export function resolveConfig(cwd: string, home = homedir(), includeProject = true): ResolvedUsageConfig {
	const paths = configPaths(cwd, home);
	const globalConfig = readConfig(paths.global) ?? {};
	const projectConfig = includeProject ? readConfig(paths.project) ?? {} : {};
	const merged = { ...globalConfig, ...projectConfig };
	const pollIntervalMs = merged.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const requestTimeoutMs = merged.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	return {
		enabled: merged.enabled ?? true,
		pollIntervalMs: Number.isFinite(pollIntervalMs)
			? Math.min(MAX_POLL_INTERVAL_MS, Math.max(1_000, Math.floor(pollIntervalMs)))
			: DEFAULT_POLL_INTERVAL_MS,
		requestTimeoutMs: Number.isFinite(requestTimeoutMs)
			? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1_000, Math.floor(requestTimeoutMs)))
			: DEFAULT_REQUEST_TIMEOUT_MS,
		usageUrl: merged.usageUrl ?? DEFAULT_USAGE_URL,
	};
}
