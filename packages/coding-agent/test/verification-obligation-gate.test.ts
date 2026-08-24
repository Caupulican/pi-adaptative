import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarnessWithExtensions } from "./test-harness.ts";

const verificationParameters = Type.Object({ command: Type.String() });
const readParameters = Type.Object({});
const VERIFICATION_ID = "unit-suite";

const dirs: string[] = [];

function tempDir(): string {
	const dir = join(tmpdir(), `pi-verification-obligation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function verificationExtension(onUnrelatedRead?: () => void): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "verification_probe",
			label: "Verification probe",
			description: "Deterministic verification command fixture",
			parameters: verificationParameters,
			execute: async (_toolCallId, args) => {
				const [status, id] =
					args.command === "verify:pass-same"
						? (["passed", VERIFICATION_ID] as const)
						: args.command === "verify:pass-other"
							? (["passed", "other-suite"] as const)
							: (["failed", VERIFICATION_ID] as const);
				return {
					content: [{ type: "text", text: `${id}: ${status}` }],
					details: {
						piVerification: {
							version: 1,
							id,
							status,
							summary: `${id} ${status}`,
						},
					},
					...(status === "failed" ? { isError: true, errorKind: "operation_outcome" as const } : {}),
				};
			},
		});
		if (!onUnrelatedRead) return;
		pi.registerTool({
			name: "unrelated_read",
			label: "Unrelated read",
			description: "Unrelated admissible fixture",
			parameters: readParameters,
			execute: async () => {
				onUnrelatedRead();
				return { content: [{ type: "text", text: "read remains available" }], details: {} };
			},
		});
	};
}

function getTool(harness: Awaited<ReturnType<typeof createHarnessWithExtensions>>, name: string): AgentTool {
	const tool = harness.agent.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Expected active ${name} tool`);
	return tool;
}

describe("verification obligation public boundary", () => {
	it("keeps a failed piVerification provider-visible after persisted restart and compaction", async () => {
		const dir = tempDir();
		const sessionManager = SessionManager.create(dir, dir);
		const first = await createHarnessWithExtensions({
			sessionManager,
			cwd: dir,
			extensionFactories: [verificationExtension()],
			responses: [
				{ toolCalls: [{ id: "failed-unit", name: "verification_probe", args: { command: "verify:fail" } }] },
				"VERIFICATION_UNRESOLVED unit-suite: unit suite remains red",
				"Compact verification checkpoint.",
			],
		});
		first.session.setActiveToolsByName(["verification_probe"]);

		try {
			await first.session.prompt("Run the unit verification.", { autoContinueGoal: false });
			const compaction = await first.session.compact();
			expect(compaction.details).toMatchObject({
				piVerificationObligations: { version: 1, activeIds: [VERIFICATION_ID] },
			});
			await first.cleanup();

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			const restarted = SessionManager.open(sessionFile, dir);
			const resumed = await createHarnessWithExtensions({
				sessionManager: restarted,
				cwd: dir,
				responses: ["VERIFICATION_UNRESOLVED unit-suite: unit suite remains red"],
			});
			try {
				await resumed.session.prompt("Continue the implementation.", { autoContinueGoal: false });
				const providerVisibleContext = JSON.stringify(resumed.faux.contexts[0]);
				expect(providerVisibleContext).toContain("ACTIVE VERIFICATION FAILURES");
				expect(providerVisibleContext).toContain(VERIFICATION_ID);
			} finally {
				await resumed.cleanup();
			}
		} finally {
			await first.cleanup();
		}
	});

	it("refuses goal completion while a failed verification is active without denying unrelated tools", async () => {
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(
			sessionManager,
			createGoalState({ goalId: "verification-goal", userGoal: "Ship verified work", now: "T0" }),
		);
		let readCalls = 0;
		const harness = await createHarnessWithExtensions({
			sessionManager,
			extensionFactories: [verificationExtension(() => readCalls++)],
			responses: [
				{
					toolCalls: [{ id: "failed-unit", name: "verification_probe", args: { command: "verify:fail" } }],
				},
				"VERIFICATION_UNRESOLVED unit-suite: unit suite remains red",
			],
		});
		harness.session.setActiveToolsByName(["verification_probe", "unrelated_read", "goal"]);

		try {
			await harness.session.prompt("Run verification before completing the goal.", { autoContinueGoal: false });
			await getTool(harness, "unrelated_read").execute("read-after-failure", {}, undefined, undefined);
			const completion = await getTool(harness, "goal").execute(
				"complete-while-red",
				{ action: "complete" },
				undefined,
				undefined,
			);

			expect(readCalls).toBe(1);
			expect(completion.isError).toBe(true);
			expect(completion.details).toMatchObject({ error: expect.stringContaining(VERIFICATION_ID) });
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({ status: "active" });
		} finally {
			await harness.cleanup();
		}
	});

	it("releases only the exact failed verification id after a passing result", async () => {
		const sessionManager = SessionManager.inMemory();
		appendGoalStateSnapshot(
			sessionManager,
			createGoalState({ goalId: "verification-goal", userGoal: "Ship verified work", now: "T0" }),
		);
		const harness = await createHarnessWithExtensions({
			sessionManager,
			extensionFactories: [verificationExtension()],
			responses: [
				{
					toolCalls: [{ id: "failed-unit", name: "verification_probe", args: { command: "verify:fail" } }],
				},
				"VERIFICATION_UNRESOLVED unit-suite: unit suite remains red",
				{
					toolCalls: [{ id: "passed-other", name: "verification_probe", args: { command: "verify:pass-other" } }],
				},
				"VERIFICATION_UNRESOLVED unit-suite: unit suite remains red",
				{
					toolCalls: [{ id: "passed-unit", name: "verification_probe", args: { command: "verify:pass-same" } }],
				},
				"The failed unit suite now passes.",
			],
		});
		harness.session.setActiveToolsByName(["verification_probe", "goal"]);

		try {
			await harness.session.prompt("Run verification before completing the goal.", { autoContinueGoal: false });
			await harness.session.prompt("Run the unrelated suite.", { autoContinueGoal: false });
			const stillBlocked = await getTool(harness, "goal").execute(
				"complete-after-other-pass",
				{ action: "complete" },
				undefined,
				undefined,
			);
			expect(stillBlocked.isError).toBe(true);
			expect(stillBlocked.details).toMatchObject({ error: expect.stringContaining(VERIFICATION_ID) });

			await harness.session.prompt("Re-run the failed unit suite.", { autoContinueGoal: false });
			const released = await getTool(harness, "goal").execute(
				"complete-after-same-pass",
				{ action: "complete" },
				undefined,
				undefined,
			);
			expect(released.isError).not.toBe(true);
			expect(harness.session.getGoalStateSnapshot()).toMatchObject({ status: "completed" });
		} finally {
			await harness.cleanup();
		}
	});
});
