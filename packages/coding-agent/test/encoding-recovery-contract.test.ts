import { describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createFileFailureRecoveryAuthority } from "../src/core/tools/file-failure-recovery.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createPythonTool } from "../src/core/tools/python.ts";
import { memoryFileBackend } from "./fixtures/memory-file-backend.ts";

describe("encoding recovery contract", () => {
	it("routes a native edit encoding failure to an encoding-preserving Python correction", () => {
		const edit = createEditTool(process.cwd());
		const python = createPythonTool(process.cwd(), { outputReduction: { enabled: false } });
		const target = edit.failureRecovery?.getFailureTargets?.(
			{ path: "synthetic.txt", edits: [{ oldText: "a", newText: "b" }] },
			{ failureCode: "encoding_corruption" },
		)?.[0];
		expect(target).toBeDefined();
		const action = python.failureRecovery?.actions?.find(
			(candidate) => candidate.targetKind === target?.kind && candidate.authority === target?.authority,
		);
		expect(action).toMatchObject({
			kind: "correct",
			instruction: expect.stringMatching(/binary.*codec.*BOM.*newline.*verif/i),
		});
	});

	it("does not give local Python authority over a custom backend's encoding failure", () => {
		const backend = memoryFileBackend("win32");
		const authority = createFileFailureRecoveryAuthority((path) => path);
		const intentController = new FileMutationIntentController({
			operations: backend.operations,
			pathOptions: { flavor: "win32" },
		});
		const edit = createEditTool("Q:\\fixture", {
			operations: backend.edit,
			intentController,
			failureRecoveryAuthority: authority,
		});
		const target = edit.failureRecovery?.getFailureTargets?.(
			{ path: "synthetic.txt", edits: [{ oldText: "a", newText: "b" }] },
			{ failureCode: "encoding_corruption" },
		)?.[0];
		expect(target?.scope).toBe("Q:\\fixture\\synthetic.txt");
		const python = createPythonTool(process.cwd(), { outputReduction: { enabled: false } });
		expect(python.failureRecovery?.actions?.some((action) => action.authority === target?.authority)).toBe(false);
	});

	it("does not infer recovery authority for custom Python operations", () => {
		const python = createPythonTool(process.cwd(), {
			outputReduction: { enabled: false },
			resolveRuntime: async () => {
				throw new Error("Fixture must not resolve a runtime");
			},
			operations: {
				getEnvironment: async () => ({ variables: {}, caseSensitive: true }),
				readOutputRules: async () => [],
				stat: async () => {
					throw new Error("Fixture must not inspect a path");
				},
				exec: async () => ({ exitCode: 0, reason: "exited", signal: null }),
			},
		});
		expect(python.failureRecovery?.actions ?? []).toEqual([]);
	});
});
