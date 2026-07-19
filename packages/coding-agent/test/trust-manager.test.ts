import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasProjectTrustInputs, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions per cwd", () => {
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		store.set(cwd, true);
		expect(store.get(cwd)).toBe(true);
		store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
		store.set(cwd, null);
		expect(store.get(cwd)).toBeNull();
	});

	it("readOnly:true reads lock-free without ever creating the state dir/lockfile, and set() is a no-op (D4)", () => {
		const trustPath = join(agentDir, "state", "trust.json");
		const store = new ProjectTrustStore(agentDir, { readOnly: true });

		expect(store.get(cwd)).toBeNull();
		// A lock-free get() must never create the state dir just from reading -- the non-readOnly
		// path's own lock acquisition creates it (mkdirSync on the trust dir), which is exactly the
		// footprint a worker session must avoid.
		expect(existsSync(join(agentDir, "state"))).toBe(false);
		expect(existsSync(`${trustPath}.lock`)).toBe(false);

		store.set(cwd, true);
		expect(store.get(cwd)).toBeNull(); // set() was a no-op: still untrusted
		expect(existsSync(trustPath)).toBe(false);

		// readOnly:false (the default outside a worker session) is unaffected.
		const writableStore = new ProjectTrustStore(agentDir);
		writableStore.set(cwd, true);
		expect(writableStore.get(cwd)).toBe(true);
		expect(existsSync(trustPath)).toBe(true);
	});

	it("leaves malformed trust stores untouched instead of crashing startup reads", () => {
		// trust.json is machine-persisted state, so ProjectTrustStore resolves it under state/,
		// not the agentDir root.
		const trustPath = join(agentDir, "state", "trust.json");
		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(trustPath, "{not json", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		expect(() => store.set(cwd, true)).not.toThrow();
		expect(readFileSync(trustPath, "utf-8")).toBe("{not json");
	});

	it("detects project trust inputs", () => {
		expect(hasProjectTrustInputs(cwd)).toBe(false);

		mkdirSync(join(cwd, ".pi"), { recursive: true });
		expect(hasProjectTrustInputs(cwd)).toBe(true);
		rmSync(join(cwd, ".pi"), { recursive: true, force: true });

		writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
		expect(hasProjectTrustInputs(cwd)).toBe(true);
		rmSync(join(cwd, "AGENTS.md"), { force: true });

		writeFileSync(join(cwd, "GEMINI.md"), "Project instructions");
		expect(hasProjectTrustInputs(cwd)).toBe(true);
		rmSync(join(cwd, "GEMINI.md"), { force: true });

		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});
});
