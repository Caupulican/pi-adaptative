import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	createFileFailureRecoveryAuthority,
	EDIT_RETARGET_RECOVERY_TARGET_KIND,
	FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
	FILE_EXISTS_RECOVERY_TARGET_KIND,
	WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
	WRITE_RETARGET_RECOVERY_TARGET_KIND,
} from "../src/core/tools/file-failure-recovery.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("tool-owned failure recovery contracts", () => {
	it("emits stable failure identity from the complete shell output", async () => {
		const cwd = await createTemporaryRoot("pi-shell-failure-identity-");
		const run = async (...outputChunks: string[]) => {
			const bash = createBashTool(cwd, {
				operations: {
					exec: async (_command, _cwd, options) => {
						for (const chunk of outputChunks) options.onData(Buffer.from(chunk));
						return { exitCode: 1 };
					},
				},
				outputDirectory: cwd,
			});
			try {
				await bash.execute("shell-failure", { command: "run focused tests" });
			} catch (error) {
				return error as Error & { failureCode?: string; outputSignature?: string };
			}
			throw new Error("Expected shell failure");
		};
		const sharedHead = "same head\n".repeat(2_500);
		const sharedTail = "same tail\n".repeat(2_500);
		const first = await run(`${sharedHead}first failing assertion\n${sharedTail}`);
		const repeated = await run(sharedHead, "first failing assertion\n", sharedTail);
		const changed = await run(`${sharedHead}second failing assertion\n${sharedTail}`);

		expect(first.failureCode).toBe("exit_1");
		expect(first.outputSignature).toMatch(/^[0-9a-f]{64}$/);
		expect(repeated.outputSignature).toBe(first.outputSignature);
		expect(changed.outputSignature).not.toBe(first.outputSignature);
	});

	it("reopens one exact shell probe only after a successful mutation in the same workspace", async () => {
		const cwd = await createTemporaryRoot("pi-shell-mutation-recovery-");
		const otherCwd = await createTemporaryRoot("pi-shell-mutation-other-");
		await writeFile(join(cwd, "subject.txt"), "before\n", "utf8");
		await writeFile(join(otherCwd, "subject.txt"), "before\n", "utf8");
		const bash = createBashTool(cwd);
		const target = bash.failureRecovery?.getFailureTargets?.(
			{ command: "cargo test -p subject --lib focused_case -- --exact" },
			{ failureCode: "exit_101" },
		)?.[0];

		expect(target).toMatchObject({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: cwd });
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{ command: "cargo test -p subject --lib focused_case -- --exact" },
				{ failureCode: "operation_rejected" },
			),
		).toEqual([]);
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{
					command: "cd /tmp/proj && .venv/bin/python - <<'PY'\nfrom collections import Counter\nprint(1)\nPY",
				},
				{ failureCode: "exit_1" },
			),
		).toEqual([]);
		expect(
			bash.failureRecovery?.getFailureTargets?.({ command: "python -c 'print(1)'" }, { failureCode: "exit_1" }),
		).toEqual([]);
		expect(
			bash.failureRecovery?.getFailureTargets?.({ command: "node -e 'console.log(1)'" }, { failureCode: "exit_1" }),
		).toEqual([]);
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{ command: "node --eval='console.log(1)'" },
				{ failureCode: "exit_1" },
			),
		).toEqual([]);
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{ command: "node scripts/check.js --eval strict" },
				{ failureCode: "exit_1" },
			),
		).toEqual([expect.objectContaining({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: cwd })]);
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{ command: "python scripts/check.py -c strict" },
				{ failureCode: "exit_1" },
			),
		).toEqual([expect.objectContaining({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: cwd })]);
		expect(
			bash.failureRecovery?.getFailureTargets?.({ command: "echo node -e && false" }, { failureCode: "exit_1" }),
		).toEqual([expect.objectContaining({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: cwd })]);
		expect(
			bash.failureRecovery?.getFailureTargets?.(
				{ command: "python scripts/check.py <<'EOF'\ninput\nEOF" },
				{ failureCode: "exit_1" },
			),
		).toEqual([expect.objectContaining({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: cwd })]);

		const input = { path: "subject.txt", edits: [{ oldText: "before", newText: "after" }] };
		const edit = createEditTool(cwd);
		const result = await edit.execute("edit-workspace-recovery", input);
		const action = edit.failureRecovery?.actions?.find(
			(candidate) => candidate.kind === "repair" && candidate.targetKind === WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
		);
		if (!target || !action || action.kind !== "repair") {
			throw new Error("Expected matching shell/edit workspace-mutation recovery contracts");
		}
		expect(action.authority).toBe(target.authority);
		expect(action.getEvidence(input, result)).toEqual([target.scope]);

		const writeInput = { path: "created.txt", content: "created\n" };
		const write = createWriteTool(cwd);
		const writeResult = await write.execute("write-workspace-recovery", writeInput);
		const writeAction = write.failureRecovery?.actions?.find(
			(candidate) => candidate.kind === "repair" && candidate.targetKind === WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
		);
		if (!writeAction || writeAction.kind !== "repair") {
			throw new Error("Expected matching shell/write workspace-mutation recovery contracts");
		}
		expect(writeAction.authority).toBe(target.authority);
		expect(writeAction.getEvidence(writeInput, writeResult)).toEqual([target.scope]);

		const otherInput = { path: "subject.txt", edits: [{ oldText: "before", newText: "after" }] };
		const otherEdit = createEditTool(otherCwd);
		const otherResult = await otherEdit.execute("edit-other-workspace", otherInput);
		const otherAction = otherEdit.failureRecovery?.actions?.find(
			(candidate) => candidate.kind === "repair" && candidate.targetKind === WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
		);
		if (!otherAction || otherAction.kind !== "repair") {
			throw new Error("Expected other workspace mutation recovery contract");
		}
		expect(otherAction.getEvidence(otherInput, otherResult)).not.toContain(target.scope);
	});

	it("lets read declare an exact missing-file target without interpreting argument text", async () => {
		const cwd = await createTemporaryRoot("pi-read-recovery-contract-");
		const read = createReadTool(cwd);

		const targets = read.failureRecovery?.getFailureTargets?.(
			{ path: "missing.txt" },
			{ failureCode: "file_not_found" },
		);
		expect(targets).toHaveLength(1);
		expect(targets?.[0]).toMatchObject({
			kind: FILE_EXISTS_RECOVERY_TARGET_KIND,
			scope: join(cwd, "missing.txt"),
		});
		expect(
			read.failureRecovery?.getFailureTargets?.({ path: "missing.txt" }, { failureCode: "permission_denied" }),
		).toEqual([]);
	});

	it("emits file-exists evidence only from write's successful written result", async () => {
		const cwd = await createTemporaryRoot("pi-write-recovery-contract-");
		const read = createReadTool(cwd);
		const write = createWriteTool(cwd);
		const input = { path: "nested/../created.txt", content: "created" };
		const target = read.failureRecovery?.getFailureTargets?.(
			{ path: "./created.txt" },
			{ failureCode: "file_not_found" },
		)?.[0];
		const result = await write.execute("write-recovery", input);
		const action = write.failureRecovery?.actions?.find(
			(candidate) => candidate.kind === "repair" && candidate.targetKind === FILE_EXISTS_RECOVERY_TARGET_KIND,
		);
		if (!action || action.kind !== "repair") throw new Error("Expected write file-exists repair action");

		expect(target).toMatchObject({ kind: FILE_EXISTS_RECOVERY_TARGET_KIND, scope: join(cwd, "created.txt") });
		expect(action.authority).toBe(target?.authority);
		expect(action.getEvidence(input, result)).toEqual([target?.scope]);
		expect(result.details).toMatchObject({ phase: "written" });
	});

	it("declares changed-operation guidance without granting repair evidence", async () => {
		const cwd = await createTemporaryRoot("pi-correction-contract-");
		const read = createReadTool(cwd);
		const write = createWriteTool(cwd);
		const edit = createEditTool(cwd);
		const ls = createLsTool(cwd);

		expect(read.failureRecovery?.actions).toContainEqual(
			expect.objectContaining({ kind: "correct", targetKind: FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND }),
		);
		expect(ls.failureRecovery?.actions).toContainEqual(
			expect.objectContaining({ kind: "correct", targetKind: FILE_EXISTS_RECOVERY_TARGET_KIND }),
		);
		expect(write.failureRecovery?.actions).toContainEqual(
			expect.objectContaining({ kind: "correct", targetKind: WRITE_RETARGET_RECOVERY_TARGET_KIND }),
		);
		expect(edit.failureRecovery?.actions).toContainEqual(
			expect.objectContaining({ kind: "correct", targetKind: EDIT_RETARGET_RECOVERY_TARGET_KIND }),
		);

		const editInput = { path: "target.txt", edits: [{ oldText: "before", newText: "after" }] };
		expect(
			edit.failureRecovery?.getFailureTargets?.(editInput, { failureCode: "edit_old_text_not_found" })?.[0],
		).toMatchObject({ kind: FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND, scope: join(cwd, "target.txt") });
		expect(edit.failureRecovery?.exhaustionScope).toBe("operation");
		expect(
			edit.failureRecovery?.getFailureEvidence?.(editInput, {
				failureCode: "edit_old_text_not_found",
				message: "Could not find oldText. Current source sha256 abc: current text",
			}),
		).toContain("Current source sha256 abc");
		expect(
			edit.failureRecovery?.getFailureEvidence?.(editInput, {
				failureCode: "permission_denied",
				message: "Current source must not escape for unrelated failures",
			}),
		).toBeUndefined();
	});

	it("does not claim local recovery authority for custom operation adapters", async () => {
		const cwd = await createTemporaryRoot("pi-custom-recovery-contract-");
		const read = createReadTool(cwd, {
			operations: {
				readFile: async () => Buffer.from("remote"),
				access: async () => {},
			},
		});
		const write = createWriteTool(cwd, {
			operations: {
				createFile: async () => {},
				mkdir: async () => {},
			},
			intentController: new FileMutationIntentController(),
		});
		const edit = createEditTool(cwd, {
			operations: {
				readFile: async () => Buffer.from("remote"),
				writeFile: async () => {},
			},
			intentController: new FileMutationIntentController(),
		});
		const ls = createLsTool(cwd, {
			operations: {
				exists: async () => true,
				stat: async () => ({ isDirectory: () => true }),
				readdir: async () => [],
			},
		});
		const bash = createBashTool(cwd, {
			operations: {
				exec: async () => ({ exitCode: 1 }),
			},
		});

		expect(
			read.failureRecovery?.getFailureTargets?.({ path: "remote.txt" }, { failureCode: "file_not_found" }),
		).toEqual([]);
		expect(
			write.failureRecovery?.actions?.find(
				(action) => action.kind === "repair" && action.targetKind === FILE_EXISTS_RECOVERY_TARGET_KIND,
			),
		).toBeUndefined();
		expect(
			read.failureRecovery?.actions?.find(
				(action) => action.kind === "correct" && action.targetKind === FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
			),
		).toBeUndefined();
		expect(
			edit.failureRecovery?.getFailureTargets?.(
				{ path: "remote.txt", edits: [{ oldText: "before", newText: "after" }] },
				{ failureCode: "edit_old_text_not_found" },
			),
		).toEqual([]);
		expect(
			ls.failureRecovery?.actions?.find(
				(action) => action.kind === "correct" && action.targetKind === FILE_EXISTS_RECOVERY_TARGET_KIND,
			),
		).toBeUndefined();
		expect(bash.failureRecovery?.getFailureTargets?.({ command: "test-command" }, { failureCode: "exit_1" })).toEqual(
			[],
		);
	});

	it("matches only custom tools that share one explicit backend authority", async () => {
		const cwd = await createTemporaryRoot("pi-shared-recovery-contract-");
		const authority = createFileFailureRecoveryAuthority((absolutePath) => `remote:${absolutePath}`);
		const read = createReadTool(cwd, {
			operations: {
				readFile: async () => Buffer.from("remote"),
				access: async () => {},
			},
			failureRecoveryAuthority: authority,
		});
		const write = createWriteTool(cwd, {
			operations: {
				createFile: async () => {},
				mkdir: async () => {},
			},
			intentController: new FileMutationIntentController(),
			failureRecoveryAuthority: authority,
		});
		const bash = createBashTool(cwd, {
			operations: {
				exec: async () => ({ exitCode: 1 }),
			},
			failureRecoveryAuthority: authority,
		});
		const target = read.failureRecovery?.getFailureTargets?.(
			{ path: "remote.txt" },
			{ failureCode: "file_not_found" },
		)?.[0];
		const action = write.failureRecovery?.actions?.find(
			(candidate) => candidate.kind === "repair" && candidate.targetKind === FILE_EXISTS_RECOVERY_TARGET_KIND,
		);
		if (!target || !action || action.kind !== "repair") throw new Error("Expected shared recovery contract");

		expect(action.authority).toBe(target.authority);
		expect(
			action.getEvidence(
				{ path: "remote.txt", content: "created" },
				{ content: [{ type: "text", text: "written" }], details: { phase: "written" } },
			),
		).toEqual([target.scope]);
		const shellTarget = bash.failureRecovery?.getFailureTargets?.(
			{ command: "test-command" },
			{ failureCode: "exit_1" },
		)?.[0];
		expect(shellTarget).toMatchObject({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: `remote:${cwd}` });
		expect(shellTarget?.authority).toBe(target.authority);
	});
});
