import type { AgentTool } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { createExecutionContext } from "@caupulican/pi-agent-core/paths";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createSessionVerificationHost,
	wrapToolWithVerification,
} from "../../src/core/system-one/session-verification-host.ts";
import type { VerificationHost } from "../../src/core/system-one/verification-coordinator.ts";
import { VerificationCoordinator } from "../../src/core/system-one/verification-coordinator.ts";
import type { SemanticVerificationSnapshot } from "../../src/core/system-one/verification-obligations.ts";
import { tempDir } from "../temp-dir.ts";

describe("session verification tool receipts", () => {
	it("does not let a non-Git task directory's reproduction resolve another directory's obligation", async () => {
		const taskA = tempDir("pi-verify-task-a-");
		const taskB = tempDir("pi-verify-task-b-");
		let activeCwd = taskB;
		let records: SemanticVerificationSnapshot | undefined;
		let leafId: string | null = null;
		const manager = {
			getSessionId: () => "session-a",
			getSessionLineageIds: () => ["session-a"],
			getLatestCustomEntryOnBranch: () => (records ? { data: records } : undefined),
			appendCustomEntry: (_type: string, record: SemanticVerificationSnapshot) => {
				records = structuredClone(record);
				leafId = `${leafId ?? "root"}-next`;
			},
			getLeafId: () => leafId,
			getEntry: () => undefined,
		} as unknown as SessionManager;
		const host = createSessionVerificationHost(
			() => manager,
			() => activeCwd,
		);
		const verification = new VerificationCoordinator(host, async (_state, _questions) => ({
			id: "jev-safe-operation",
			answers: {
				verification_operation_safe: { noul: 0.99 },
				verification_resolution_valid: { noul: 0.99 },
			},
		}));
		verification.require("postflight", ["Verify task B's current directory candidate."]);
		const obligation = verification.status().obligations[0]!;

		const callId = verification.beginCall("session-a", "read", taskA);
		verification.finishCall({
			callId,
			tool: "read",
			args: { path: "proof.txt" },
			output: { content: [{ type: "text", text: "PASS" }] },
			succeeded: true,
		});
		const receipt = verification.status().receipts[0]!;
		activeCwd = taskB;
		const resolution = await verification.resolve({
			id: obligation.id,
			disposition: "rejected",
			evidence: [{ receiptId: receipt.id, role: "reproduction" }],
		});

		expect(resolution).toMatchObject({
			status: "unresolved",
			reason: "candidate_rejection_requires_passing_current_reproduction",
		});
		expect(verification.status().obligations).toHaveLength(1);
	});

	it("uses one admitted invocation cwd for classification and both receipt candidates", async () => {
		const defaultCwd = "/workspace-a";
		const taskCwd = "/workspace-b";
		const records = new Map<string, SemanticVerificationSnapshot>();
		const candidateCwds: string[] = [];
		const host: VerificationHost = {
			storage: {
				getBranchKey: () => "session-a",
				readRecords: (key) => records.get(key),
				appendRecord: (key, record) => records.set(key, structuredClone(record)),
			},
			getReceiverId: () => "session-a",
			getCandidate: (requestedCwd) => {
				const cwd = requestedCwd ?? defaultCwd;
				candidateCwds.push(cwd);
				return { id: `candidate:${cwd}`, scope: cwd, kind: "repository" };
			},
			captureFence: () => () => true,
		};
		const verification = new VerificationCoordinator(host, async (_state, _questions) => ({
			id: "jev-safe-operation",
			answers: { verification_operation_safe: { noul: 0.99 } },
		}));
		verification.require("postflight", ["Verify the current task directory candidate."]);
		const executionContext = createExecutionContext({
			attachment: {
				workspaceId: "workspace-b",
				attachmentId: "workspace-b-v1",
				root: taskCwd,
				flavor: process.platform === "win32" ? "win32" : "posix",
				caseSensitive: process.platform !== "win32",
			},
			cwd: taskCwd,
			sessionId: "session-a",
			generation: 1,
		});
		const parameters = Type.Object({ command: Type.String() });
		const baseTool: AgentTool<typeof parameters, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters,
			execute: async () => ({ content: [{ type: "text", text: "PASS" }], details: {} }),
			bindInvocation: async () => ({
				executionContext,
				execute: async () => ({ content: [{ type: "text", text: "PASS" }], details: {} }),
				release: () => {},
			}),
		};
		const wrapped = wrapToolWithVerification(
			baseTool,
			() => verification,
			() => defaultCwd,
		);
		const invocation = await wrapped.bindInvocation!("call", { command: "focused check" });
		try {
			await invocation.execute("call", { command: "focused check" });
		} finally {
			invocation.release();
		}

		const receipt = verification.status().receipts[0]!;
		expect(candidateCwds).toEqual([defaultCwd, taskCwd, taskCwd, taskCwd, taskCwd]);
		expect(receipt).toMatchObject({
			candidateBefore: `candidate:${taskCwd}`,
			candidateAfter: `candidate:${taskCwd}`,
		});
		const crossScopeResolution = await verification.resolve({
			id: verification.status().obligations[0]!.id,
			disposition: "rejected",
			evidence: [{ receiptId: receipt.id, role: "reproduction" }],
		});
		expect(crossScopeResolution).toMatchObject({
			status: "unresolved",
			reason: "candidate_rejection_requires_passing_current_reproduction",
		});
		expect(verification.status().obligations).toHaveLength(1);
	});
});
