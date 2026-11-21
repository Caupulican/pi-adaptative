import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ownerOrchestrationHome } from "../src/core/agent-paths.ts";
import { storedOutcomeFromValue } from "../src/core/delegation/worker-outcome-codec.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { settleVote } from "../src/core/plan/joins.ts";
import { PlanExecutor, type PlanExecutorDeps } from "../src/core/plan/plan-executor.ts";
import { PLAN_RECORD_VERSION, type PlanNodeSpec, type PlanRecord } from "../src/core/plan/plan-graph.ts";
import { MergeLandings } from "../src/core/plan/plan-merge.ts";

const at = "2026-11-20T00:00:00.000Z";
const eventTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(["vote", "merge"] as const)(
	"holds a failed async %s settlement until a new explicit node version",
	async (kind) => {
		await checkErrorHold(kind, false);
	},
);

it.each(["vote", "merge"] as const)("does not redrain %s when writing its failure hold also throws", async (kind) => {
	await checkErrorHold(kind, true);
});

async function checkErrorHold(kind: "vote" | "merge", holdFails: boolean): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-plan-join-hold-"));
	const home = ownerOrchestrationHome(dir);
	const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId: "parent" });
	const runtime = new DurableTaskRuntime({ store });
	const { objectiveId } = runtime.createObjective({
		title: "Combine two reports",
		description: "Keep the requested result bounded",
	});
	const planId = "pl-12345678";
	const memberIds = ["first", "second"];
	const memberNodes: PlanNodeSpec[] = memberIds.map((id) => ({
		id,
		kind: "work",
		intent: `Report ${id}`,
		inputs: [],
		after: [],
		writeScope: [],
		requirementIds: [],
		effort: "normal",
		since: 1,
	}));
	const joinNode: PlanNodeSpec = {
		id: "combine",
		kind,
		intent: "Combine the reports",
		inputs: memberIds,
		after: [],
		writeScope: [],
		requirementIds: [],
		effort: "normal",
		since: 1,
		join: { members: memberIds, ...(kind === "vote" ? { criteria: ["Report is complete"] } : {}) },
	};
	const record: PlanRecord = {
		v: PLAN_RECORD_VERSION,
		planId,
		objectiveId,
		version: 1,
		title: "Two reports",
		nodes: [...memberNodes, joinNode],
		final: "combine",
		rootOwned: [],
		status: "active",
		unjudged: true,
		judgments: [],
		createdAt: at,
		revisedAt: at,
	};
	runtime.recordPlan(record);
	for (const nodeId of memberIds) {
		const taskId = `task-${nodeId}`;
		runtime.prepareTaskAttempt(
			{ taskId, objectiveId, title: nodeId, description: `Report ${nodeId}`, role: "explorer" },
			{ taskId, profileId: "reader", instructions: `Report ${nodeId}`, resourcePointerIds: [] },
		);
		runtime.releasePlanNode({
			planId,
			nodeId,
			version: 1,
			taskId,
			placement: { kind: "local_worker" },
			exit: "here",
		});
		const outcome = runtime.recordTaskOutcome(taskId, ({ generation, outcomeId }) => ({
			v: 1,
			outcomeId,
			generation,
			nodeId,
			taskId,
			objectiveId,
			scope: "lane",
			status: "succeeded",
			blocker: "none",
			attribution: "none",
			sourceCodes: [],
			coverage: { required: [], covered: [], uncovered: [] },
			assurance: "host_verified",
			artifacts: [],
			changedFiles: [],
			cost: { usd: 0, metered: false, inputTokens: 0, outputTokens: 0 },
			durationMs: 0,
			attempts: [],
			nextAction: { kind: "accept" },
			ladder: { rung: 0, exit: "accept" },
			recordedAt: at,
		}))!;
		runtime.settlePlanNode({ planId, nodeId, outcomeId: outcome.outcomeId, generation: outcome.generation });
	}
	if (kind === "vote") {
		const snapshot = runtime.getSnapshot();
		const result = settleVote(
			snapshot,
			snapshot.plans[planId]!,
			record,
			joinNode,
			{ outcomeId: "outcome-vote", generation: 1, recordedAt: at, artifact: "vote.json" },
			{ kind: "read_all", gaps: ["The vote received no rubric judgment."] },
		);
		expect(result.outcome).toMatchObject({
			status: "partial",
			blocker: "needs_root_answer",
			attribution: "task",
			assurance: "unverified",
			nextAction: { kind: "ask_root" },
		});
		expect(storedOutcomeFromValue(result.outcome, "inconclusive vote")).toEqual(result.outcome);
	}
	const unrelated: PlanRecord = { ...record, planId: "pl-abcdef01", nodes: [memberNodes[0]!], final: "first" };
	runtime.recordPlan(unrelated);
	runtime.holdPlanNode({
		planId: unrelated.planId,
		nodeId: "first",
		reason: "replan",
		detail: "Unrelated held work",
		generation: 1,
	});
	let candidateChange: (() => void) | undefined;
	const unexpectedRelease = vi.fn((): never => {
		throw new Error("No new worker belongs to a failed join");
	});
	const fleet: ReturnType<PlanExecutorDeps["fleet"]> = {
		prepare: unexpectedRelease,
		admit: unexpectedRelease,
		cancel: vi.fn(),
		releasePrepared: vi.fn(),
		room: () => ({
			runnableNow: 1,
			readyWindowFree: 1,
			queued: 0,
			throughputPerMin: 1,
			etaMs: () => 0,
			perAccount: [],
			revision: 1,
		}),
		subscribeRoom: () => () => {},
		placementCandidates: () => [],
		boundMachine: () => undefined,
		hasRemoteBackend: () => false,
		subscribeCandidates: (listener) => {
			candidateChange = listener;
			return () => {
				candidateChange = undefined;
			};
		},
	};
	const deps: PlanExecutorDeps = {
		runtime: () => runtime,
		subscribeStore: (listener) => store.subscribe(() => listener()),
		fleet: () => fleet,
		workerWrites: unexpectedRelease,
		engine: () => undefined,
		goal: () => undefined,
		sessionId: () => "parent",
		orchestrationHome: () => home,
		rootEntries: () => [],
		captureOrigin: () => ({ sessionId: "parent", leafId: "owner" }),
		workerClaim: () => undefined,
		deliver: async () => undefined,
		isDelivered: () => true,
		acknowledge: vi.fn(),
		retireWorker: vi.fn(),
		planChanged: vi.fn(),
		observeNotice: vi.fn(),
	};
	const executor = new PlanExecutor(deps);
	let joins = 0;
	let intendedVersion = 1;
	let nextAttempt!: () => void;
	const attempted = () =>
		new Promise<void>((resolve) => {
			nextAttempt = resolve;
		});
	const settle = vi.spyOn(runtime, "settlePlanJoin").mockImplementation(() => {
		joins++;
		if (joins > intendedVersion) executor.dispose();
		nextAttempt();
		throw new Error("scripted join commit failure");
	});
	const hold = holdFails
		? vi.spyOn(runtime, "holdPlanNode").mockImplementation(() => {
				throw new Error("scripted hold commit failure");
			})
		: undefined;
	const landing =
		kind === "merge"
			? vi.spyOn(MergeLandings.prototype, "start").mockResolvedValue({ kind: "landed", files: [] })
			: undefined;
	try {
		let pending = attempted();
		executor.start();
		await pending;
		await eventTurn();
		expect(joins).toBe(1);
		const held = () => runtime.getSnapshot().plans[planId]?.nodes.combine?.held;
		if (holdFails) expect(held()).toBeUndefined();
		else
			expect(held()).toMatchObject({
				reason: "replan",
				detail: expect.stringContaining("scripted join commit failure"),
			});
		for (let event = 0; event < 3; event++) {
			runtime.recordPlan({ ...unrelated, version: event + 2 });
			candidateChange?.();
			executor.noteGoalChanged();
			await eventTurn();
		}
		expect(joins).toBe(1);
		if (!holdFails) {
			const reopened = new DurableTaskRuntime({
				store: new OrchestrationEventStore({ orchestrationHome: home, sessionId: "parent" }),
			});
			expect(reopened.getSnapshot().plans[planId]?.nodes.combine?.held).toEqual(held());
		}
		intendedVersion = 2;
		pending = attempted();
		runtime.recordPlan({
			...record,
			version: 2,
			nodes: [...memberNodes, { ...joinNode, since: 2 }],
			revisedAt: "2026-11-20T00:01:00.000Z",
		});
		await pending;
		await eventTurn();
		expect(joins).toBe(2);
		expect(unexpectedRelease).not.toHaveBeenCalled();
	} finally {
		executor.dispose();
		settle.mockRestore();
		hold?.mockRestore();
		landing?.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
}
