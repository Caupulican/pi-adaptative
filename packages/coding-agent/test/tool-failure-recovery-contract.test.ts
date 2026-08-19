import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoop } from "@caupulican/pi-agent-core/agent-loop";
import type { AgentEvent, AgentMessage } from "@caupulican/pi-agent-core/types";
import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@caupulican/pi-ai/types";
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
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";
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
		expect(first.outputSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(repeated.outputSignature).toBe(first.outputSignature);
		expect(changed.outputSignature).not.toBe(first.outputSignature);
	});

	it("pairs a workspace-mutating shell failure with the tools that can repair that workspace", async () => {
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
		// The contract is a match of authority and target kind: that pairing is what surfaces edit as
		// the repair for a shell command that failed on workspace contents.
		expect(action.authority).toBe(target.authority);
		expect(result.details).toMatchObject({ phase: "edited" });

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
		expect(writeResult.details).toMatchObject({ phase: "written" });

		// Workspace identity lives in the target's scope, which is exact per root. Actions carry no
		// scope: they are teaching text and grant no execution, so a same-authority edit rooted in
		// another workspace can appear in guidance without being able to unblock anything.
		const otherBash = createBashTool(otherCwd);
		const otherTarget = otherBash.failureRecovery?.getFailureTargets?.(
			{ command: "cargo test -p subject --lib focused_case -- --exact" },
			{ failureCode: "exit_101" },
		)?.[0];
		expect(otherTarget).toMatchObject({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: otherCwd });
		expect(otherTarget?.scope).not.toBe(target.scope);
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

	it("pairs write's file-exists repair action with read's missing-file target", async () => {
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
		const shellTarget = bash.failureRecovery?.getFailureTargets?.(
			{ command: "test-command" },
			{ failureCode: "exit_1" },
		)?.[0];
		expect(shellTarget).toMatchObject({ kind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, scope: `remote:${cwd}` });
		expect(shellTarget?.authority).toBe(target.authority);
	});

	// The source bash adapter, a real subprocess, the real agent loop, and the default stall backstop.
	// The provider is a deterministic fake — only the model's turns are simulated. Packaged-artifact
	// behavior is proven separately by the built-runtime smoke, not here.
	it("carries a real non-zero shell exit through the agent loop as an operation outcome", async () => {
		const cwd = await createTemporaryRoot("pi-shell-operation-outcome-");
		const shellSessionKey = `tool-failure-operation-outcome:${cwd}`;
		const bash = createBashTool(cwd, { outputDirectory: cwd, sessionKey: shellSessionKey });
		const command = `node -e "console.log('FAILED (errors=2)'); process.exit(3)"`;
		try {
			// 1. The tool itself classifies a completed process that exited non-zero.
			const thrown = await bash.execute("shell-outcome", { command }).then(
				() => undefined,
				(error: unknown) => error as { failureCode?: string; errorKind?: string; message?: string },
			);
			expect(thrown?.failureCode).toBe("exit_3");
			expect(thrown?.errorKind).toBe("operation_outcome");
			expect(thrown?.message).toContain("FAILED (errors=2)");

			// 2. The same tool driven by the real loop, replayed exactly as the reported session did.
			let turn = 0;
			const events: AgentEvent[] = [];
			const stream = agentLoop(
				[{ role: "user", content: "reproduce the red baseline", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [bash] },
				{
					model: {
						id: "mock",
						name: "mock",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://example.invalid",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 2048,
					},
					convertToLlm: (messages: AgentMessage[]) =>
						messages.filter(
							(message) =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						) as Message[],
				},
				undefined,
				() => {
					const mock = new EventStream<AssistantMessageEvent, AssistantMessage>(
						(event) => event.type === "done" || event.type === "error",
						(event) => {
							if (event.type === "done") return event.message;
							if (event.type === "error") return event.error;
							throw new Error("Unexpected event type");
						},
					);
					queueMicrotask(() => {
						turn++;
						const base = {
							role: "assistant" as const,
							api: "openai-responses" as const,
							provider: "openai",
							model: "mock",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: 1,
						};
						mock.push(
							turn <= 4
								? {
										type: "done",
										reason: "toolUse",
										message: {
											...base,
											content: [
												{ type: "toolCall", id: `bash-${turn}`, name: "bash", arguments: { command } },
											],
											stopReason: "toolUse",
										},
									}
								: {
										type: "done",
										reason: "stop",
										message: {
											...base,
											content: [{ type: "text", text: "Red baseline reproduced; two errors to fix." }],
											stopReason: "stop",
										},
									},
						);
					});
					return mock;
				},
			);
			for await (const event of stream) events.push(event);

			const toolResults = events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
			);
			// The run survived all four calls and reached the model's own closing turn.
			expect(turn).toBe(5);
			expect(toolResults).toHaveLength(4);
			expect(
				events.some(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.content.some(
							(block) => block.type === "text" && block.text === "Red baseline reproduced; two errors to fix.",
						),
				),
			).toBe(true);

			// The executed call kept the command's own output verbatim, with no harness record over it.
			const firstText = toolResults[0].content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(toolResults[0].errorKind).toBe("operation_outcome");
			expect(firstText).toContain("FAILED (errors=2)");
			expect(firstText).toContain("Command exited with code 3");
			expect(firstText).not.toContain("[harness]");

			// The three replays were refused, never executed, and never escalated past a refusal.
			for (const replay of toolResults.slice(1)) {
				const text = replay.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				expect(text).toContain('"failure_code":"repeated_failed_operation"');
				expect(text).not.toContain("recovery_exhausted");
			}
		} finally {
			// Windows keeps a process's working directory locked until the persistent shell has reached
			// physical terminal close. Release that owned process before afterEach removes the fixture.
			await disposeShellExecutionSessionAndWait(shellSessionKey);
		}
	});
});
