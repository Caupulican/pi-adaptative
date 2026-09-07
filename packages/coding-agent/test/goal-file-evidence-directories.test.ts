import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { GoalFileEvidenceResolution } from "../src/core/goals/file-evidence.ts";
import { createGoalState, parseGoalState, serializeGoalState } from "../src/core/goals/goal-state.ts";
import {
	createGoalToolDefinition,
	type GoalToolDependencies,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(overrides: Partial<GoalToolDependencies> = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-file-directories-"));
	scratch.push(root);
	const projects = [join(root, "first 日本語"), join(root, "second project")];
	for (const project of projects) mkdirSync(project);
	let cwd = projects[0]!;
	let state = createGoalState({ goalId: "synthetic-goal", userGoal: "Review two projects", now: "T0" });
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (next) => {
			state = next;
		},
		cwd: () => cwd,
		now: () => "T1",
		...overrides,
	});
	return {
		projects,
		state: () => state,
		select: (index: number) => {
			cwd = projects[index]!;
		},
		async run(input: GoalToolInput, signal?: AbortSignal) {
			const result = await tool.execute("synthetic-call", input, signal, undefined, {} as ExtensionContext);
			return { ...result, details: result.details as GoalToolDetails };
		},
	};
}

const evidence = { action: "add_evidence", kind: "file", summary: "Synthetic file exists", uri: "result.txt" } as const;

describe("goal file evidence directory provenance", () => {
	it("persists an absolute source locator across selection and state serialization", async () => {
		const test = fixture();
		const expected = join(test.projects[0]!, evidence.uri);
		writeFileSync(expected, "synthetic first project\n");
		expect((await test.run(evidence)).details.applied).toBe(true);
		test.select(1);
		const restored = parseGoalState(serializeGoalState(test.state()));
		expect(restored?.evidence[0]).toMatchObject({ uri: expected, verified: true });
	});

	it("gives the same relative filename in different projects distinct generated evidence ids", async () => {
		const test = fixture();
		for (const project of test.projects) writeFileSync(join(project, evidence.uri), "synthetic\n");
		expect((await test.run(evidence)).details.applied).toBe(true);
		test.select(1);
		const second = await test.run(evidence);
		expect(second.details.applied, JSON.stringify(second.details)).toBe(true);
		expect(new Set(test.state().evidence.map((entry) => entry.id)).size).toBe(2);
		expect(test.state().evidence.map((entry) => entry.uri)).toEqual(
			test.projects.map((project) => join(project, evidence.uri)),
		);
		// Exact repeated evidence in the same project still cannot mint another record.
		expect((await test.run(evidence)).details.applied).toBe(false);
		expect(test.state().evidence).toHaveLength(2);
	});

	it.each(["@result.txt", "chapter\u202F1.txt"])(
		"verifies literal filename %s before input-spelling conveniences",
		async (uri) => {
			const test = fixture();
			const path = join(test.projects[0]!, uri);
			writeFileSync(path, "synthetic literal path\n");
			await test.run({ ...evidence, uri });
			expect(test.state().evidence[0]).toMatchObject({ verified: true, uri: path });
		},
	);

	it("does not append evidence after cancellation", async () => {
		const test = fixture();
		writeFileSync(join(test.projects[0]!, evidence.uri), "synthetic\n");
		const before = serializeGoalState(test.state());
		await expect(test.run(evidence, AbortSignal.abort(new Error("synthetic cancellation")))).rejects.toThrow(
			"synthetic cancellation",
		);
		expect(serializeGoalState(test.state())).toBe(before);
	});

	it("uses the explicit backend locator without reading the operator cwd or trimming filename bytes", async () => {
		const uri = "backend://synthetic-host/D:/project/result.txt ";
		const test = fixture({
			cwd: () => {
				throw new Error("Operator cwd must not be consulted");
			},
			resolveFileEvidence: async (input) => {
				expect(input).toBe(evidence.uri);
				return { verified: true, uri };
			},
		});
		expect((await test.run(evidence)).details.applied).toBe(true);
		expect(parseGoalState(serializeGoalState(test.state()))?.evidence[0]).toMatchObject({ uri, verified: true });
	});

	it("does not fall back to a native namesake after backend verification fails", async () => {
		const test = fixture({
			resolveFileEvidence: async () => {
				throw new Error("SYNTHETIC_EACCES");
			},
		});
		writeFileSync(join(test.projects[0]!, evidence.uri), "native decoy\n");
		await expect(test.run(evidence)).rejects.toThrow("SYNTHETIC_EACCES");
		expect(test.state().evidence).toEqual([]);
	});

	it("settles cancellation while the backend is pending and ignores its late successful result", async () => {
		const pending = Promise.withResolvers<GoalFileEvidenceResolution>();
		const started = Promise.withResolvers<void>();
		const test = fixture({
			resolveFileEvidence: () => {
				started.resolve();
				return pending.promise;
			},
		});
		const abort = new AbortController();
		const result = test.run(evidence, abort.signal);
		const rejected = expect(result).rejects.toThrow("cancel pending evidence");
		await started.promise;
		abort.abort(new Error("cancel pending evidence"));
		await rejected;
		pending.resolve({ verified: true, uri: "backend://synthetic/result.txt" });
		await pending.promise;
		expect(test.state().evidence).toEqual([]);
	});

	it("checks cancellation again after backend verification succeeds", async () => {
		const abort = new AbortController();
		const test = fixture({
			resolveFileEvidence: async () => {
				abort.abort(new Error("cancel before evidence commit"));
				return { verified: true, uri: "backend://synthetic/result.txt" };
			},
		});
		await expect(test.run(evidence, abort.signal)).rejects.toThrow("cancel before evidence commit");
		expect(test.state().evidence).toEqual([]);
	});

	it("keeps the locator bound inclusive of literal trailing whitespace", async () => {
		const test = fixture({
			resolveFileEvidence: async () => ({ verified: true, uri: `backend://synthetic/${" ".repeat(4096)}` }),
		});
		const result = await test.run(evidence);
		expect(result.details.applied).toBe(false);
		expect(result.details.error).toContain("uri must be at most");
		expect(test.state().evidence).toEqual([]);
	});

	it("retains the shared missing-name spelling recovery without changing the resolved locator", async () => {
		const test = fixture();
		const path = join(test.projects[0]!, "chapter 1.txt");
		writeFileSync(path, "synthetic fallback control\n");
		await test.run({ ...evidence, uri: "chapter\u202F1.txt" });
		expect(test.state().evidence[0]).toMatchObject({ verified: true, uri: path });
	});
});
