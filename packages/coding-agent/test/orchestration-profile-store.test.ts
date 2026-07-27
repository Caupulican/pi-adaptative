import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";

const now = "2026-07-23T12:00:00.000Z";

function profile(profileId: string, modelId: string): OrchestrationProfile {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId,
		description: `${profileId} profile`,
		role: "operator",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "test", modelId, thinkingLevel: "minimal" }],
		},
		capabilityCeiling: ["filesystem.read", "process.exec", "tests.execute"],
		toolNames: ["read", "run_process"],
		resourceProfileNames: ["operator-minimal"],
		dispatchProfileIds: [],
		executionPolicy: {
			allowedExecutables: ["npm", "node"],
			allowedEnvironmentVariables: ["CI"],
			maxOutputBytes: 64 * 1024,
		},
		budget: { maxCostUsd: 0.25, maxToolCalls: 20, maxWallClockMs: 120_000 },
		maxConcurrent: 2,
		leaseTtlMs: 180_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
}

describe("OrchestrationProfileStore", () => {
	let root: string;
	let store: OrchestrationProfileStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-orchestration-profiles-"));
		store = new OrchestrationProfileStore({
			agentDir: join(root, "agent"),
			cwd: join(root, "project"),
			projectTrusted: true,
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("atomically creates owner-authored global and project profiles", () => {
		const globalPath = store.save(profile("fast-worker", "small-fast"), "global");
		const projectPath = store.save(profile("architect", "planner"), "project");
		const loaded = store.load();

		expect(globalPath).toContain(join("profiles", "orchestration", "fast-worker.json"));
		expect(projectPath).toContain(join(".pi", "profiles", "orchestration", "architect.json"));
		expect(loaded.profiles.map((entry) => entry.profileId)).toEqual(["architect", "fast-worker"]);
		expect(loaded.registry.get("fast-worker")?.sourcePath).toBe(globalPath);
		expect(JSON.parse(readFileSync(globalPath, "utf-8"))).not.toHaveProperty("sourcePath");
		expect(loaded.diagnostics).toEqual([]);
	});

	it("gives project definitions deterministic precedence over global definitions", () => {
		store.save(profile("worker", "global-model"), "global");
		const projectPath = store.save(profile("worker", "project-model"), "project");
		const loaded = store.load();

		expect(loaded.registry.get("worker")?.modelPolicy.candidates[0]?.modelId).toBe("project-model");
		expect(loaded.registry.get("worker")?.sourcePath).toBe(projectPath);
	});

	it("does not load or write project profiles while the project is untrusted", () => {
		store.save(profile("worker", "global-model"), "global");
		store.save(profile("worker", "project-model"), "project");
		const untrusted = new OrchestrationProfileStore({
			agentDir: join(root, "agent"),
			cwd: join(root, "project"),
			projectTrusted: false,
		});

		const loaded = untrusted.load();

		expect(loaded.registry.get("worker")?.modelPolicy.candidates[0]?.modelId).toBe("global-model");
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({ scope: "project", message: expect.stringContaining("untrusted") }),
		]);
		expect(() => untrusted.save(profile("blocked", "model"), "project")).toThrow("not trusted");
	});

	it("does not silently replace a profile unless the owner requests overwrite", () => {
		store.save(profile("worker", "first"), "global");
		expect(() => store.save(profile("worker", "second"), "global")).toThrow("already exists");
		store.save(profile("worker", "second"), "global", { overwrite: true });
		expect(store.load().registry.get("worker")?.modelPolicy.candidates[0]?.modelId).toBe("second");
	});

	it("surfaces malformed and duplicate same-scope definitions without losing healthy profiles", () => {
		store.save(profile("healthy", "small"), "global");
		const malformedPath = join(store.directory("global"), "malformed.json");
		writeFileSync(malformedPath, "{broken", "utf-8");
		const duplicatePath = join(store.directory("global"), "z-duplicate.json");
		writeFileSync(duplicatePath, JSON.stringify(profile("healthy", "other")), "utf-8");
		const loaded = store.load();

		expect(loaded.registry.get("healthy")?.modelPolicy.candidates[0]?.modelId).toBe("small");
		expect(loaded.diagnostics.map((entry) => entry.path)).toEqual([malformedPath, duplicatePath]);
		expect(loaded.diagnostics[1]?.message).toContain("Duplicate orchestration profile 'healthy'");
	});

	it("isolates a profile with a missing verifier without losing unrelated healthy profiles", () => {
		store.save(profile("healthy", "small"), "global");
		store.save(
			{
				...profile("unavailable-verifier", "worker-model"),
				requireIndependentVerification: true,
				verificationProfileId: "missing-verifier",
			},
			"global",
		);

		const loaded = store.load();

		expect(loaded.profiles.map((entry) => entry.profileId)).toEqual(["healthy"]);
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({
				path: store.filePath("unavailable-verifier", "global"),
				message: "Verifier target 'missing-verifier' is missing or is not a verifier.",
			}),
		]);
	});

	it("rejects unsafe profile IDs before resolving a file path", () => {
		expect(() => store.save(profile("../escape", "small"), "global")).toThrow("profile IDs");
		expect(dirname(store.filePath("safe-worker", "global"))).toBe(store.directory("global"));
	});

	it("keeps an oversized malformed profile diagnostic-only without loading its content", () => {
		store.save(profile("healthy", "small"), "global");
		const oversizedPath = join(store.directory("global"), "oversized.json");
		writeFileSync(oversizedPath, "x".repeat(512 * 1024 + 1), "utf-8");

		const loaded = store.load();

		expect(loaded.profiles.map((entry) => entry.profileId)).toEqual(["healthy"]);
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({
				scope: "global",
				path: oversizedPath,
				message: expect.stringContaining("byte limit"),
			}),
		]);
	});

	it("diagnoses a profile directory burst without allocating an unbounded entry list", () => {
		const directory = store.directory("global");
		mkdirSync(directory, { recursive: true });
		for (let index = 0; index < 513; index++) {
			writeFileSync(join(directory, `burst-${String(index).padStart(4, "0")}.tmp`), "x", "utf-8");
		}

		const loaded = store.load();

		expect(loaded.profiles).toEqual([]);
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({ scope: "global", path: directory, message: expect.stringContaining("entry limit") }),
		]);
	});

	it("rejects an oversized owner-authored profile before creating its file", () => {
		const oversized = profile("oversized", "small") as unknown as Record<string, unknown>;
		oversized.unrecognizedPayload = "x".repeat(512 * 1024 + 1);

		expect(() => store.save(oversized as unknown as OrchestrationProfile, "global")).toThrow("byte limit");
		expect(() => readFileSync(store.filePath("oversized", "global"), "utf-8")).toThrow(/ENOENT/);
	});
});
