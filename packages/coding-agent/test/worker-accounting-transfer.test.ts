import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHistoricalWorkerAccountingState } from "../src/core/cost/worker-accounting-state.ts";
import { EMPTY_ATTEMPT_USAGE } from "../src/core/orchestration/attempt-usage.ts";
import {
	beginAttemptUsageGeneration,
	recordAttemptGenerationUsage,
} from "../src/core/orchestration/attempt-usage-generations.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
	toJsonObject,
} from "../src/core/orchestration/contracts.ts";
import type { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";

const task = { taskId: "task", objectiveId: "objective" };
const dispatch = { instructions: "Read src/limits.ts.", resourcePointerIds: [] };
const sourceUsage = { ...EMPTY_ATTEMPT_USAGE, inputTokens: 10, totalTokens: 10, costUsd: 0.1 };
const successorBaseline = { ...EMPTY_ATTEMPT_USAGE, inputTokens: 2, totalTokens: 2, costUsd: 0.02 };
const successorUsage = { ...EMPTY_ATTEMPT_USAGE, inputTokens: 3, totalTokens: 3, costUsd: 0.03 };
const sourceGeneration = { leaseId: "source-lease", fencingToken: 1 };
const successorGeneration = { leaseId: "successor-lease", fencingToken: 2 };
const recordedAt = "2026-11-20T00:00:00.000Z";
const receipt = (ordinal: number, kind: "baseline" | "increase", usage: typeof sourceUsage) => ({
	receiptId: `event-${ordinal}`,
	kind,
	usage,
	recordedAt,
});
const transfer = {
	commandId: "transfer",
	taskId: "task",
	sourceAgentId: "source-agent",
	sourceAttemptId: "source",
	successorAgentId: "successor-agent",
	successorAttemptId: "successor",
	targetModelRef: "fixture/successor",
	status: "requested",
};
function events(): OrchestrationEvent[] {
	const records: Array<Pick<OrchestrationEvent, "type"> & { payload: object }> = [
		{ type: "task.created", payload: { task } },
		{ type: "attempt.queued", payload: { taskId: "task", attemptId: "source", dispatch } },
		{
			type: "attempt.usage_registered",
			payload: { attemptId: "source", ...sourceGeneration, baseline: sourceUsage },
		},
		{ type: "model_transfer.requested", payload: transfer },
		{
			type: "model_transfer.successor_admitted",
			payload: { sourceAttemptId: "source", commandId: "transfer", dispatch },
		},
		{
			type: "attempt.usage_registered",
			payload: { attemptId: "successor", ...successorGeneration, baseline: successorBaseline },
		},
		{
			type: "attempt.usage_recorded",
			payload: { attemptId: "successor", ...successorGeneration, usage: successorUsage },
		},
	];
	return records.map(({ type, payload }, index) => ({
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		ordinal: index + 1,
		eventId: `event-${index + 1}`,
		type,
		aggregateId: "task",
		actor: "runtime",
		occurredAt: "2026-11-20T00:00:00.000Z",
		payload: toJsonObject(payload),
	}));
}

it.each([0, 4, 5, 7])(
	"attributes source and successor costs across a snapshot through ordinal %i",
	(throughOrdinal) => {
		const rootDir = mkdtempSync(join(tmpdir(), "pi-worker-transfer-usage-"));
		try {
			const source = {
				attemptId: "source",
				taskId: "task",
				dispatch,
				checkpointIds: [],
				usageAccounting: beginAttemptUsageGeneration(undefined, sourceGeneration, sourceUsage),
				usageReceipts: { "event-3": receipt(3, "baseline", sourceUsage) },
				modelTransfer: { ...transfer, status: throughOrdinal >= 5 ? "successor_admitted" : "requested" },
			};
			const successor = {
				attemptId: "successor",
				taskId: "task",
				dispatch,
				checkpointIds: [],
				...(throughOrdinal === 7
					? {
							usageReceipts: {
								"event-6": receipt(6, "baseline", successorBaseline),
								"event-7": receipt(7, "increase", {
									...EMPTY_ATTEMPT_USAGE,
									inputTokens: 1,
									totalTokens: 1,
									costUsd: 0.01,
								}),
							},
							usageAccounting: recordAttemptGenerationUsage(
								beginAttemptUsageGeneration(undefined, successorGeneration, successorBaseline),
								successorGeneration,
								successorUsage,
							),
						}
					: {}),
			};
			const snapshot =
				throughOrdinal === 0
					? undefined
					: {
							throughOrdinal,
							projection: {
								tasks: { task: { task } },
								attempts: { source, ...(throughOrdinal >= 5 ? { successor } : {}) },
								checkpoints: {},
								agents: {},
							},
						};
			const journal = events();
			const store = {
				rootDir,
				sessionId: "parent",
				readProjectionSnapshot: () => snapshot,
				readAll: () => journal,
				readAfter: (ordinal: number) => journal.filter((event) => event.ordinal > ordinal),
			} as unknown as OrchestrationEventStore;
			const state = readHistoricalWorkerAccountingState(store);
			expect([...state.attempts.keys()]).toEqual(["source", "successor"]);
			expect(state.attempts.get("source")?.usage).toEqual(sourceUsage);
			expect(state.attempts.get("successor")?.usage).toEqual(successorUsage);
			expect([...state.attempts.get("source")!.usageReceipts.keys()]).toEqual(["event-3"]);
			expect([...state.attempts.get("successor")!.usageReceipts.keys()]).toEqual(["event-6", "event-7"]);
			expect(
				[...state.attempts.values()].reduce((sum, attempt) => sum + (attempt.usage?.costUsd ?? 0), 0),
			).toBeCloseTo(0.13);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	},
);

it("rejects successor usage without its admitted attempt", () => {
	const journal = events().filter((event) => event.type !== "model_transfer.successor_admitted");
	const store = {
		readProjectionSnapshot: () => undefined,
		readAll: () => journal,
	} as unknown as OrchestrationEventStore;
	expect(() => readHistoricalWorkerAccountingState(store)).toThrow("Archived usage names an unknown attempt.");
});

it("rejects successor admission for a different transfer command", () => {
	const journal = events();
	journal[4] = {
		...journal[4]!,
		payload: toJsonObject({ sourceAttemptId: "source", commandId: "another-transfer", dispatch }),
	};
	const store = {
		readProjectionSnapshot: () => undefined,
		readAll: () => journal,
	} as unknown as OrchestrationEventStore;
	expect(() => readHistoricalWorkerAccountingState(store)).toThrow(
		"Archived model transfer successor was not requested.",
	);
});
