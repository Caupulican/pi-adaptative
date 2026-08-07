import { describe, expect, it } from "vitest";
import {
	MAX_WORKER_TASK_VIEW_BYTES,
	MAX_WORKER_TASK_VIEW_ENTRIES,
	projectWorkerTaskSessionView,
} from "../src/core/delegation/worker-task-view.ts";
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	ORCHESTRATION_SCHEMA_VERSION,
} from "../src/core/orchestration/contracts.ts";
import type {
	AttemptRuntimeState,
	TaskRuntimeProjection,
	TaskRuntimeState,
} from "../src/core/orchestration/task-runtime.ts";

function taskState(
	taskId: string,
	overrides: Partial<TaskRuntimeState["task"]> = {},
	attemptIds: readonly string[] = [],
): TaskRuntimeState {
	return {
		task: {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			taskId,
			objectiveId: "objective-1",
			title: `Title ${taskId}`,
			description: `Description ${taskId}`,
			role: "explorer",
			status: "ready",
			dependsOn: [],
			requiredCapabilities: [],
			acceptanceCriterionIds: [],
			riskBudget: {},
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:00.000Z",
			...overrides,
		},
		attemptIds,
	};
}

function snapshot(
	tasks: readonly TaskRuntimeState[],
	attempts: Readonly<Record<string, AttemptRuntimeState>> = {},
): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: Object.fromEntries(tasks.map((task) => [task.task.taskId, task])),
		attempts,
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

describe("worker task session view", () => {
	it("projects only provider-neutral task and latest-attempt fields from the durable SSOT", () => {
		const subject = taskState(
			"subject",
			{
				title: "Inspect durable ownership",
				description: "SECRET_TASK_DESCRIPTION",
				role: "implementer",
				status: "blocked",
				dependsOn: ["dependency-a"],
				requiredCapabilities: ["filesystem.write"],
				riskBudget: { maxCostUsd: 999 },
			},
			["attempt-old", "attempt-latest"],
		);
		subject.verification = {
			verifierTaskId: "verifier",
			verifierAttemptId: "SECRET_VERIFIER_ATTEMPT_ID",
			verdict: "accepted",
			reasonCode: "independent_verification_accepted",
			completedAt: "2026-08-07T01:00:00.000Z",
		};
		const verifier = taskState("verifier", {
			role: "verifier",
			status: "completed",
			verificationOfTaskId: "subject",
			createdAt: "2026-08-07T00:01:00.000Z",
		});
		const latestAttempt = {
			attemptId: "attempt-latest",
			taskId: "subject",
			dispatch: {
				provider: "SECRET_PROVIDER",
				taskId: "subject",
				instructions: "SECRET_INSTRUCTIONS",
				profileId: "SECRET_PROFILE",
				resourcePointerIds: ["SECRET_RESOURCE"],
				logicalLaneId: "logical-agent",
			},
			status: "suspended",
			reasonCode: "transient_transport",
			grantId: "SECRET_GRANT_ID",
			grant: { secret: "SECRET_COMPILED_GRANT" },
			lease: {
				leaseId: "SECRET_LEASE_ID",
				ownerId: "SECRET_LEASE_OWNER",
			},
			retry: { retriesUsed: 2, notBefore: "2026-08-07T02:00:00.000Z" },
			checkpointIds: ["SECRET_CHECKPOINT"],
			result: {
				summary: "SECRET_RAW_RESULT",
				evidence: [{ summary: "SECRET_EVIDENCE" }],
				errors: [{ details: { diagnostic: "SECRET_PROVIDER_DIAGNOSTIC" } }],
			},
			createdAt: "2026-08-07T00:02:00.000Z",
			updatedAt: "2026-08-07T00:03:00.000Z",
		} as unknown as AttemptRuntimeState;
		const durable = snapshot([subject, verifier], {
			"attempt-old": { ...latestAttempt, attemptId: "attempt-old", status: "failed", reasonCode: "old" },
			"attempt-latest": latestAttempt,
		});
		(durable.agents as Record<string, unknown>)["logical-agent"] = {
			agentId: "logical-agent",
			resumeContext: {
				sessionId: "SECRET_SESSION_ID",
				sessionFile: "/SECRET_SESSION_PATH",
				cwd: "/SECRET_CWD",
				contextPointers: [{ uri: "SECRET_CONTEXT_POINTER" }],
			},
		};

		const view = projectWorkerTaskSessionView(durable);

		expect(view).toEqual({
			totalTasks: 2,
			omittedTaskCount: 0,
			tasks: [
				{
					taskId: "verifier",
					title: "Title verifier",
					role: "verifier",
					status: "completed",
					dependsOn: [],
					verificationOfTaskId: "subject",
				},
				{
					taskId: "subject",
					title: "Inspect durable ownership",
					role: "implementer",
					status: "blocked",
					dependsOn: ["dependency-a"],
					verificationOutcome: {
						verifierTaskId: "verifier",
						verdict: "accepted",
						reasonCode: "independent_verification_accepted",
					},
					latestAttempt: {
						agentId: "logical-agent",
						status: "suspended",
						reasonCode: "transient_transport",
						retry: { retriesUsed: 2, notBefore: "2026-08-07T02:00:00.000Z" },
					},
				},
			],
		});
		const serialized = JSON.stringify(view);
		for (const secret of [
			"SECRET_TASK_DESCRIPTION",
			"SECRET_VERIFIER_ATTEMPT_ID",
			"SECRET_PROVIDER",
			"SECRET_INSTRUCTIONS",
			"SECRET_PROFILE",
			"SECRET_RESOURCE",
			"SECRET_GRANT_ID",
			"SECRET_COMPILED_GRANT",
			"SECRET_LEASE_ID",
			"SECRET_LEASE_OWNER",
			"SECRET_CHECKPOINT",
			"SECRET_RAW_RESULT",
			"SECRET_EVIDENCE",
			"SECRET_PROVIDER_DIAGNOSTIC",
			"SECRET_SESSION_ID",
			"SECRET_SESSION_PATH",
			"SECRET_CWD",
			"SECRET_CONTEXT_POINTER",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("returns the newest bounded task window in stable order independent of record insertion order", () => {
		const count = MAX_WORKER_TASK_VIEW_ENTRIES + 5;
		const tasks = Array.from({ length: count }, (_, index) =>
			taskState(`task-${index.toString().padStart(3, "0")}`, {
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			}),
		);
		const forward = projectWorkerTaskSessionView(snapshot(tasks));
		const reversed = projectWorkerTaskSessionView(snapshot([...tasks].reverse()));

		expect(forward).toEqual(reversed);
		expect(forward.totalTasks).toBe(count);
		expect(forward.omittedTaskCount).toBe(5);
		expect(forward.tasks).toHaveLength(MAX_WORKER_TASK_VIEW_ENTRIES);
		expect(forward.tasks[0]?.taskId).toBe(`task-${(count - 1).toString().padStart(3, "0")}`);
		expect(forward.tasks.at(-1)?.taskId).toBe("task-005");
	});

	it("bounds aggregate UTF-8 output while admitting max-field multibyte tasks newest first", () => {
		const count = 20;
		const tasks = Array.from({ length: count }, (_, index) =>
			taskState(`task-${index.toString().padStart(3, "0")}`, {
				title: "界".repeat(MAX_ORCHESTRATION_DESCRIPTION_LENGTH),
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			}),
		);
		const forward = projectWorkerTaskSessionView(snapshot(tasks));
		const reversed = projectWorkerTaskSessionView(snapshot([...tasks].reverse()));

		expect(forward).toEqual(reversed);
		expect(forward.tasks.length).toBeGreaterThan(0);
		expect(forward.tasks.length).toBeLessThan(count);
		expect(forward.tasks[0]?.taskId).toBe("task-019");
		expect(forward.omittedTaskCount).toBe(count - forward.tasks.length);
		expect(Buffer.byteLength(JSON.stringify(forward), "utf8")).toBeLessThanOrEqual(MAX_WORKER_TASK_VIEW_BYTES);
	});

	it("omits an individually oversized multibyte task without truncating it to fit", () => {
		const oversized = taskState("oversized", {
			title: "界".repeat(MAX_ORCHESTRATION_DESCRIPTION_LENGTH),
			dependsOn: Array.from(
				{ length: MAX_ORCHESTRATION_COLLECTION_LENGTH },
				(_, index) =>
					`${index.toString().padStart(2, "0")}-${"😀".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH / 2 - 2)}`,
			),
		});

		const view = projectWorkerTaskSessionView(snapshot([oversized]));

		expect(view).toEqual({ totalTasks: 1, omittedTaskCount: 1, tasks: [] });
		expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(MAX_WORKER_TASK_VIEW_BYTES);
	});

	it("bounds exposed text and dependency collections even for an adversarial in-memory snapshot", () => {
		const dependency = "d".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10);
		const task = taskState(
			"t".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10),
			{
				title: "x".repeat(MAX_ORCHESTRATION_DESCRIPTION_LENGTH + 10),
				dependsOn: Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH + 10 }, () => dependency),
			},
			["attempt"],
		);
		const attempt = {
			attemptId: "attempt",
			taskId: task.task.taskId,
			dispatch: { logicalLaneId: "a".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10) },
			status: "failed",
			reasonCode: "r".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10),
			retry: { retriesUsed: 3, notBefore: "n".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10) },
			checkpointIds: [],
			createdAt: "T0",
			updatedAt: "T1",
		} as unknown as AttemptRuntimeState;

		const projected = projectWorkerTaskSessionView(snapshot([task], { attempt })).tasks[0];

		expect(projected?.taskId).toHaveLength(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(projected?.title).toHaveLength(MAX_ORCHESTRATION_DESCRIPTION_LENGTH);
		expect(projected?.dependsOn).toHaveLength(MAX_ORCHESTRATION_COLLECTION_LENGTH);
		expect(projected?.dependsOn[0]).toHaveLength(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(projected?.latestAttempt?.agentId).toHaveLength(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(projected?.latestAttempt?.reasonCode).toHaveLength(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(projected?.latestAttempt?.retry?.notBefore).toHaveLength(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	});

	it("omits latest-attempt data safely when legacy attempt references are absent", () => {
		const legacyAttempt = {
			attemptId: "attempt-legacy",
			taskId: "legacy-with-attempt",
			dispatch: { logicalLaneId: "legacy-agent", instructions: "SECRET_LEGACY_INSTRUCTIONS" },
			status: "completed",
			checkpointIds: [],
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:01.000Z",
		} as unknown as AttemptRuntimeState;
		const durable = snapshot(
			[
				taskState("legacy-with-attempt", { createdAt: "2026-08-07T00:01:00.000Z" }, [
					"missing-old",
					"attempt-legacy",
					"missing-latest",
				]),
				taskState("legacy-without-attempt", { createdAt: "2026-08-07T00:02:00.000Z" }, ["missing"]),
			],
			{ "attempt-legacy": legacyAttempt },
		);

		expect(projectWorkerTaskSessionView(durable).tasks).toEqual([
			{
				taskId: "legacy-without-attempt",
				title: "Title legacy-without-attempt",
				role: "explorer",
				status: "ready",
				dependsOn: [],
			},
			{
				taskId: "legacy-with-attempt",
				title: "Title legacy-with-attempt",
				role: "explorer",
				status: "ready",
				dependsOn: [],
				latestAttempt: { agentId: "legacy-agent", status: "completed" },
			},
		]);
	});

	it("fails closed on invalid union values and malformed dependency or retry fields", () => {
		const invalidUnion = "INVALID_".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		const validTask = taskState(
			"valid",
			{
				dependsOn: [
					42,
					null,
					"dependency",
					"d".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 10),
				] as unknown as string[],
				createdAt: "2026-08-07T00:02:00.000Z",
			},
			["attempt"],
		);
		validTask.verification = {
			verifierTaskId: "SECRET_INVALID_VERIFIER",
			verifierAttemptId: "SECRET_INVALID_ATTEMPT",
			verdict: invalidUnion as "accepted",
			reasonCode: "SECRET_INVALID_REASON",
			completedAt: "2026-08-07T00:03:00.000Z",
		};
		const invalidTask = taskState("invalid-task", {
			role: invalidUnion as "explorer",
			status: invalidUnion as "ready",
			createdAt: "2026-08-07T00:04:00.000Z",
		});
		const invalidAttemptTask = taskState("invalid-attempt", { createdAt: "2026-08-07T00:01:00.000Z" }, [
			"invalid-attempt",
		]);
		const malformedAttempt = {
			attemptId: "attempt",
			taskId: "valid",
			dispatch: { logicalLaneId: 42 },
			status: "running",
			reasonCode: { raw: "SECRET_INVALID_ATTEMPT_REASON" },
			retry: { retriesUsed: "3", notBefore: { raw: "SECRET_INVALID_NOT_BEFORE" } },
			checkpointIds: [],
			createdAt: "T0",
			updatedAt: "T1",
		} as unknown as AttemptRuntimeState;
		const invalidAttempt = {
			...malformedAttempt,
			attemptId: "invalid-attempt",
			taskId: "invalid-attempt",
			status: invalidUnion,
		} as unknown as AttemptRuntimeState;

		const durable = snapshot([validTask, invalidTask, invalidAttemptTask], {
			attempt: malformedAttempt,
			"invalid-attempt": invalidAttempt,
		});
		(durable.tasks as Record<string, TaskRuntimeState>)["wrong-record-key"] = taskState("SECRET_MISATTRIBUTED");
		const view = projectWorkerTaskSessionView(durable);

		expect(view).toEqual({
			totalTasks: 4,
			omittedTaskCount: 2,
			tasks: [
				{
					taskId: "valid",
					title: "Title valid",
					role: "explorer",
					status: "ready",
					dependsOn: ["dependency", "d".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH)],
					latestAttempt: { status: "running" },
				},
				{
					taskId: "invalid-attempt",
					title: "Title invalid-attempt",
					role: "explorer",
					status: "ready",
					dependsOn: [],
				},
			],
		});
		expect(JSON.stringify(view)).not.toContain(invalidUnion);
		expect(JSON.stringify(view)).not.toContain("SECRET_INVALID");
	});
});
