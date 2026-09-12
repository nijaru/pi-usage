import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piUsage, { resolveConfig } from "../extensions/index.ts";

test("production entrypoint registers usage without model tools or request mutations", () => {
	const commands: string[] = [], hooks: string[] = [];
	piUsage({
		registerCommand(name: string) { commands.push(name); },
		on(name: string) { hooks.push(name); },
	} as unknown as Parameters<typeof piUsage>[0]);
	expect(commands).toEqual(["usage"]);
	expect(hooks).toEqual(["session_start", "model_select", "agent_settled", "session_shutdown"]);
});

test("management credential binding is global-only and survives unrelated project overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-usage-scope-"));
	try {
		const home = join(root, "home"), project = join(root, "project");
		const globalPath = join(home, ".pi/agent/extensions"), projectPath = join(project, ".pi/extensions");
		mkdirSync(globalPath, { recursive: true }); mkdirSync(projectPath, { recursive: true });
		const binding = { managementKeyEnv: "OR_MANAGEMENT", inferenceKeyEnv: "OR_INFERENCE" };
		writeFileSync(join(globalPath, "pi-usage.json"), JSON.stringify({ openrouterCredits: binding }));
		writeFileSync(join(projectPath, "pi-usage.json"), JSON.stringify({ pollIntervalMs: 2000, openrouterCredits: { managementKeyEnv: "WRONG", inferenceKeyEnv: "WRONG" } }));
		expect(resolveConfig(project, home).openrouterCredits).toEqual(binding);
		expect(resolveConfig(project, home).pollIntervalMs).toBe(2000);
		expect(resolveConfig(project, home, false).pollIntervalMs).toBe(60_000);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
