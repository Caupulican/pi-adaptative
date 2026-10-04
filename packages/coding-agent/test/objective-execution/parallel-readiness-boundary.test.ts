import { randomUUID } from "node:crypto";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerWriteReservationStore } from "../../src/core/delegation/worker-write-reservation.ts";
import { WorkerWriteReservationCoordinator } from "../../src/core/delegation/worker-write-reservation-coordinator.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import {
	evidenceMarkerOf,
	LedgerRouteCheckpoints,
} from "../../src/core/objective-execution/ledger-route-checkpoints.ts";
import {
	COMPLETION_FENCED_REASON_CODE,
	ObjectiveExecutionController,
} from "../../src/core/objective-execution/objective-execution-controller.ts";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import type { ObjectiveRoute } from "../../src/core/objective-execution/objective-route.ts";
import { INDEPENDENT_VERIFICATION_REASON_CODE } from "../../src/core/objective-execution/objective-route-policy.ts";
import type { SemanticRouteJudgments } from "../../src/core/objective-execution/objective-route-projector.ts";
import { RepositoryMutationObserver } from "../../src/core/objective-execution/repository-mutation-observer.ts";
import { DecisionLedgerStore } from "../../src/core/operator-projection/decision-ledger-store.ts";
import type { ExecutionGrant, HarnessCapability } from "../../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import type { AttemptRuntimeState } from "../../src/core/orchestration/task-runtime-state.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	type SystemOneControlDirective,
	sameLaneVerificationDirective,
} from "../../src/core/system-one/control-directive.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { committedRepo } from "../git-fixture.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../orchestration-profile-fixture.ts";
import { tempDir } from "../temp-dir.ts";

const GOAL = "goal:current";

// Ledger SQLite handles and reservation coordinators opened by fixtures are closed after each test,
// passed or failed, before tempDir removes their directories.
const openLedgers: DecisionLedgerStore[] = [];
const openCoordinators: WorkerWriteReservationCoordinator[] = [];
afterEach(() => {
	for (const coordinator of openCoordinators.splice(0)) coordinator.dispose();
	for (const ledger of openLedgers.splice(0)) ledger.close();
});

/** Admitted authority of a running worker: what its execution contract lets it touch. */
interface AuthoritySpec {
	readonly capabilities: readonly HarnessCapability[];
	readonly toolNames: readonly string[];
	readonly writePaths: readonly string[];
	readonly cwd?: string;
}

const UNRELATED_PROFILE_ID = "unrelated-worker";

const READ_ONLY: AuthoritySpec = { capabilities: ["filesystem.read"], toolNames: ["read"], writePaths: [] };

function typedWriter(writePaths: readonly string[], cwd?: string): AuthoritySpec {
	return {
		capabilities: ["filesystem.read", "filesystem.write"],
		toolNames: ["read", "write", "edit"],
		writePaths,
		...(cwd ? { cwd } : {}),
	};
}

function processWorker(writePaths: readonly string[], cwd: string): AuthoritySpec {
	return { capabilities: ["filesystem.read", "process.exec"], toolNames: ["read", "bash"], writePaths, cwd };
}

function executionContractFor(spec: AuthoritySpec) {
	const profile = createTestWorkerOrchestrationProfile({
		profileId: UNRELATED_PROFILE_ID,
		model: { provider: "faux", id: "faux-worker" },
		capabilityCeiling: spec.capabilities,
		toolNames: spec.toolNames,
	});
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: {
				...createTestWorkerExecutionAuthority(profile),
				writePaths: [...spec.writePaths],
				...(spec.cwd ? { cwd: spec.cwd } : {}),
			},
		},
	});
}

interface PendingSupervisionRequest {
	readonly signal_id: string;
	readonly objective_id: string;
	readonly action: string;
	readonly reason_codes?: readonly string[];
}

function fixture(
	options: {
		directive?: SystemOneControlDirective;
		/** Route judgments System One returns, one per evaluation; the last one repeats. */
		judgments?: readonly SemanticRouteJudgments[];
		supervision?: readonly PendingSupervisionRequest[];
		/** Called inside each wait with the attempts joined; the wait resolves when it returns. */
		onWait?: (attempts: readonly AttemptRuntimeState[]) => void;
		/** Called while System One evaluates the route, before it answers. */
		onEvaluate?: () => void;
		/** The objective's workspace; absent means none is bound. Defaults to a fresh directory. */
		workspace?: string | null;
	} = {},
) {
	const dir = tempDir("pi-parallel-readiness-");
	const workspace = options.workspace === undefined ? tempDir("pi-parallel-readiness-workspace-") : options.workspace;
	const store = new OrchestrationEventStore({ agentDir: dir, sessionId: randomUUID() });
	const runtime = new DurableTaskRuntime({ store });
	runtime.createObjective({ objectiveId: GOAL, title: "Current goal", description: "Implement the current goal" });
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
	openLedgers.push(ledger);
	const routes = new LedgerRouteCheckpoints({
		getLedger: () => ledger,
		sessionId: "session-parallel-readiness",
		cwd: dir,
		getSnapshot: () => runtime.getSnapshot(),
	});
	const waits: (readonly AttemptRuntimeState[])[] = [];
	const rootRoutes: ObjectiveRoute[] = [];
	const workerRoutes: ObjectiveRoute[] = [];
	const completionEntries: string[] = [];
	const consumed: string[] = [];
	const judgments = [...(options.judgments ?? [])];
	const controller = new ObjectiveExecutionController({
		runtime: { reconcileObjective: async () => runtime.getSnapshot() },
		...(workspace ? { repoRoot: workspace } : {}),
		checkpoints: routes,
		stalls: routes,
		systemOne: {
			...(options.directive ? { peekControlDirective: () => options.directive } : {}),
			evaluateObjectiveRoute: async () => {
				options.onEvaluate?.();
				return judgments.length > 1 ? judgments.shift()! : (judgments[0] ?? {});
			},
		},
		pendingSupervisionRequests: () =>
			(options.supervision ?? []).filter((request) => !consumed.includes(request.signal_id)),
		consumePendingSupervisionRequest: (signalId) => {
			consumed.push(signalId);
		},
		// The first step of the completion path: entering it means completion was routed and not fenced.
		waitForRepositoryQuiescence: async (objectiveId) => {
			completionEntries.push(objectiveId);
		},
		waiter: {
			wait: async (context) => {
				const inFlight = (context as { inFlightAttempts?: readonly AttemptRuntimeState[] }).inFlightAttempts ?? [];
				waits.push(inFlight);
				options.onWait?.(inFlight);
			},
		},
		rootExecutor: {
			execute: async (route) => {
				rootRoutes.push(route);
			},
		},
		workerDispatcher: {
			dispatch: async (route) => {
				workerRoutes.push(route);
			},
			continueWorker: async () => {},
			dispatchEscalated: async () => {},
		},
	});
	/** Starts a running attempt; without `authority` it carries no admitted authority at all (legacy). */
	const startRunning = (
		objectiveId: string,
		taskId: string,
		options: {
			authority?: AuthoritySpec;
			/** Compiled grant authority bound to the attempt. */
			grant?: Pick<ExecutionGrant, "capabilities" | "allowedTools" | "writePaths">;
			dependsOn?: readonly string[];
		} = {},
	): AttemptRuntimeState => {
		if (!runtime.getSnapshot().objectives[objectiveId]) {
			runtime.createObjective({ objectiveId, title: objectiveId, description: `Work for ${objectiveId}` });
		}
		runtime.createTask({
			taskId,
			objectiveId,
			title: taskId,
			description: `Execute ${taskId}`,
			role: "implementer",
			...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
		});
		const attempt = runtime.queueAttempt(
			taskId,
			{
				taskId,
				profileId: options.authority ? UNRELATED_PROFILE_ID : "worker-default",
				instructions: `Execute ${taskId}`,
				resourcePointerIds: [],
				...(options.authority ? { executionContract: executionContractFor(options.authority) } : {}),
			},
			// A compiled grant is bound below; a bare grant id stands in for legacy attempts.
			options.grant ? undefined : `grant-${taskId}`,
		);
		if (options.grant) {
			runtime.bindAttemptGrant(attempt.attemptId, {
				...createTestExecutionGrant({
					objectiveId,
					taskId,
					attemptId: attempt.attemptId,
					grantId: `grant-${taskId}`,
				}),
				...options.grant,
			});
		}
		const lease = runtime.leaseAttempt(attempt.attemptId, `owner-${taskId}`, 60_000);
		runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		return runtime.getSnapshot().attempts[attempt.attemptId]!;
	};
	return {
		controller,
		runtime,
		waits,
		rootRoutes,
		workerRoutes,
		completionEntries,
		consumed,
		startRunning,
		workspace,
	};
}

const joinedTaskIds = (waits: (readonly AttemptRuntimeState[])[]) => waits.map((wait) => wait.map((a) => a.taskId));

describe("parallel-readiness boundary of the objective loop", () => {
	it("ready work proceeds past an unrelated session-scoped objective's read-only running attempt", async () => {
		const f = fixture();
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
	});

	it("ready work proceeds past a read-only running attempt of an overridden goal whose objective was never cancelled", async () => {
		// /goal override persists only the new goal; the previous objective stays active with its attempts.
		const f = fixture();
		f.startRunning("goal:overridden", "unrelated-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
	});

	it("route evaluation does not report an unrelated read-only running attempt as this objective's worker in flight", async () => {
		const f = fixture();
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		const route = await f.controller.evaluateRouteOnce(GOAL);

		expect(route.route).not.toBe("wait_for_worker");
	});

	it("negative control: this objective's own running attempt still joins before the next route", async () => {
		const f = fixture();
		f.startRunning(GOAL, "own-task");

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([["own-task"]]);
		expect(f.rootRoutes).toEqual([]);
	});

	it("negative control: a running dependency of this objective's pending task still joins", async () => {
		const f = fixture();
		f.startRunning(GOAL, "dependency-task", { authority: READ_ONLY });
		f.runtime.createTask({
			taskId: "dependent-task",
			objectiveId: GOAL,
			title: "Dependent",
			description: "Needs the dependency",
			role: "implementer",
			dependsOn: ["dependency-task"],
		});
		expect(f.runtime.getSnapshot().tasks["dependent-task"]?.task.status).toBe("pending");

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([["dependency-task"]]);
		expect(f.rootRoutes).toEqual([]);
	});

	it("negative control: a cancelled goal's attempts are terminal and never joined", async () => {
		const f = fixture();
		const old = f.startRunning("goal:previous", "previous-task");
		f.runtime.cancelObjective("goal:previous");
		expect(f.runtime.getSnapshot().attempts[old.attemptId]?.status).toBe("cancelled");

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
	});

	it("unresolved same-lane verification runs in the receiving lane despite an unrelated read-only running attempt", async () => {
		const f = fixture({ directive: sameLaneVerificationDirective(["unresolved check"]) });
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["deterministic_test"]);
		expect(f.rootRoutes[0]?.reason_codes).toContain("unresolved check");
	});

	it("negative control: unresolved same-lane verification still waits for this objective's own running attempt", async () => {
		const f = fixture({ directive: sameLaneVerificationDirective(["unresolved check"]) });
		f.startRunning(GOAL, "own-task");

		await f.controller.runCycles(GOAL, 1);

		expect(joinedTaskIds(f.waits)).toEqual([["own-task"]]);
		expect(f.rootRoutes).toEqual([]);
	});

	it("characterization: a new task or attempt moves the evidence marker without new outcome evidence", () => {
		const f = fixture();
		const before = evidenceMarkerOf(f.runtime.getSnapshot(), GOAL);
		f.runtime.createTask({
			taskId: "repair:gate",
			objectiveId: GOAL,
			title: "Repair gate",
			description: "Repair",
			role: "implementer",
		});
		const afterTask = evidenceMarkerOf(f.runtime.getSnapshot(), GOAL);
		f.runtime.queueAttempt(
			"repair:gate",
			{ taskId: "repair:gate", profileId: "worker-default", instructions: "Repair", resourcePointerIds: [] },
			"grant-repair",
		);
		const afterAttempt = evidenceMarkerOf(f.runtime.getSnapshot(), GOAL);

		expect(f.runtime.getSnapshot().objectives[GOAL]?.evidence).toEqual([]);
		expect(afterTask - before).toBe(10);
		expect(afterAttempt - afterTask).toBe(1);
	});
	it("unrelated read-only running work allows implementation and verification but fences completion until it settles", async () => {
		let fencedWaits = 0;
		const f = fixture({
			judgments: [
				{ workRemaining: true, missingWorkClass: "implement" },
				{ workRemaining: true, missingWorkClass: "verify" },
				{ workRemaining: false, missingWorkClass: "none" },
			],
			onWait: () => {
				// The unrelated work settles during the second fenced wait.
				if (++fencedWaits === 2) f.runtime.cancelObjective("session:other");
			},
		});
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 4);

		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement", "verify"]);
		expect(joinedTaskIds(f.waits)).toEqual([["session-task"], ["session-task"]]);
		expect(f.completionEntries).toEqual([]);
		expect(f.controller.getLastRoute()?.route).toBe("wait_for_worker");
		expect(f.controller.getLastRoute()?.reason_codes).toContain(COMPLETION_FENCED_REASON_CODE);

		await f.controller.runCycles(GOAL, 1);

		expect(f.completionEntries).toEqual([GOAL]);
		expect(f.controller.getLastRoute()?.route).toBe("completion_candidate");
		expect(f.waits).toHaveLength(2);
	});

	it("negative control: completion with no running work anywhere enters the completion path directly", async () => {
		const f = fixture({ judgments: [{ workRemaining: false, missingWorkClass: "none" }] });

		await f.controller.runCycles(GOAL, 1);

		expect(f.waits).toEqual([]);
		expect(f.completionEntries).toEqual([GOAL]);
	});

	it("a pending supervision request of an unrelated read-only objective is neither adopted nor acknowledged", async () => {
		const f = fixture({
			supervision: [
				{
					signal_id: "sig-other-verifier",
					objective_id: "session:other",
					action: "request_verifier",
					reason_codes: ["supervision_requested_verifier"],
				},
			],
		});
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 1);

		expect(f.workerRoutes).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
		expect(f.consumed).toEqual([]);
	});

	it("a pending supervision request of an unrelated objective with no running work is not adopted", async () => {
		const f = fixture({
			supervision: [
				{
					signal_id: "sig-other-verifier",
					objective_id: "session:other",
					action: "request_verifier",
					reason_codes: ["supervision_requested_verifier"],
				},
			],
		});

		await f.controller.runCycles(GOAL, 1);

		expect(f.workerRoutes).toEqual([]);
		expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
		expect(f.consumed).toEqual([]);
	});

	it("negative control: this objective's own supervision request is adopted and acknowledged after execution", async () => {
		const f = fixture({
			supervision: [
				{
					signal_id: "sig-own-verifier",
					objective_id: GOAL,
					action: "request_verifier",
					reason_codes: ["supervision_requested_verifier"],
				},
			],
		});
		f.startRunning("session:other", "session-task", { authority: READ_ONLY });

		await f.controller.runCycles(GOAL, 1);

		expect(f.workerRoutes.map((route) => route.route)).toEqual(["verify"]);
		expect(f.workerRoutes[0]?.reason_codes).toContain(INDEPENDENT_VERIFICATION_REASON_CODE);
		expect(f.consumed).toEqual(["sig-own-verifier"]);
	});
	it("a running attempt whose task is absent from the projection fails closed instead of being scoped either way", async () => {
		const f = fixture();
		const running = f.startRunning("session:other", "session-task");
		const snapshot = f.runtime.getSnapshot();
		const { [running.taskId]: _removed, ...tasks } = snapshot.tasks;
		const malformed = new ObjectiveExecutionController({
			runtime: { reconcileObjective: async () => ({ ...snapshot, tasks }) },
			waiter: { wait: async () => {} },
			rootExecutor: { execute: async () => {} },
		});

		await expect(malformed.runCycles(GOAL, 1)).rejects.toThrow(
			`Running attempt '${running.attemptId}' has no task in the runtime projection.`,
		);
		await expect(malformed.evaluateRouteOnce(GOAL)).rejects.toThrow("has no task in the runtime projection");
	});

	it("a mixed supervision queue adopts and acknowledges only the current objective's request", async () => {
		const f = fixture({
			supervision: [
				{
					signal_id: "sig-other-specialist",
					objective_id: "session:other",
					action: "request_specialist",
					reason_codes: ["specialist_gap_detected"],
				},
				{
					signal_id: "sig-own-verifier",
					objective_id: GOAL,
					action: "request_verifier",
					reason_codes: ["supervision_requested_verifier"],
				},
			],
		});

		await f.controller.runCycles(GOAL, 1);

		expect(f.workerRoutes.map((route) => route.route)).toEqual(["verify"]);
		expect(f.workerRoutes[0]?.reason_codes).toContain(INDEPENDENT_VERIFICATION_REASON_CODE);
		expect(f.consumed).toEqual(["sig-own-verifier"]);
	});
	describe("unrelated work is independent only on admitted read-only or enforced disjoint authority", () => {
		const joinsUnrelated = async (f: ReturnType<typeof fixture>) => {
			await f.controller.runCycles(GOAL, 1);
			return { joined: joinedTaskIds(f.waits), routes: f.rootRoutes.map((route) => route.route) };
		};

		it("an unrelated attempt without admitted authority (legacy) is joined", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task");
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("an unrelated typed writer whose canonical scope covers this repository is joined though its cwd is elsewhere", async () => {
			const f = fixture();
			const elsewhere = tempDir("pi-readiness-elsewhere-");
			f.startRunning("session:other", "session-task", {
				authority: typedWriter([join(f.workspace!, "src")], elsewhere),
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it.each([
			["the repository's parent", (workspace: string) => join(workspace, "..")],
			["a machine root", (workspace: string) => parse(workspace).root],
		])("an unrelated typed writer scoped to %s is joined", async (_label, scopeOf) => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				authority: typedWriter([scopeOf(f.workspace!)], tempDir("pi-readiness-elsewhere-")),
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("a relative grant write scope has no base to resolve against and is joined", async () => {
			// Execution contracts admit only absolute scopes; a compiled grant may carry a relative one.
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				grant: { capabilities: ["filesystem.write"], allowedTools: ["write"], writePaths: ["elsewhere/src"] },
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("negative control: a read-only grant with no execution contract is admitted read-only evidence", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				grant: { capabilities: ["filesystem.read"], allowedTools: ["read"], writePaths: [] },
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [], routes: ["implement"] });
		});

		it("an execution contract that is read-only does not hide a mutating compiled grant", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				authority: READ_ONLY,
				grant: { capabilities: ["process.exec"], allowedTools: ["bash"], writePaths: [] },
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("a write scope that is a symlink alias of this repository is joined", async () => {
			const f = fixture();
			const aliases = tempDir("pi-readiness-alias-");
			symlinkSync(f.workspace!, join(aliases, "alias"));
			f.startRunning("session:other", "session-task", { authority: typedWriter([join(aliases, "alias", "src")]) });
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("an unresolvable write scope (a symlink cycle) fails closed and is joined", async () => {
			const f = fixture();
			const loops = tempDir("pi-readiness-loop-");
			symlinkSync(join(loops, "b"), join(loops, "a"));
			symlinkSync(join(loops, "a"), join(loops, "b"));
			f.startRunning("session:other", "session-task", { authority: typedWriter([join(loops, "a", "src")]) });
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("an unrelated process-capable worker is joined even with cwd and write scopes outside this repository", async () => {
			const f = fixture();
			const elsewhere = tempDir("pi-readiness-elsewhere-");
			f.startRunning("session:other", "session-task", { authority: processWorker([elsewhere], elsewhere) });
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("without a bound workspace an unrelated typed writer is joined while read-only work stays independent", async () => {
			const writer = fixture({ workspace: null });
			const elsewhere = tempDir("pi-readiness-elsewhere-");
			writer.startRunning("session:other", "session-task", { authority: typedWriter([elsewhere], elsewhere) });
			expect(await joinsUnrelated(writer)).toEqual({ joined: [["session-task"]], routes: [] });

			const reader = fixture({ workspace: null });
			reader.startRunning("session:other", "session-task", { authority: READ_ONLY });
			expect(await joinsUnrelated(reader)).toEqual({ joined: [], routes: ["implement"] });
		});

		it("an unrelated worker whose contract holds an MCP service capability is joined", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				authority: { capabilities: ["filesystem.read", "service.mcp"], toolNames: ["read"], writePaths: [] },
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it("an unrelated worker whose contract may delegate is joined", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				authority: {
					capabilities: ["filesystem.read", "workflow.delegate"],
					toolNames: ["read", "delegate"],
					writePaths: [],
				},
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
		});

		it.each([
			["network fetching", ["network.http"], ["webfetch"]],
			["an unclassified tool", ["filesystem.read"], ["read", "custom_widget"]],
			["memory or session state mutation", ["memory.mutate"], ["goal"]],
			["planning state mutation", ["workflow.plan"], ["task_steps", "ask_question"]],
		] as const)(
			"an unrelated grant with opaque authority (%s) is joined",
			async (_label, capabilities, allowedTools) => {
				const f = fixture();
				f.startRunning("session:other", "session-task", { grant: { capabilities, allowedTools, writePaths: [] } });
				expect(await joinsUnrelated(f)).toEqual({ joined: [["session-task"]], routes: [] });
			},
		);

		it("negative control: an unrelated grant with proven non-mutating authority stays independent", async () => {
			const f = fixture();
			f.startRunning("session:other", "session-task", {
				grant: {
					capabilities: ["filesystem.read", "repo.read", "memory.query", "semantic.judge"],
					allowedTools: ["read", "grep", "repo_read", "decision_ledger_read"],
					writePaths: [],
				},
			});
			expect(await joinsUnrelated(f)).toEqual({ joined: [], routes: ["implement"] });
		});

		it("negative control: an unrelated typed writer confined to a disjoint canonical scope stays independent", async () => {
			const f = fixture();
			const elsewhere = tempDir("pi-readiness-elsewhere-");
			f.startRunning("session:other", "session-task", { authority: typedWriter([elsewhere], elsewhere) });
			expect(await joinsUnrelated(f)).toEqual({ joined: [], routes: ["implement"] });
		});

		it("readiness is re-read after route evaluation: an overlapping attempt admitted meanwhile is joined", async () => {
			let admitted = false;
			const f = fixture({
				judgments: [{ workRemaining: true, missingWorkClass: "implement" }],
				onEvaluate: () => {
					if (admitted) return;
					admitted = true;
					f.startRunning("session:other", "late-task");
				},
			});

			await f.controller.runCycles(GOAL, 1);

			expect(f.rootRoutes).toEqual([]);
			expect(f.controller.getLastRoute()?.route).toBe("wait_for_worker");
			expect(joinedTaskIds(f.waits)).toEqual([["late-task"]]);
		});
	});

	describe("root mutations beside an unrelated writer", () => {
		const noExtensions = {
			hasHandlers: () => false,
			emitToolCall: async () => undefined,
		} as unknown as ExtensionRunner;

		/** The real root admission and edit tool, observed by the session's repository boundary. */
		function rootWriter(repo: string) {
			const ledger = new ObjectiveMutationLedger();
			const observer = new RepositoryMutationObserver(ledger);
			const gate = new ToolGateController({
				maybeEscalateToolCall: () => undefined,
				getCwd: () => repo,
				getCapabilityEnvelope: () => undefined,
				recordGateOutcome: () => {},
				getExtensionRunner: () => noExtensions,
				repositoryObserver: observer,
				getObjectiveId: () => GOAL,
			});
			const admitted: unknown[] = [];
			const run = async (name: "edit" | "bash", args: Record<string, unknown>) => {
				const assistantMessage = fauxAssistantMessage("");
				const toolCall = fauxToolCall(name, args, { id: `root-${name}-${admitted.length}` });
				const context = { systemPrompt: "test", messages: [], tools: [] };
				const admission = await gate.beforeToolCall({ assistantMessage, toolCall, args, context }, undefined);
				admitted.push(admission);
				if (admission === undefined && name === "edit") {
					await createEditTool(repo).execute(
						toolCall.id,
						args as Parameters<ReturnType<typeof createEditTool>["execute"]>[1],
					);
				}
				await gate.afterToolCall({
					assistantMessage,
					toolCall,
					args,
					context,
					result: { content: [{ type: "text", text: "done" }], details: {} },
					isError: false,
				});
			};
			return { run, admitted, observer, ledger };
		}

		function reserve(agentDir: string, workspace: string, writePath: string) {
			const coordinator = new WorkerWriteReservationCoordinator({
				agentDir,
				getCwd: () => workspace,
				getParentSessionId: () => "other-parent",
				ownerId: `pi-worker:${process.pid}:11111111-1111-4111-8111-111111111111`,
				drainQueuedWorkers: () => {},
				warn: () => {},
			});
			openCoordinators.push(coordinator);
			expect(
				coordinator.acquire(
					"session-task",
					{ attemptId: "session-attempt" },
					{ writeEnabled: true, writePaths: [writePath], cwd: workspace },
				),
			).toEqual({ kind: "granted" });
		}

		function stillReserved(agentDir: string, workspace: string, writePath: string): boolean {
			const probe = new WorkerWriteReservationStore({ agentDir }).acquire({
				parentSessionId: "probe-parent",
				ownerId: `pi-worker:${process.pid}:22222222-2222-4222-8222-222222222222`,
				taskId: "probe",
				attemptId: "probe-attempt",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot: workspace, executionRoot: workspace },
				writeScopes: [writePath],
			});
			return probe.kind === "blocked";
		}

		function implementOnRoot(repo: string, oldText: string) {
			const root = rootWriter(repo);
			const f = fixture({ workspace: repo, judgments: [{ workRemaining: true, missingWorkClass: "implement" }] });
			f.controller.bindSessionExecutors({
				rootExecutor: {
					execute: async (route) => {
						f.rootRoutes.push(route);
						await root.run("edit", { path: "README.md", edits: [{ oldText, newText: "root edit" }] });
					},
				},
			});
			return { f, root };
		}

		it("collision prevented: a root edit is not routed while an unrelated writer holds and edits a file in this repository", async () => {
			const repo = committedRepo("pi-root-collision-");
			const agentDir = tempDir("pi-root-collision-agent-");
			const shared = join(repo, "README.md");
			const { f, root } = implementOnRoot(repo, "worker edit");
			f.startRunning("session:other", "session-task", { authority: typedWriter([shared], repo) });
			reserve(agentDir, repo, shared);
			writeFileSync(shared, "worker edit\n");

			await f.controller.runCycles(GOAL, 1);

			expect(joinedTaskIds(f.waits)).toEqual([["session-task"]]);
			expect(f.rootRoutes).toEqual([]);
			expect(root.admitted).toEqual([]);
			expect(readFileSync(shared, "utf8")).toBe("worker edit\n");
			expect(stillReserved(agentDir, repo, shared)).toBe(true);
		});

		it("remaining tool-admission gap: root shell admission itself does not consult a foreign write reservation", async () => {
			const repo = committedRepo("pi-root-shell-collision-");
			const agentDir = tempDir("pi-root-shell-collision-agent-");
			reserve(agentDir, repo, join(repo, "README.md"));
			const root = rootWriter(repo);

			await root.run("bash", { command: "printf 'root edit\\n' > README.md" });

			expect(root.admitted).toEqual([undefined]);
			expect(stillReserved(agentDir, repo, join(repo, "README.md"))).toBe(true);
		});

		it("negative control: an unrelated read-only worker leaves root edits legitimately unobstructed", async () => {
			const repo = committedRepo("pi-root-readonly-");
			const { f, root } = implementOnRoot(repo, "one");
			f.startRunning("session:other", "session-task", { authority: READ_ONLY });

			await f.controller.runCycles(GOAL, 1);

			expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
			expect(root.admitted).toEqual([undefined]);
			expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("root edit\n");
			expect(root.ledger.provenOwnedPaths(GOAL)).toEqual(["README.md"]);
		});

		it("negative control: an unrelated typed writer confined to another worktree is disjoint from root edits", async () => {
			const repo = committedRepo("pi-root-isolated-");
			const isolated = committedRepo("pi-root-isolated-worker-");
			const agentDir = tempDir("pi-root-isolated-agent-");
			const { f } = implementOnRoot(repo, "one");
			f.startRunning("session:other", "session-task", { authority: typedWriter([isolated], isolated) });
			reserve(agentDir, isolated, join(isolated, "README.md"));
			writeFileSync(join(isolated, "README.md"), "worker edit\n");

			await f.controller.runCycles(GOAL, 1);

			expect(f.rootRoutes.map((route) => route.route)).toEqual(["implement"]);
			expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("root edit\n");
			expect(readFileSync(join(isolated, "README.md"), "utf8")).toBe("worker edit\n");
			expect(stillReserved(agentDir, isolated, join(isolated, "README.md"))).toBe(true);
		});
	});
});
