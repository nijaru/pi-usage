import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.ts";
import { registerUsage } from "./runtime.ts";

export * from "./config.ts";
export * from "./constants.ts";
export * from "./usage.ts";
export * from "./providers.ts";

export default function piUsage(pi: ExtensionAPI): void {
	registerUsage(pi, ctx => resolveConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()));
}
