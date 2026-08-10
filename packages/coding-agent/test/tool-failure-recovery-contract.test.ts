import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	createFileFailureRecoveryAuthority,
	EDIT_RETARGET_RECOVERY_TARGET_KIND,
	FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
	FILE_EXISTS_RECOVERY_TARGET_KIND,
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
	});
});
