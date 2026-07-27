import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cacheDir,
	cacheFile,
	configBackupsDir,
	configFile,
	directoryProfilesDir,
	getProcessWorkRun,
	getWorkRoot,
	gitDir,
	managedSecretEnvDir,
	modelsDir,
	npmDir,
	okfMemoryDir,
	orchestrationEventStoreDir,
	orchestrationSessionDir,
	orchestrationSessionsDir,
	reloadCoordinationDir,
	resourceDir,
	runtimesDir,
	secretsDir,
	secretVaultFile,
	sessionsDir,
	stateDir,
	stateFile,
	workerActionJournalFile,
	workerAgentMailboxFile,
	workerConversationSessionsDir,
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

	it("authored memory and durable profile/backup collections have canonical containers", () => {
		expect(okfMemoryDir(AGENT_DIR)).toBe(join(AGENT_DIR, "okf-memory"));
		expect(directoryProfilesDir(AGENT_DIR)).toBe(join(AGENT_DIR, "profiles", "directories"));
		expect(configBackupsDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state", "backups", "config"));
	});

	it("stateDir/stateFile build canonical state/ paths", () => {
		expect(stateDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state"));
		expect(stateFile(AGENT_DIR, "trust.json")).toBe(join(AGENT_DIR, "state", "trust.json"));
		expect(stateFile(AGENT_DIR, "model-adaptation.json")).toBe(join(AGENT_DIR, "state", "model-adaptation.json"));
	});

	it("keeps encrypted and materialized secret state under one bounded state container", () => {
		expect(secretsDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state", "secrets"));
		expect(secretVaultFile(AGENT_DIR)).toBe(join(AGENT_DIR, "state", "secrets", "vault.json"));
		expect(managedSecretEnvDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state", "secrets", "materialized"));
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

	it("keeps every foreground-session orchestration artifact beneath one canonical bundle", () => {
		const sessionId = "parent-session-1";
		const root = orchestrationSessionDir(AGENT_DIR, sessionId);
		expect(orchestrationSessionsDir(AGENT_DIR)).toBe(join(AGENT_DIR, "state", "orchestration", "sessions"));
		expect(root.startsWith(join(AGENT_DIR, "state", "orchestration", "sessions"))).toBe(true);
		expect(root).toMatch(/parent-session-1-[a-f0-9]{16}$/);
		expect(orchestrationEventStoreDir(AGENT_DIR, sessionId)).toBe(join(root, "events"));
		expect(workerConversationSessionsDir(AGENT_DIR, sessionId)).toBe(join(root, "worker-conversations"));
		expect(workerAgentMailboxFile(AGENT_DIR, sessionId, "a".repeat(64))).toBe(
			join(root, "worker-mailboxes", `${"a".repeat(64)}.json`),
		);
		expect(workerActionJournalFile(AGENT_DIR, sessionId, "b".repeat(64))).toBe(
			join(root, "worker-actions", `${"b".repeat(64)}.json`),
		);
	});

	it("builds portable collision-resistant bundle names for imported session ids", () => {
		const hostile = orchestrationSessionDir(AGENT_DIR, "CON*team/worker:one?");
		const neighbor = orchestrationSessionDir(AGENT_DIR, "CON_team/worker:one?");
		const hostileName = basename(hostile);
		expect(hostileName).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
		expect(hostile).not.toBe(neighbor);
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
