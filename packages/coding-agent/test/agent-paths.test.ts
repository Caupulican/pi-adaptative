import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cacheDir,
	cacheFile,
	configFile,
	getProcessWorkRun,
	getWorkRoot,
	gitDir,
	modelsDir,
	npmDir,
	reloadCoordinationDir,
	resourceDir,
	runtimesDir,
	sessionsDir,
	stateDir,
	stateFile,
} from "../src/core/agent-paths.ts";
import { getReloadCoordinationDir } from "../src/core/reload-blockers.ts";
import { getWorkRoot as workDirectoryGetWorkRoot } from "../src/utils/work-directory.ts";

const AGENT_DIR = "/agent";

describe("agent-paths SSOT accessors", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("configFile builds a root-level user config/memory path", () => {
		expect(configFile(AGENT_DIR, "auth.json")).toBe(join(AGENT_DIR, "auth.json"));
		expect(configFile(AGENT_DIR, "MEMORY.md")).toBe(join(AGENT_DIR, "MEMORY.md"));
	});

	it("stateDir/stateFile build canonical state/ paths", () => {
		expect(stateDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state"));
		expect(stateFile(AGENT_DIR, "trust.json")).toBe(join(AGENT_DIR, "state", "trust.json"));
		expect(stateFile(AGENT_DIR, "model-adaptation.json")).toBe(join(AGENT_DIR, "state", "model-adaptation.json"));
	});

	it("cacheDir/cacheFile build canonical cache/ paths", () => {
		expect(cacheDir(AGENT_DIR)).toBe(join(AGENT_DIR, "cache"));
		expect(cacheFile(AGENT_DIR, "tool-paths.json")).toBe(join(AGENT_DIR, "cache", "tool-paths.json"));
		expect(cacheFile(AGENT_DIR, "uv")).toBe(join(AGENT_DIR, "cache", "uv"));
	});

	it("runtimesDir/modelsDir are keyed by kind under runtimes//models/", () => {
		expect(runtimesDir("ollama", AGENT_DIR)).toBe(join(AGENT_DIR, "runtimes", "ollama"));
		expect(runtimesDir("prism-llamacpp", AGENT_DIR)).toBe(join(AGENT_DIR, "runtimes", "prism-llamacpp"));
		expect(modelsDir("ollama", AGENT_DIR)).toBe(join(AGENT_DIR, "models", "ollama"));
		expect(modelsDir("needle", AGENT_DIR)).toBe(join(AGENT_DIR, "models", "needle"));
	});

	it("sessionsDir/npmDir/gitDir build the established infra directories (kept, not moved)", () => {
		expect(sessionsDir(AGENT_DIR)).toBe(join(AGENT_DIR, "sessions"));
		expect(npmDir(AGENT_DIR)).toBe(join(AGENT_DIR, "npm"));
		expect(gitDir(AGENT_DIR)).toBe(join(AGENT_DIR, "git"));
	});

	it("resourceDir builds each user-resource directory at the agentDir root", () => {
		for (const kind of ["skills", "prompts", "themes", "extensions", "profiles"] as const) {
			expect(resourceDir(kind, AGENT_DIR)).toBe(join(AGENT_DIR, kind));
		}
	});

	it("work/ accessors delegate to work-directory.ts rather than reimplementing it", () => {
		expect(getWorkRoot).toBe(workDirectoryGetWorkRoot);
		expect(getWorkRoot(AGENT_DIR)).toBe(join(AGENT_DIR, "work"));
		expect(typeof getProcessWorkRun).toBe("function");
	});

	it("reloadCoordinationDir re-exports reload-blockers.ts's already-correct, work-scoped implementation", () => {
		expect(reloadCoordinationDir).toBe(getReloadCoordinationDir);
		// getReloadCoordinationDir performs real I/O (acquires a work-run lease), so it needs a real,
		// writable agentDir rather than the fake "/agent" the pure builders above use.
		const realAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-paths-test-"));
		tempDirs.push(realAgentDir);
		expect(reloadCoordinationDir(realAgentDir)).toBe(
			join(getWorkRoot(realAgentDir), "coordination", "reload", "state"),
		);
	});
});
