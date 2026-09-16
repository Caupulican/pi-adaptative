/**
 * Automatic native specialist reuse inside one parent session.
 *
 * Every case drives the REAL admission owners through their public entrances -- the session's
 * `runWorkerDelegationOnce` and the execution-plane controller's `startWorkerDelegation` /
 * `startWorkerAgentTask` (i.e. `WorkerDelegationController.runOnce` / `.start` and
 * `WorkerAgentControlCoordinator`) over a real `WorkerLifecycle`, real `WorkerConversationStore` and
 * the real durable ledger. Only the provider is deterministic, and every provider request is
 * captured: reuse is asserted on the CONTEXT THE WORKER ACTUALLY RECEIVED, not on disk contents or
 * identity strings alone.
 *
 * Today a second unnamed task mints a second logical identity whose provider request carries none of
 * the first task's conversation, so the "same specialist" assertions fail against real behaviour
 * rather than a missing symbol. The proposed `parallelWork` intent is passed structurally against the
 * existing request type: unknown fields are ignored today, so an assertion fails, never a compile.
 *
 * The quiescence case holds the REAL `toolSurface.dispose()` (worker-delegation-controller.ts:2729,
 * inside the execution `finally`, after `inFlightLedgers`/`laneAbortControllers` are already deleted)
 * by wrapping the external `createLaneToolSurface` factory port. Nothing private is replaced.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LaneToolSurfaceModule from "../src/core/autonomy/lane-tool-surface.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { MAX_ORCHESTRATION_AGENT_BINDINGS } from "../src/core/orchestration/contracts.ts";
import { createReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

/**
 * Deterministic barrier on the worker's real tool-surface disposal. `createLaneToolSurface` is the
 * external factory the controller calls; the wrapper delegates to the real one and only delays its
 * `dispose()` while a test holds the gate.
 */
const disposeGate: { hold: boolean; entered?: () => void; release?: () => void } = { hold: false };

vi.mock("../src/core/autonomy/lane-tool-surface.ts", async (importOriginal) => {
	const original = (await importOriginal()) as typeof LaneToolSurfaceModule;
	return {
		...original,
		createLaneToolSurface: (options: Parameters<typeof original.createLaneToolSurface>[0]) => {
			const surface = original.createLaneToolSurface(options);
			return {
				...surface,
				dispose: async () => {
					if (disposeGate.hold) {
						disposeGate.entered?.();
						await new Promise<void>((resolve) => {
							disposeGate.release = resolve;
						});
					}
					return surface.dispose();
				},
			};
		},
	};
});

/** Arm the barrier and hand back its entry promise plus its release. */
function holdDisposal(): { entered: Promise<void>; release: () => void } {
	let announce!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	disposeGate.hold = true;
	disposeGate.entered = announce;
	return {
		entered,
		release: () => {
			disposeGate.hold = false;
			disposeGate.release?.();
			disposeGate.release = undefined;
		},
	};
}

/**
 * Explicit independent-parallel intent, proposed on the existing request. It is a caller intent,
 * never authority: every ordinary admission constraint still applies to whatever it admits.
 */
type ProposedDelegationRequest = WorkerDelegationRequest & {
	parallelWork?: { independentOf: readonly string[]; justification: string };
};

function agentIdOf(record: LaneRecord | undefined): string | undefined {
	return record?.agentId;
}

/** A started lane that actually reached a terminal status, with its durable identity. */
function assertCompleted(record: LaneRecord | undefined, label: string): LaneRecord {
	if (!record) throw new Error(`${label} produced no lane record`);
	expect(`${label}:${record.status}`).toBe(`${label}:succeeded`);
	expect(record.agentId).toBeDefined();
	return record;
}

beforeEach(() => {
	disposeGate.hold = false;
	disposeGate.entered = undefined;
	disposeGate.release = undefined;
});

afterEach(() => {
	disposeGate.hold = false;
	disposeGate.release?.();
	disposeGate.release = undefined;
});

describe("automatic native specialist reuse", () => {
	it("gives the second unnamed task the first task's own conversation", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("mapped the retry ladder");
		context.appendWorkerReply("summarized the lease fences");

		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Map the retry ladder" });
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Summarize the lease fences",
		});

		assertCompleted(first.record, "first task");
		assertCompleted(second.record, "second task");
		expect(agentIdOf(second.record)).toBe(agentIdOf(first.record));
		expect(second.record?.laneId).not.toBe(first.record?.laneId);
		expect(Object.keys(context.agents())).toHaveLength(1);
		// The provider request is the evidence: the second turn must carry the first brief, the first
		// answer, and its own new brief.
		const workerRequests = context.workerRequests();
		expect(workerRequests).toHaveLength(2);
		const secondRequest = workerRequests[1]!;
		expect(secondRequest.text).toContain("Map the retry ladder");
		expect(secondRequest.text).toContain("mapped the retry ladder");
		expect(secondRequest.text).toContain("Summarize the lease fences");
		expect(secondRequest.roles).toContain("assistant");
		expect(context.transcriptFiles()).toHaveLength(1);
	});

	it("negative control: a differently scoped specialist starts clean and never sees the other's history", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("inspected the default scope");
		context.appendWorkerReply("inspected the narrowed scope");
		const scoped = join(context.harness.tempDir, "scoped-project");
		mkdirSync(scoped, { recursive: true });

		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Inspect the default scope",
		});
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Inspect the narrowed scope",
			authority: { path: scoped },
		});

		assertCompleted(first.record, "default-scope task");
		assertCompleted(second.record, "narrowed-scope task");
		expect(agentIdOf(second.record)).not.toBe(agentIdOf(first.record));
		expect(Object.keys(context.agents())).toHaveLength(2);
		const secondRequest = context.workerRequests()[1]!;
		expect(secondRequest.text).toContain("Inspect the narrowed scope");
		expect(secondRequest.text).not.toContain("Inspect the default scope");
		expect(secondRequest.text).not.toContain("inspected the default scope");
	});

	it("reuses the same specialist through the asynchronous start entrance", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("charted the write reservations");
		context.appendWorkerReply("charted the lease renewals");

		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Chart the write reservations",
		});
		const started = await context.lanes().startWorkerDelegation({ instructions: "Chart the lease renewals" });
		await context.settleLanes();

		assertCompleted(first.record, "first task");
		expect(started.started ? "started" : started.skipReason).toBe("started");
		if (!started.started) throw new Error("second start was refused");
		// Both public entrances allocate through one decision: no second specialist.
		expect(agentIdOf(started.record)).toBe(agentIdOf(first.record));
		expect(Object.keys(context.agents())).toHaveLength(1);
		expect(context.workerRequests()[1]?.text).toContain("Chart the write reservations");
	});

	it("reuses one specialist when both tasks carry equal effective explicit options", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("audited the read paths");
		context.appendWorkerReply("audited the lease paths");

		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Audit the read paths",
			authority: { readOnly: true, toolNames: ["read", "grep"] },
		});
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Audit the lease paths",
			// Same effective admission, written in the other order: an authoritative grant is a set.
			authority: { readOnly: true, toolNames: ["grep", "read"] },
		});

		assertCompleted(first.record, "first audit");
		assertCompleted(second.record, "second audit");
		expect(agentIdOf(second.record)).toBe(agentIdOf(first.record));
		expect(Object.keys(context.agents())).toHaveLength(1);
	});

	it("negative control: a narrower tool grant is a different specialization that actually runs", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("ran with the inherited grant");
		context.appendWorkerReply("ran with the narrowed grant");

		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Run with the full grant" });
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Run with the narrowed grant",
			authority: { toolNames: ["read"] },
		});

		assertCompleted(first.record, "full-grant task");
		assertCompleted(second.record, "narrow-grant task");
		expect(agentIdOf(second.record)).not.toBe(agentIdOf(first.record));
		expect(Object.keys(context.agents())).toHaveLength(2);
	});

	it("still reuses an idle specialist when the logical fleet has no fresh identity headroom", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("held the only specialization");
		context.appendWorkerReply("reused the idle specialization");
		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Hold the only specialization",
		});
		const reusable = agentIdOf(assertCompleted(first.record, "first task"));

		// Fill the durable fleet through its own public owner, so only FRESH identity headroom is gone.
		const filler = new WorkerLifecycle({
			agentDir: context.harness.tempDir,
			sessionId: context.harness.sessionManager.getSessionId(),
		});
		const occupied = Object.keys(filler.getTaskRuntimeSnapshot().agents).length;
		for (let index = occupied; index < MAX_ORCHESTRATION_AGENT_BINDINGS; index++) {
			filler.ensureAgent({
				agentId: `fleet-filler-${index}`,
				role: "implementer",
				resumeContext: {
					provider: "pi",
					sessionId: `fleet-filler-${index}`,
					cwd: context.harness.tempDir,
					resourceProfileNames: [],
					contextPointers: [],
				},
			});
		}

		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Reuse the idle specialization",
		});

		// A reused turn consumes no fresh identity slot, so a full fleet must not block it.
		expect(second.skipReason).toBeUndefined();
		expect(agentIdOf(assertCompleted(second.record, "reused task"))).toBe(reusable);
	});

	it("does not mint a second specialist while the compatible one is still busy", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		const gate = context.appendWorkerHold("held the compatible lane");
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the compatible lane" });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");
			const attemptsBefore = context.attempts().length;

			const second = await context.lanes().startWorkerDelegation({ instructions: "Ask for compatible work" });

			// Busy is a bounded answer about the existing specialist, never a duplicate of it, and it
			// creates no durable attempt or transcript of its own.
			expect(Object.keys(context.agents())).toHaveLength(1);
			expect(second.started).toBe(false);
			expect(context.attempts()).toHaveLength(attemptsBefore);
			expect(context.transcriptFiles()).toHaveLength(1);
			gate.release();
			await running;
		} finally {
			gate.release();
		}
	});

	it("negative control: a busy specialist with a different effective grant admits a fresh one", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		const gate = context.appendWorkerHold("held the busy lane");
		context.appendWorkerReply("ran the differently granted lane");
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the busy lane" });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");

			const fresh = await context.lanes().startWorkerDelegation({
				instructions: "Run read-only work",
				authority: { readOnly: true },
			});
			gate.release();
			await running;
			await context.settleLanes();

			expect(fresh.started ? "started" : fresh.skipReason).toBe("started");
			if (!fresh.started) throw new Error("differently granted start was refused");
			const settled = context.laneRecords().find((record) => record.laneId === fresh.record.laneId);
			assertCompleted(settled, "differently granted task");
			expect(Object.keys(context.agents())).toHaveLength(2);
		} finally {
			gate.release();
		}
	});

	it("admits an explicitly justified independent parallel copy under ordinary constraints", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		const gate = context.appendWorkerHold("held the surveyed lane");
		context.appendWorkerReply("ran the parallel survey");
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: "Survey the retry ladder" });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");
			const busyAgentId = agentIdOf(context.laneRecords()[0]);
			expect(busyAgentId).toBeDefined();

			const parallel: ProposedDelegationRequest = {
				instructions: "Survey the retry ladder",
				parallelWork: {
					independentOf: [busyAgentId ?? ""],
					justification: "Two independent reviewers must not share one context.",
				},
			};
			const started = await context.lanes().startWorkerDelegation(parallel);
			gate.release();
			await running;
			await context.settleLanes();

			// Explicit independent intent keeps ordinary admission; it is not silenced by the duplicate
			// heuristic. The refusal reason is surfaced verbatim so the red names its gate.
			expect(started.started ? "started" : started.skipReason).toBe("started");
			if (!started.started) throw new Error("parallel start was refused");
			assertCompleted(
				context.laneRecords().find((record) => record.laneId === started.record.laneId),
				"parallel task",
			);
			expect(Object.keys(context.agents())).toHaveLength(2);
		} finally {
			gate.release();
		}
	});

	it("negative control: independent parallel intent cannot widen a grant or bypass capacity", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 1 } } });
		const gate = context.appendWorkerHold("held the only concurrent slot");
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the only slot" });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");

			const widened: ProposedDelegationRequest = {
				instructions: "Use a tool this session does not grant",
				authority: { toolNames: ["run_process"] },
				parallelWork: { independentOf: [], justification: "Independent verification of the same area." },
			};
			const refusedGrant = await context.lanes().startWorkerDelegation(widened);
			const queued: ProposedDelegationRequest = {
				instructions: "Second concurrent survey",
				parallelWork: { independentOf: [], justification: "Independent second pass." },
			};
			const capacityBound = await context.lanes().startWorkerDelegation(queued);

			// Intent is not authority: an ungranted tool is still refused, and a capacity-bound start is
			// still queued rather than run beside the busy lane.
			expect(refusedGrant.started).toBe(false);
			expect(capacityBound.started ? capacityBound.record.status : "refused").not.toBe("running");
			expect(context.workerRequests()).toHaveLength(1);
			gate.release();
			await running;
			await context.settleLanes();
		} finally {
			gate.release();
		}
	});

	it("does not silently choose between two equally compatible idle specialists", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		context.appendWorkerReply("first reviewer done");
		context.appendWorkerReply("second reviewer done");
		context.appendWorkerReply("third task done");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Review the lease fences" });
		const explicitParallel: ProposedDelegationRequest = {
			instructions: "Review the lease fences again",
			parallelWork: {
				independentOf: [agentIdOf(first.record) ?? ""],
				justification: "A deliberately independent second reviewer.",
			},
		};
		const second = await context.harness.session.runWorkerDelegationOnce(explicitParallel);
		assertCompleted(first.record, "first reviewer");
		assertCompleted(second.record, "second reviewer");
		expect(Object.keys(context.agents())).toHaveLength(2);
		const identitiesBefore = Object.keys(context.agents()).sort();

		const ambiguous = await context.lanes().startWorkerDelegation({ instructions: "Do more of the same work" });
		await context.settleLanes();

		// Two equally compatible idle specialists is an ambiguity the host cannot resolve silently: it
		// must neither pick one by accident nor mint a third identity.
		expect(ambiguous.started).toBe(false);
		expect(Object.keys(context.agents()).sort()).toEqual(identitiesBefore);
	});

	it("collapses two concurrent unnamed starts onto one specialist", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("concurrent left done");
		context.appendWorkerReply("concurrent right done");

		const [left, right] = await Promise.all([
			context.lanes().startWorkerDelegation({ instructions: "Concurrent left brief" }),
			context.lanes().startWorkerDelegation({ instructions: "Concurrent right brief" }),
		]);
		await context.settleLanes();

		// The asynchronous directory-capture window must not admit two identical specialists.
		expect(Object.keys(context.agents())).toHaveLength(1);
		expect([left, right].filter((outcome) => outcome.started).length).toBeGreaterThanOrEqual(1);
	});

	it("starts no overlapping work while the finished task's tool surface is still being disposed", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("finished the first task");
		context.appendWorkerReply("follow-on task done");
		const gate = holdDisposal();
		try {
			const running = context.harness.session.runWorkerDelegationOnce({
				instructions: "Finish and publish a terminal",
			});
			// The controller publishes the durable terminal and deletes its in-flight bookkeeping BEFORE
			// awaiting disposal; the barrier holds execution exactly inside that window.
			await gate.entered;
			const terminal = context.laneRecords()[0];
			expect(terminal?.status).toBe("succeeded");
			const agentId = agentIdOf(terminal) ?? "";
			const attemptsWhileHeld = context.attempts().length;
			const requestsWhileHeld = context.workerRequests().length;

			const anonymous = await context.lanes().startWorkerDelegation({ instructions: "Follow-on unnamed work" });
			const explicit = context.lanes().startWorkerAgentTask(agentId, "Follow-on explicit work");

			// Nothing may execute or be accepted onto this specialist until its cleanup settles.
			expect(context.workerRequests()).toHaveLength(requestsWhileHeld);
			expect(context.attempts()).toHaveLength(attemptsWhileHeld);
			expect(Object.keys(context.agents())).toHaveLength(1);
			expect(anonymous.started).toBe(false);
			expect(explicit.started).toBe(false);

			gate.release();
			await running;
			await context.settleLanes();

			// After release the same specialist takes new work, and it runs.
			const resumed = context.lanes().startWorkerAgentTask(agentId, "Follow-on explicit work");
			await context.settleLanes();
			expect(resumed.messageId).not.toBe("");
			expect(Object.keys(context.agents())).toHaveLength(1);
			expect(context.workerRequests().length).toBeGreaterThan(requestsWhileHeld);
		} finally {
			gate.release();
		}
	});

	it("refuses to silently replace a specialist whose compatible transcript is unreadable", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("recorded the first brief");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Record the first brief" });
		assertCompleted(first.record, "first task");
		const transcripts = context.transcriptFiles();
		expect(transcripts).toHaveLength(1);
		writeFileSync(transcripts[0]!, "{not json\n", "utf-8");

		const second = await context
			.lanes()
			.startWorkerDelegation({ instructions: "Continue on the corrupt transcript" })
			.catch((error: unknown) => ({ started: false as const, skipReason: String(error) }));

		// A corrupt transcript is an error about this specialist, not a reason to quietly create a
		// second one and lose its history.
		expect(second.started).toBe(false);
		expect(Object.keys(context.agents())).toHaveLength(1);
	});

	it("negative control: a retired specialist is never revived by a later unnamed task", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("did the retiring task");
		context.appendWorkerReply("did the later task");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Do the retiring task" });
		const retiredAgentId = agentIdOf(assertCompleted(first.record, "retiring task")) ?? "";
		context.lanes().retireWorkerAgent(retiredAgentId);

		const second = await context.harness.session.runWorkerDelegationOnce({ instructions: "Do the later task" });

		// A retired context is never resumed; the later task is an explicitly admitted distinct
		// identity that actually ran.
		const later = assertCompleted(second.record, "later task");
		expect(agentIdOf(later)).not.toBe(retiredAgentId);
		expect(context.agents()[retiredAgentId]?.status).toBe("retired");
		expect(context.workerRequests()[1]?.text).not.toContain("Do the retiring task");
	});

	it("negative control: a suspended specialist is not auto-resumed by new unnamed work", async () => {
		const context = await createReuseHarness();
		const gate = context.appendWorkerHold("held the interrupted lane");
		context.appendWorkerReply("did the unrelated new work");
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the interrupted lane" });
			await gate.entered;
			const suspendedAgentId = agentIdOf(context.laneRecords()[0]) ?? "";
			const interrupted = context.lanes().interruptWorkerAgent(suspendedAgentId);
			expect(interrupted.interrupted).toBe(true);
			gate.release();
			await running;
			expect(context.lanes().getWorkerAgentActivity(suspendedAgentId)).toBe("suspended");

			const fresh = await context.harness.session.runWorkerDelegationOnce({ instructions: "Do unrelated new work" });

			// An interrupted specialist resumes only on an explicit resume; new work never revives it.
			const admitted = assertCompleted(fresh.record, "new work");
			expect(agentIdOf(admitted)).not.toBe(suspendedAgentId);
			expect(context.lanes().getWorkerAgentActivity(suspendedAgentId)).toBe("suspended");
			expect(context.workerRequests().at(-1)?.text).not.toContain("Hold the interrupted lane");
		} finally {
			gate.release();
		}
	});

	it("keeps a specialist's birth context when a later task omits forkTurns", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("born with parent context");
		context.appendWorkerReply("continued without a new fork");
		await context.harness.session.prompt("The lease fence rewrite is the current parent thread.", {
			autoContinueGoal: false,
		});

		const born = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start from the parent thread",
			forkTurns: "all",
		});
		const bornRecord = assertCompleted(born.record, "born-with-context task");
		const bornRequest = context.workerRequests()[0]!;
		expect(bornRequest.text).toContain("lease fence rewrite");

		const continued = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Continue that work without a new fork",
		});

		// Omitting forkTurns asks for no NEW parent snapshot; it does not erase the birth context this
		// specialist already has, and it is not a reason to allocate a fresh identity.
		const continuedRecord = assertCompleted(continued.record, "continuation task");
		expect(agentIdOf(continuedRecord)).toBe(agentIdOf(bornRecord));
		const continuedRequest = context.workerRequests()[1]!;
		expect(continuedRequest.text).toContain("lease fence rewrite");
		expect(continuedRequest.text).toContain("Continue that work without a new fork");
	});

	it("negative control: an explicit different birth fork is a distinct initialization with real parent content", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("started without parent context");
		context.appendWorkerReply("started with parent context");
		await context.harness.session.prompt("The retry ladder census is the current parent thread.", {
			autoContinueGoal: false,
		});

		const plain = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start with no parent context",
		});
		const forked = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start with the parent thread",
			forkTurns: "all",
		});

		const plainRecord = assertCompleted(plain.record, "unforked task");
		const forkedRecord = assertCompleted(forked.record, "forked task");
		expect(agentIdOf(forkedRecord)).not.toBe(agentIdOf(plainRecord));
		// The explicit fork must actually carry the parent's messages, not an empty parent.
		expect(context.workerRequests()[0]?.text).not.toContain("retry ladder census");
		expect(context.workerRequests()[1]?.text).toContain("retry ladder census");
	});
});
