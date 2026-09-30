import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { TSchema } from "typebox";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { captureCandidateSnapshot } from "./candidate-snapshot.ts";
import type { VerificationCoordinator, VerificationHost } from "./verification-coordinator.ts";
import { VERIFICATION_OBLIGATIONS_CUSTOM_TYPE } from "./verification-obligations.ts";

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
			const cwd = operationCwd ?? getCwd();
			let root = cwd;
			while (
				!(
					existsSync(join(root, ".git")) &&
					(statSync(join(root, ".git")).isFile() || existsSync(join(root, ".git", "HEAD")))
				)
			) {
				const parent = dirname(root);
				if (parent === root) {
					const identity = createHash("sha256")
						.update(JSON.stringify([getManager().getSessionId(), cwd]))
						.digest("hex");
					return { id: `outcome:${identity}`, scope: cwd, kind: "outcome" };
				}
				root = parent;
			}
			return { id: captureCandidateSnapshot(root).digest, scope: root, kind: "repository" };
		},
		captureFence: () => {
			const manager = getManager();
			const session = manager.getSessionId();
			const leaf = manager.getLeafId();
			return () => {
				if (getManager() !== manager || manager.getSessionId() !== session) return false;
				if (leaf === null) return manager.getLeafId() === null;
				let cursor = manager.getLeafId();
				// Walk only the appended suffix, not the entire long-session branch on every check.
				while (cursor && cursor !== leaf) cursor = manager.getEntry(cursor)?.parentId ?? null;
				return cursor === leaf;
			};
		},
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
			const receiptCallId = verification.beginCall(invocationReceiverId, tool.name, invocationCwd);
			try {
				const result = await executor.execute(callId, input, signal, onUpdate);
				verification.finishCall({
					callId: receiptCallId,
					tool: tool.name,
					args: input,
					output: result,
					succeeded: result.isError !== true && signal?.aborted !== true,
				});
				return result;
			} catch (error) {
				verification.finishCall({
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
