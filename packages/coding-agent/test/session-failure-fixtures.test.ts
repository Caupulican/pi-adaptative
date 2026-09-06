import type { AgentMessage, AgentTool } from "@caupulican/pi-agent-core";
import {
	VerificationObligationTracker,
	type VerificationRecord,
} from "@caupulican/pi-agent-core/verification-obligations";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapToolWithPathAliasExpansion } from "../src/core/context/path-alias-tool-wrap.ts";
import { classifyShellVerificationCommand } from "../src/core/tools/shell-test-command.ts";
import { aliasReactivationFixture, verificationCwdFixture } from "./fixtures/session-failures.ts";

function verificationMessage(record: VerificationRecord): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `fixture-${record.status}`,
		toolName: "bash",
		content: [],
		isError: record.status === "failed",
		details: { piVerification: record },
		timestamp: record.status === "failed" ? 1 : 2,
	};
}

describe("synthetic session failure fixtures", () => {
	it("expands the alias at the wrapper while an unwrapped mock rejects it", async () => {
		const fixture = aliasReactivationFixture;
		const parameters = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof parameters> = {
			name: "read",
			label: "Read fixture",
			description: "Read an in-memory fixture; never access the filesystem.",
			parameters,
			execute: async (_id, params) => {
				if (params.path !== fixture.path) throw new Error(`ENOENT: ${params.path}`);
				return { content: [{ type: "text", text: fixture.content }], details: undefined };
			},
		};
		const wrappedTools = new WeakSet<AgentTool>();
		const getTable = () => ({ cwd: fixture.cwd, entries: [{ id: fixture.alias, path: fixture.path }] });
		const wrapped = wrapToolWithPathAliasExpansion(tool, getTable, wrappedTools, () => fixture.cwd);
		await expect(tool.execute("fixture-raw", { path: fixture.alias }, undefined)).rejects.toThrow("ENOENT");
		await expect(wrapped.execute("fixture-wrapped", { path: fixture.alias }, undefined)).resolves.toMatchObject({
			content: [{ type: "text", text: fixture.content }],
		});
		for (let activation = 1; activation < fixture.activationCount; activation++) {
			expect(wrapToolWithPathAliasExpansion(wrapped, getTable, wrappedTools, () => fixture.cwd)).toBe(wrapped);
			const reactivated = wrapToolWithPathAliasExpansion(tool, getTable, wrappedTools, () => fixture.cwd);
			await expect(
				reactivated.execute("fixture-reactivated", { path: fixture.alias }, undefined),
			).resolves.toMatchObject({
				content: [{ type: "text", text: fixture.content }],
			});
		}
	});

	it("does not let a different-directory pass erase an ordinary failed verification", () => {
		const { failed, corrected } = verificationRecords();
		expect(failed.id).not.toBe(corrected.id);
		expect(failed.repairGroup).toBe(corrected.repairGroup);
		const tracker = new VerificationObligationTracker([verificationMessage(failed), verificationMessage(corrected)]);
		expect(tracker.getActiveIds()).toEqual([failed.id]);
		expect(tracker.requestInstruction()).not.toContain("(empty-test setup;");
	});

	it("accepts a matching corrected pass only with trusted setup-failure classification", () => {
		const { failed, corrected } = verificationRecords();
		const tracker = new VerificationObligationTracker([
			verificationMessage({ ...failed, outcome: "setup_failed" }),
			verificationMessage(corrected),
		]);
		expect(tracker.getActiveIds()).toEqual([]);
	});

	it("accepts an ordinary passing rerun with the same verification identity", () => {
		const { failed } = verificationRecords();
		const tracker = new VerificationObligationTracker([
			verificationMessage(failed),
			verificationMessage({ ...failed, status: "passed" }),
		]);
		expect(tracker.getActiveIds()).toEqual([]);
	});
});

function verificationRecords(): { failed: VerificationRecord; corrected: VerificationRecord } {
	const fixture = verificationCwdFixture;
	const initial = classifyShellVerificationCommand(fixture.command, fixture.incorrectCwd, fixture.workspaceRoot)!;
	const corrected = classifyShellVerificationCommand(fixture.command, fixture.correctedCwd, fixture.workspaceRoot)!;
	return {
		failed: { version: 1, id: initial.id, status: "failed", repairGroup: initial.repairGroup },
		corrected: {
			version: 1,
			id: corrected.id,
			status: "passed",
			outcome: "executed",
			repairGroup: corrected.repairGroup,
			repairOf: initial.id,
		},
	};
}
