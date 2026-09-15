/**
 * Specialist identity in the lane projection and the shared UI panels.
 *
 * `projectWorkerLaneRecord` emits one `LaneRecord` per TASK (`laneId = taskId` for an in-process
 * worker) and exposes `agentStatus` but never the `agentId` that owns the attempt. Every downstream
 * consumer therefore counts tasks where it means specialists:
 *
 * - `isRetainedWorkerLane` + `projectWorkActivity` (agents-overlay.ts) build one row per task, so a
 *   single specialist that has finished several tasks fills the active panel with history.
 * - `buildAgentsPanelModel`'s status is `"error"` when ANY retained worker record is `failed`, so a
 *   specialist whose current task is running or succeeded still reports error because of a task it
 *   finished long ago.
 * - `buildWorkbenchSections`' Team meta counts those same records, so "N agents" is really N tasks.
 *
 * Target behaviour (Root's decision): the active roster shows each specialist's CURRENT queued or
 * running task once; idle retained contexts are summarised as availability rather than as finished
 * task rows; full task history stays durable and reachable through `getRecords()`.
 *
 * Everything is driven through the real `WorkerLifecycle` and the real durable ledger, so ordering is
 * the durable attempt order the projection itself uses -- never a hand-built record array and never a
 * wall-clock sort. The current task is identified with the public `getLatestAgentAttempt`, the same
 * durable-order accessor the runtime uses, and one test deliberately feeds the panel a reversed
 * record array to prove the answer does not depend on input order.
 *
 * No resolver or roster API is imported: these assertions are about what the EXISTING public
 * projections return.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	type AgentResumeContext,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	type AgentsOverlaySnapshot,
	buildAgentsPanelModel,
	buildWorkPanelModel,
	isRetainedWorkerLane,
} from "../src/modes/interactive/components/agents-overlay.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { buildWorkbenchSections } from "../src/modes/interactive/workbench-controller.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

/** Real clock: WorkerLifecycle forwards `now` only to the runtime, so a frozen past clock would
 * make every lease expire at the moment it is granted. No assertion here depends on elapsed time. */
const NOW = Date.now();
const LEASE_TTL_MS = 60_000;
const roots: string[] = [];

/**
 * The owning specialist identity a lane record must carry. Structural intersection so the baseline
 * types cleanly against today's `LaneRecord`; the assertions below prove the value, not the type.
 */
type SpecialistLaneRecord = LaneRecord & { agentId?: string };

// `buildWorkbenchSections` renders themed text; the shared panel builders need a loaded theme.
beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-specialist-roster-"));
	roots.push(directory);
	return directory;
}

function resumeContext(agentId: string): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `worker-${agentId}`,
		cwd: "/repo",
		resourceProfileNames: [],
		contextPointers: [],
	};
}

function profileFixture(): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId: "implementer",
		model: { provider: "anthropic", id: "test-model" },
	});
}

function contractFor(profile: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
		},
	});
}

function terminalResult(handle: StartedDelegationAttempt, status: "completed" | "failed"): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${handle.attemptId}`,
		objectiveId: handle.objectiveId,
		taskId: handle.taskId,
		attemptId: handle.attemptId,
		leaseId: handle.leaseId,
		fencingToken: handle.fencingToken,
		status,
		reasonCode: status === "completed" ? "worker_completed" : "worker_failed",
		summary: status,
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
		createdAt: new Date().toISOString(),
	};
}

interface Specialist {
	lifecycle: WorkerLifecycle;
	agentId: string;
}

/** Register one logical specialist with its first queued task. */
function startSpecialist(lifecycle: WorkerLifecycle, agentId: string, profile: OrchestrationProfile): Specialist {
	lifecycle.prepare(
		{ instructions: `${agentId} first task`, executionContract: contractFor(profile), requiredCapabilities: [] },
		agentId,
	);
	lifecycle.ensureAgent({ agentId, role: profile.role, resumeContext: resumeContext(agentId) });
	return { lifecycle, agentId };
}

/** Grant and lease the specialist's current queued task, leaving it running. */
function runCurrentTask(specialist: Specialist): StartedDelegationAttempt {
	const attempt = specialist.lifecycle.getLatestAgentAttempt(specialist.agentId);
	if (!attempt) throw new Error(`No current attempt for ${specialist.agentId}`);
	const task = specialist.lifecycle.getTask(attempt.taskId);
	if (!task) throw new Error(`No durable task for ${attempt.taskId}`);
	specialist.lifecycle.bindGrant(
		attempt.attemptId,
		createTestExecutionGrant({
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
		}),
	);
	return specialist.lifecycle.startAgent(attempt.taskId, specialist.agentId, LEASE_TTL_MS);
}

/** Run the specialist's current queued task through to a terminal status. */
function settleCurrentTask(specialist: Specialist, status: "completed" | "failed"): void {
	specialist.lifecycle.finish(terminalResult(runCurrentTask(specialist), status), { notify: false });
}

/** Queue one further task on the same durable identity. */
function queueNextTask(specialist: Specialist, instructions: string): void {
	specialist.lifecycle.prepareAgentTurn({ agentId: specialist.agentId, instructions });
}

function overlaySnapshot(lifecycle: WorkerLifecycle, records?: readonly LaneRecord[]): AgentsOverlaySnapshot {
	return { laneRecords: records ?? lifecycle.getRecords(), items: [] };
}

/** The `lane: <laneId>` detail every worker row carries (agents-overlay.ts `workerRow`). */
function rowLaneIds(rows: readonly { details?: readonly string[] }[]): string[] {
	return rows.flatMap((row) => {
		const lane = (row.details ?? []).find((detail) => detail.startsWith("lane: "));
		return lane ? [lane.slice("lane: ".length)] : [];
	});
}

function sectionText(sections: readonly { title: string; meta?: string; body: unknown }[], title: string): string {
	const section = sections.find((candidate) => candidate.title === title);
	if (!section) throw new Error(`No ${title} section`);
	const body = Array.isArray(section.body) ? section.body.join("\n") : "";
	return `${section.meta ?? ""}\n${body}`;
}

describe("worker specialist roster", () => {
	it("exposes the owning specialist identity on every lane record", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-identity" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		settleCurrentTask(specialist, "completed");
		queueNextTask(specialist, "second task");
		settleCurrentTask(specialist, "completed");
		queueNextTask(specialist, "third task");

		const records: SpecialistLaneRecord[] = lifecycle.getRecords();

		expect(records).toHaveLength(3);
		// Without the owning identity on the record, no consumer can group tasks by specialist.
		expect(records.map((record) => record.agentId)).toEqual(["worker-1", "worker-1", "worker-1"]);
	});

	it("shows one current row per specialist regardless of how many tasks it has finished", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-rows" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		for (const instructions of ["second task", "third task", "fourth task"]) {
			settleCurrentTask(specialist, "completed");
			queueNextTask(specialist, instructions);
		}
		runCurrentTask(specialist);
		const current = lifecycle.getLatestAgentAttempt("worker-1");
		expect(current?.status).toBe("running");

		const panel = buildAgentsPanelModel(overlaySnapshot(lifecycle), NOW);

		expect(lifecycle.getRecords()).toHaveLength(4);
		expect(panel.rows ?? []).toHaveLength(1);
		// The single row must be the specialist's current durable task, not an arbitrary earlier one.
		expect(rowLaneIds(panel.rows ?? [])).toEqual([current?.taskId]);
	});

	it("keeps the current running task current when the durable records arrive out of order", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-order" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		settleCurrentTask(specialist, "failed");
		queueNextTask(specialist, "recovery task");
		runCurrentTask(specialist);
		const current = lifecycle.getLatestAgentAttempt("worker-1");
		expect(current?.status).toBe("running");

		// Reversed input: the answer must come from durable order, never from array position.
		const reversed = [...lifecycle.getRecords()].reverse();
		const panel = buildAgentsPanelModel(overlaySnapshot(lifecycle, reversed), NOW);

		expect(panel.rows ?? []).toHaveLength(1);
		expect(rowLaneIds(panel.rows ?? [])).toEqual([current?.taskId]);
		expect(panel.rows?.[0]?.status).toBe("running");
	});

	it("does not let an old failed task report an error for a specialist whose current task is healthy", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-status" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		settleCurrentTask(specialist, "failed");
		queueNextTask(specialist, "recovery task");
		settleCurrentTask(specialist, "completed");

		const panel = buildAgentsPanelModel(overlaySnapshot(lifecycle), NOW);

		expect(lifecycle.getLatestAgentAttempt("worker-1")?.result?.status).toBe("completed");
		expect(panel.status).toBe("info");
	});

	it("counts specialists, not finished tasks, in the workbench team section", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-team" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		// Three finished tasks, nothing active: the Team meta falls to its retained-agent branch.
		settleCurrentTask(specialist, "completed");
		queueNextTask(specialist, "second task");
		settleCurrentTask(specialist, "completed");
		queueNextTask(specialist, "third task");
		settleCurrentTask(specialist, "completed");

		const sections = buildWorkbenchSections(overlaySnapshot(lifecycle), NOW);

		expect(lifecycle.getRecords()).toHaveLength(3);
		expect(lifecycle.getRunningCount()).toBe(0);
		// One idle specialist is one agent, however many tasks it has behind it.
		expect(sectionText(sections, "Team")).toContain("1 agent");
	});

	it("negative control: two specialists each running a task remain two rows", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-distinct" });
		const profile = profileFixture();
		const first = startSpecialist(lifecycle, "worker-1", profile);
		const second = startSpecialist(lifecycle, "worker-2", profile);
		const firstHandle = runCurrentTask(first);
		const secondHandle = runCurrentTask(second);

		const snapshot = overlaySnapshot(lifecycle);
		const panel = buildAgentsPanelModel(snapshot, NOW);

		expect(snapshot.laneRecords.filter(isRetainedWorkerLane)).toHaveLength(2);
		expect(panel.rows ?? []).toHaveLength(2);
		expect(rowLaneIds(panel.rows ?? []).sort()).toEqual([firstHandle.taskId, secondHandle.taskId].sort());
		expect(panel.summary).toContain("2 running");
		expect(buildWorkPanelModel(snapshot, NOW).rows ?? []).toHaveLength(2);
	});

	it("shows no active row for a retained idle specialist while preserving its availability", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-idle" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		settleCurrentTask(specialist, "completed");

		const snapshot = overlaySnapshot(lifecycle);
		const panel = buildAgentsPanelModel(snapshot, NOW);

		expect(lifecycle.getRunningCount()).toBe(0);
		// No active work: nothing queued or running is reported as such.
		expect(panel.summary).not.toContain("1 running");
		expect(panel.summary).not.toContain("1 queued");
		// A retained idle context is availability, not a row: its finished task must not occupy the
		// active panel. Today the finished record is rendered as a row, so this is the intended red.
		expect(panel.rows ?? []).toHaveLength(0);
		// Availability itself is preserved - the specialist is still one agent on the Team section.
		expect(lifecycle.getAgent("worker-1")?.status).toBe("registered");
		expect(sectionText(buildWorkbenchSections(snapshot, NOW), "Team")).toContain("1 agent");
	});

	it("negative control: retiring a specialist removes its availability but keeps its task history", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "roster-retire" });
		const specialist = startSpecialist(lifecycle, "worker-1", profileFixture());
		settleCurrentTask(specialist, "completed");
		queueNextTask(specialist, "second task");
		settleCurrentTask(specialist, "completed");

		lifecycle.retireAgent("worker-1");
		const snapshot = overlaySnapshot(lifecycle);

		expect(snapshot.laneRecords.filter(isRetainedWorkerLane)).toHaveLength(0);
		expect(buildAgentsPanelModel(snapshot, NOW).rows ?? []).toHaveLength(0);
		// History survives retirement: status, evidence and recovery all resolve through these records.
		expect(lifecycle.getRecords()).toHaveLength(2);
		expect(lifecycle.getRecords().every((record) => record.status === "succeeded")).toBe(true);
	});
});
