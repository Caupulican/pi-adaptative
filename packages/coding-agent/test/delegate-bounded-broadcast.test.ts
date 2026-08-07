import { describe, expect, it, vi } from "vitest";
import type {
	WorkerAgentBroadcastTargetResult,
	WorkerAgentControlPort,
} from "../src/core/delegation/worker-agent-control.ts";
import { MAX_ORCHESTRATION_COLLECTION_LENGTH } from "../src/core/orchestration/contracts.ts";
import { createDelegateToolDefinition, type DelegateToolDetails } from "../src/core/tools/delegate.ts";

const MAX_CONTROL_RESULT_BYTES = 16 * 1024;

describe("delegate broadcast result bounds", () => {
	it("bounds the complete retained details envelope with explicit omission disclosure", async () => {
		const agentIds = Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH }, (_, index) => {
			const prefix = `agent-${index.toString().padStart(2, "0")}-`;
			return `${prefix}${"a".repeat(512 - prefix.length)}`;
		});
		const results: WorkerAgentBroadcastTargetResult[] = agentIds.map((agentId, index) => {
			const prefix = `message-${index.toString().padStart(2, "0")}-`;
			return {
				agentId,
				accepted: true,
				queued: true,
				replayed: false,
				messageId: `${prefix}${"m".repeat(512 - prefix.length)}`,
			};
		});
		const workerAgentControl = {
			broadcastWorkerAgentMessage: vi.fn(() => ({ results })),
		} as unknown as WorkerAgentControlPort;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl,
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: "branch-1" }),
		});

		const result = await definition.execute(
			"call-bounded-broadcast",
			{ action: "broadcast", agentIds, message: "Inspect." },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const details = result.details as DelegateToolDetails;

		expect(Buffer.byteLength(JSON.stringify(details), "utf-8")).toBeLessThanOrEqual(MAX_CONTROL_RESULT_BYTES);
		expect(details.broadcastResultsOmitted).toBeGreaterThan(0);
		expect((details.broadcastResults?.length ?? 0) + (details.broadcastResultsOmitted ?? 0)).toBe(results.length);
		expect(details.agentIds).toEqual(details.broadcastResults?.map(({ agentId }) => agentId));
	});
});
