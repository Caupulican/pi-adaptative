import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TSchema } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
import type { SessionManager } from "../../kernel/node.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { captureCandidateSnapshot, captureCandidateSnapshotAsync } from "./candidate-snapshot.ts";
import type { StageExecutionScopeSource } from "./controller.ts";
import type { VerificationCoordinator, VerificationHost } from "./verification-coordinator.ts";
import { VERIFICATION_OBLIGATIONS_CUSTOM_TYPE } from "./verification-obligations.ts";

type CandidateLocation = { kind: "repository"; root: string } | { kind: "outcome"; cwd: string };

/** The git worktree root above `cwd`, or `cwd` itself when none contains it. Reads only a few directory entries. */
function locateCandidate(cwd: string): CandidateLocation {
	let root = cwd;
	while (
		!(
			existsSync(join(root, ".git")) &&
			(statSync(join(root, ".git")).isFile() || existsSync(join(root, ".git", "HEAD")))
		)
	) {
		const parent = dirname(root);
		if (parent === root) return { kind: "outcome", cwd };
		root = parent;
	}
	return { kind: "repository", root };
}

function outcomeCandidate(sessionId: string, cwd: string): { id: string; scope: string; kind: "outcome" } {
	const identity = createHash("sha256")
		.update(JSON.stringify([sessionId, cwd]))
		.digest("hex");
	return { id: `outcome:${identity}`, scope: cwd, kind: "outcome" };
}

/** Infrastructure adapter: the active branch journal and actual worktree own identity. */
export function createSessionVerificationHost(
	getManager: () => SessionManager,
	getCwd: () => string,
): VerificationHost {
	return {
		storage: {
			getBranchKey: () => getManager().getSessionId(),
			getInheritedBranchKeys: () => getManager().getSessionLineageIds().slice(1),
			getReceiverId: () => getManager().getSessionId(),
			readRecords: (branch) => {
				const manager = getManager();
				if (manager.getSessionId() !== branch) throw new Error("Verification session changed");
				// The domain owner validates unknown persisted data before using it.
				return manager.getLatestCustomEntryOnBranch(VERIFICATION_OBLIGATIONS_CUSTOM_TYPE)?.data as ReturnType<
					VerificationHost["storage"]["readRecords"]
				>;
			},
			appendRecord: (branch, record) => {
				const manager = getManager();
				if (manager.getSessionId() !== branch) throw new Error("Verification session changed");
				manager.appendCustomEntry(VERIFICATION_OBLIGATIONS_CUSTOM_TYPE, record);
			},
		},
		getReceiverId: () => getManager().getSessionId(),
		getCandidate: (operationCwd) => {
			const where = locateCandidate(operationCwd ?? getCwd());
			return where.kind === "outcome"
				? outcomeCandidate(getManager().getSessionId(), where.cwd)
				: { id: captureCandidateSnapshot(where.root).digest, scope: where.root, kind: "repository" };
		},
		captureCandidate: async (operationCwd) => {
			const where = locateCandidate(operationCwd ?? getCwd());
			return where.kind === "outcome"
				? outcomeCandidate(getManager().getSessionId(), where.cwd)
				: { id: (await captureCandidateSnapshotAsync(where.root)).digest, scope: where.root, kind: "repository" };
		},
		captureFence: () => {
			const manager = getManager();
			const session = manager.getSessionId();
			const leaf = manager.getLeafId();
			return () => {
				return (
					getManager() === manager && isSessionAppendAnchorCurrent(manager, { sessionId: session, leafId: leaf })
				);
			};
		},
	};
}

/** A pending goal-stage answer retains its goal identity, objective words and branch ancestry. */
export function createSessionStageExecutionScope(
	host: Pick<VerificationHost, "captureFence">,
	getGoal: () => Pick<GoalState, "goalId" | "userGoal"> | undefined,
	isClosed: () => boolean,
): StageExecutionScopeSource {
	return () => {
		const branchCurrent = host.captureFence();
		const goal = getGoal();
		const goalId = goal?.goalId;
		const userGoal = goal?.userGoal;
		return () => {
			if (isClosed()) return "session_disposed";
			if (!branchCurrent()) return "goal_replaced";
			const current = getGoal();
			return current?.goalId === goalId && current?.userGoal === userGoal ? undefined : "goal_replaced";
		};
	};
}

/** One execution decorator for the foreground registry and isolated worker tool surfaces. */
export function wrapToolWithVerification<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	getVerification: () => VerificationCoordinator | undefined,
	getCwd: () => string,
	receiverId?: string,
): AgentTool<TParameters, TDetails> {
	return wrapToolExecution(tool, (executor, context) => ({
		...executor,
		async execute(callId, args, signal, onUpdate) {
			const verification = getVerification();
			if (!verification) return executor.execute(callId, args, signal, onUpdate);
			const input = structuredClone(args);
			const invocationCwd = context?.cwd ?? getCwd();
			const invocationReceiverId = receiverId ?? context?.sessionId;
			await verification.checkOperation(
				{
					tool: tool.name,
					args: input,
					cwd: invocationCwd,
					readOnly: tool.readOnly === true,
					receiverId: invocationReceiverId,
				},
				signal,
			);
			signal?.throwIfAborted();
			const receiptCallId = await verification.beginCall(invocationReceiverId, tool.name, invocationCwd);
			try {
				const result = await executor.execute(callId, input, signal, onUpdate);
				await verification.finishCall({
					callId: receiptCallId,
					tool: tool.name,
					args: input,
					output: result,
					succeeded: result.isError !== true && signal?.aborted !== true,
				});
				return result;
			} catch (error) {
				await verification.finishCall({
					callId: receiptCallId,
					tool: tool.name,
					args: input,
					output: { error: error instanceof Error ? error.message : String(error) },
					succeeded: false,
				});
				throw error;
			}
		},
	}));
}
