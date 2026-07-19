import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { stateFile } from "../src/core/agent-paths.ts";
import { migrateAgentDirLayout, runMigrations } from "../src/migrations.ts";

describe("migrateAgentDirLayout", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-layout-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	it("moves a root-level trust.json into state/ and it resolves via the SSOT accessor", () => {
		const agentDir = createAgentDir();
		const rootTrustPath = path.join(agentDir, "trust.json");
		fs.writeFileSync(rootTrustPath, `${JSON.stringify({ "/some/project": true })}\n`, "utf-8");

		migrateAgentDirLayout(agentDir);

		expect(fs.existsSync(rootTrustPath)).toBe(false);
		const newPath = stateFile(agentDir, "trust.json");
		expect(fs.existsSync(newPath)).toBe(true);
		expect(JSON.parse(fs.readFileSync(newPath, "utf-8"))).toEqual({ "/some/project": true });
	});

	it("is idempotent: a second run after a successful move is a no-op", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(path.join(agentDir, "trust.json"), "{}\n", "utf-8");

		migrateAgentDirLayout(agentDir);
		const newPath = stateFile(agentDir, "trust.json");
		const afterFirstRun = fs.readFileSync(newPath, "utf-8");

		expect(() => migrateAgentDirLayout(agentDir)).not.toThrow();
		expect(fs.readFileSync(newPath, "utf-8")).toBe(afterFirstRun);
	});

	it("tolerates a partial prior run: never overwrites an existing target", () => {
		const agentDir = createAgentDir();
		// Simulate a half-completed earlier migration: both the old root file (stale/orphaned) and the
		// new state/ file (the one that should win) exist at once.
		fs.writeFileSync(path.join(agentDir, "trust.json"), `${JSON.stringify({ stale: true })}\n`, "utf-8");
		fs.mkdirSync(path.join(agentDir, "state"), { recursive: true });
		const canonicalPath = stateFile(agentDir, "trust.json");
		fs.writeFileSync(canonicalPath, `${JSON.stringify({ canonical: true })}\n`, "utf-8");

		migrateAgentDirLayout(agentDir);

		expect(JSON.parse(fs.readFileSync(canonicalPath, "utf-8"))).toEqual({ canonical: true });
	});

	it("never touches user config/resources", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(agentDir, "MEMORY.md"), "notes\n", "utf-8");
		fs.mkdirSync(path.join(agentDir, "skills", "my-skill"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "skills", "my-skill", "SKILL.md"), "# my skill\n", "utf-8");

		migrateAgentDirLayout(agentDir);

		expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(true);
		expect(fs.existsSync(path.join(agentDir, "MEMORY.md"))).toBe(true);
		expect(fs.existsSync(path.join(agentDir, "skills", "my-skill", "SKILL.md"))).toBe(true);
	});

	it("is a no-op on a tree that is already fully migrated", () => {
		const agentDir = createAgentDir();
		fs.mkdirSync(path.join(agentDir, "state"), { recursive: true });
		fs.writeFileSync(stateFile(agentDir, "trust.json"), `${JSON.stringify({ already: "migrated" })}\n`, "utf-8");

		expect(() => migrateAgentDirLayout(agentDir)).not.toThrow();
		expect(fs.existsSync(path.join(agentDir, "trust.json"))).toBe(false);
		expect(JSON.parse(fs.readFileSync(stateFile(agentDir, "trust.json"), "utf-8"))).toEqual({ already: "migrated" });
	});

	it("does not throw when nothing needs migrating (fresh agentDir)", () => {
		const agentDir = createAgentDir();
		expect(() => migrateAgentDirLayout(agentDir)).not.toThrow();
		expect(fs.existsSync(path.join(agentDir, "state"))).toBe(false);
	});
});

describe("runMigrations wires migrateAgentDirLayout in before any store read", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		delete process.env[ENV_AGENT_DIR];
	});

	it("relocates trust.json as part of the normal startup migration pass", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-layout-migration-runmigrations-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "trust.json"), `${JSON.stringify({ "/proj": true })}\n`, "utf-8");
		process.env[ENV_AGENT_DIR] = agentDir;

		expect(() => runMigrations(agentDir)).not.toThrow();

		expect(fs.existsSync(path.join(agentDir, "trust.json"))).toBe(false);
		expect(JSON.parse(fs.readFileSync(stateFile(agentDir, "trust.json"), "utf-8"))).toEqual({ "/proj": true });
	});
});

describe("agentDir layout migration ordering guard", () => {
	it("runs before the first trust-store read in the main.ts startup sequence", () => {
		// A scripted bootstrap can't easily drive main.ts's full CLI entrypoint (process.exit calls,
		// stdin takeover, …) in a unit test. Instead this asserts the ordering INVARIANT the
		// path-layout design proof depends on directly against the source: runMigrations() must
		// appear before the first construction of ProjectTrustStore (the first agentDir machine-file
		// reader). If a future refactor moves a store read above runMigrations, this fails loudly
		// instead of silently reintroducing the read-before-migrate window the design proof rules out.
		const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf-8");
		const runMigrationsIndex = mainSource.indexOf("runMigrations(");
		const trustStoreIndex = mainSource.indexOf("new ProjectTrustStore(");

		expect(runMigrationsIndex).toBeGreaterThan(-1);
		expect(trustStoreIndex).toBeGreaterThan(-1);
		expect(runMigrationsIndex).toBeLessThan(trustStoreIndex);
	});
});
