/**
 * What makes two native starts the SAME specialization, and what must keep them apart.
 *
 * Every case drives the session's real entrances -- `runWorkerDelegationOnce` and the execution-plane
 * controller's `startWorkerDelegation` -- over the real `WorkerDelegationController`, real
 * `WorkerLifecycle` and the real durable ledger. Reuse is asserted on the CONTEXT THE WORKER
 * ACTUALLY RECEIVED, so an identity string alone never stands in for a shared conversation, and an
 * isolation control only counts when the distinguishing option was actually ADMITTED and actually
 * RAN: a refusal proves nothing about specialization.
 *
 * Four invariants are grouped here:
 * - an effective GRANT decides specialization, and the duplicate-TEXT heuristic is only a courtesy
 *   for the parent. Same words under a different admitted grant is different work and must run;
 * - an explicit birth fork states which parent snapshot a specialist is born from. Two starts that
 *   capture the same parent snapshot describe the same initialization; a start made after the parent
 *   transcript moved describes a different one;
 * - resolving physical workspace identity is I/O, so the decision spans an await. What the owner
 *   binds afterwards must reflect the state at the END of that await; a caller who walked away
 *   meanwhile must get nothing, and an identity that never resolves must end in a bounded answer;
 * - a specialist's admitted resources are MATERIALIZED content, not just a URI. While that content is
 *   unchanged the specialist is the same one; once it changes, the work must still be able to run.
 *
 * The identity await is held open deterministically by wrapping the EXTERNAL directory-backend
 * factory: the real backend does the real work, and only its stable-nonce namespace call is delayed,
 * through the same `awaitPreflight(work, signal)` the real `createAttachmentId` uses, so the backend's
 * abort contract is preserved. There are no sleeps and nothing private is replaced.
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS } from "../src/core/delegation/worker-directory-admission.ts";
import type { AgentBindingContract, OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { awaitPreflight } from "../src/core/preflight.ts";
import type * as NativeTaskDirectoryBackendModule from "../src/core/tasks/native-task-directory-backend.ts";
import {
	createResourceReuseHarness,
	writeAdmittedSkill,
	writeAdmittedSkillContent,
} from "./fixtures/resource-specialist-harness.ts";
import { createReuseHarness, type ReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

/**
 * How many stable-nonce namespace resolutions are still to be held, plus the current holder's entry
 * and release. A namespace call is the only `createAttachmentId` call that carries a nonce; directory
 * capture passes none, so ordinary admission is never delayed.
 */
const namespaceGate: { held: number; entered?: () => void; release?: () => void } = { held: 0 };

vi.mock("../src/core/tasks/native-task-directory-backend.ts", async (importOriginal) => {
	const original = (await importOriginal()) as typeof NativeTaskDirectoryBackendModule;
	return {
		...original,
		createNativeTaskDirectoryBackend: (agentDir?: string) => {
			const backend = original.createNativeTaskDirectoryBackend(agentDir);
			return {
				...backend,
				createAttachmentId: async (root: string, nonce?: string, signal?: AbortSignal) => {
					if (nonce !== undefined && namespaceGate.held > 0) {
						namespaceGate.held--;
						namespaceGate.entered?.();
						// The real backend resolves its identity through `awaitPreflight(work, signal)`; the
						// held call keeps exactly that contract, so an abort still wins and a timeout would
						// still apply if the caller supplied one.
						await awaitPreflight(
							() =>
								new Promise<void>((resolve) => {
									namespaceGate.release = resolve;
								}),
							signal,
						);
					}
					return backend.createAttachmentId(root, nonce, signal);
				},
			};
		},
	};
});

/** Hold the next physical-identity resolution until the returned release is called. */
function holdNamespaceResolution(): { entered: Promise<void>; release: () => void } {
	let announce!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	namespaceGate.held = 1;
	namespaceGate.entered = announce;
	return {
		entered,
		release: () => {
			namespaceGate.held = 0;
			namespaceGate.release?.();
			namespaceGate.release = undefined;
		},
	};
}

const scratchRoots: string[] = [];

afterEach(() => {
	namespaceGate.held = 0;
	namespaceGate.release?.();
	namespaceGate.release = undefined;
	while (scratchRoots.length > 0) {
		const root = scratchRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

const REASONING_MODEL_ID = "faux-reasoner";

/** Two admitted faux models, so a model or thinking choice is a real admission, never a refusal. */
function twoModelProfile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		profileId: "two-model-worker",
		description: "Worker admitting both faux models",
		role: "implementer",
		modelPolicy: {
			mode: "ordered-fallback",
			candidates: [
				{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
				{ provider: "faux", modelId: REASONING_MODEL_ID, thinkingLevel: "off" },
			],
		},
		capabilityCeiling: ["filesystem.read", "filesystem.write"],
		toolNames: ["read", "grep", "find", "ls"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 5, maxWallClockMs: 3_600_000, maxTokens: 16_384, maxToolCalls: 20 },
		maxConcurrent: 3,
		leaseTtlMs: 3_660_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
}

/** A session with both faux models registered and a worker profile that admits either one. */
async function createTwoModelHarness(): Promise<ReuseHarness> {
	return createReuseHarness({
		models: [
			{ id: "faux-1", contextWindow: 128_000 },
			{ id: REASONING_MODEL_ID, contextWindow: 128_000, reasoning: true, defaultThinkingLevel: "medium" },
		],
		workerOrchestrationProfile: twoModelProfile(),
	});
}

function agentIdOf(record: LaneRecord | undefined): string | undefined {
	return record?.agentId;
}

function assertCompleted(record: LaneRecord | undefined, label: string): LaneRecord {
	if (!record) throw new Error(`${label} produced no lane record`);
	expect(`${label}:${record.status}`).toBe(`${label}:succeeded`);
	expect(record.agentId).toBeDefined();
	return record;
}

function workerContractOf(context: ReuseHarness, agentId: string) {
	const attempt = context
		.attempts()
		.filter((candidate) => candidate.dispatch.logicalLaneId === agentId)
		.at(-1);
	const contract = attempt?.dispatch.executionContract?.worker;
	if (!contract) throw new Error(`no durable worker contract for ${agentId}`);
	return contract;
}

/**
 * A distinguishing option must be ADMITTED, run as its own specialist, and see none of the first
 * specialist's conversation. Anything less is not evidence that the grant separated them.
 */
async function assertRanAsDistinctSpecialist(
	context: ReuseHarness,
	label: string,
	firstAgentId: string,
	outcome: { started: true; record: LaneRecord } | { started: false; skipReason?: string },
): Promise<LaneRecord> {
	expect(`${label}:${outcome.started ? "started" : (outcome.skipReason ?? "refused")}`).toBe(`${label}:started`);
	if (!outcome.started) throw new Error(`${label} was refused`);
	await context.settleLanes();
	const settled = assertCompleted(
		context.laneRecords().find((record) => record.laneId === outcome.record.laneId),
		label,
	);
	expect(agentIdOf(settled)).not.toBe(firstAgentId);
	expect(Object.keys(context.agents())).toHaveLength(2);
	return settled;
}

describe("worker specialization grant semantics", () => {
	it("runs the same brief under a different admitted grant instead of calling it a duplicate", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		const gate = context.appendWorkerHold("held the first grant");
		context.appendWorkerReply("ran the same brief read-only");
		const brief = "Audit the lease fence ladder";
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: brief });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");
			const busyAgentId = agentIdOf(context.laneRecords()[0]) ?? "";

			// The SAME words under a narrower admitted grant: a different effective admission, so
			// different work. The duplicate-text heuristic exists for accidental copies of the same
			// specialization; it may not veto a start the specialization decision already called new.
			const narrowed = await context.lanes().startWorkerDelegation({
				instructions: brief,
				authority: { readOnly: true },
			});
			gate.release();
			await running;
			await context.settleLanes();

			expect(narrowed.started ? "started" : (narrowed.skipReason ?? "refused")).toBe("started");
			if (!narrowed.started) throw new Error("the differently granted brief was refused");
			const settled = assertCompleted(
				context.laneRecords().find((record) => record.laneId === narrowed.record.laneId),
				"narrowed grant",
			);
			expect(agentIdOf(settled)).not.toBe(busyAgentId);
			expect(Object.keys(context.agents())).toHaveLength(2);
		} finally {
			gate.release();
		}
	});

	it("negative control: the same brief under the same grant does not copy the busy specialist", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		const gate = context.appendWorkerHold("held the only grant");
		const brief = "Audit the retry ladder";
		try {
			const running = context.harness.session.runWorkerDelegationOnce({ instructions: brief });
			await gate.entered;
			expect(context.laneRecords()[0]?.status).toBe("running");

			const repeated = await context.lanes().startWorkerDelegation({ instructions: brief });

			// Equal text AND equal grant on a busy specialist is the accidental second copy the heuristic
			// is for: a bounded answer about the existing specialist, never a second one.
			expect(repeated.started).toBe(false);
			expect(Object.keys(context.agents())).toHaveLength(1);
			expect(context.workerRequests()).toHaveLength(1);
			gate.release();
			await running;
		} finally {
			gate.release();
		}
	});

	it("negative control: an admitted narrower budget runs as its own specialist", async () => {
		const context = await createTwoModelHarness();
		context.appendWorkerReply("ran on the inherited budget");
		context.appendWorkerReply("ran on the narrowed budget");
		const first = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Survey the inherited budget",
		});
		const firstAgentId = agentIdOf(assertCompleted(first.record, "inherited budget")) ?? "";

		const narrowed = await context.lanes().startWorkerDelegation({
			instructions: "Survey the narrowed budget",
			authority: { budget: { maxTokens: 8_000, maxCostUsd: 1, maxWallClockMs: 60_000, maxToolCalls: 5 } },
		});

		const settled = await assertRanAsDistinctSpecialist(context, "narrowed budget", firstAgentId, narrowed);
		// The admitted grant really carries the requested budget, and the new context is clean.
		expect(workerContractOf(context, agentIdOf(settled) ?? "").authority.budget.maxTokens).toBe(8_000);
		expect(context.workerRequests().at(-1)?.text).toContain("Survey the narrowed budget");
		expect(context.workerRequests().at(-1)?.text).not.toContain("ran on the inherited budget");
	});

	it("negative control: an admitted second model runs as its own specialist", async () => {
		const context = await createTwoModelHarness();
		context.appendWorkerReply("ran on the default model");
		context.appendWorkerReply("ran on the second admitted model");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Survey the default model" });
		const firstAgentId = agentIdOf(assertCompleted(first.record, "default model")) ?? "";

		const named = await context.lanes().startWorkerDelegation({
			instructions: "Survey the second model",
			authority: { model: { provider: "faux", modelId: REASONING_MODEL_ID } },
		});

		const settled = await assertRanAsDistinctSpecialist(context, "second model", firstAgentId, named);
		expect(workerContractOf(context, agentIdOf(settled) ?? "").modelBinding.modelId).toBe(REASONING_MODEL_ID);
		expect(context.workerRequests().at(-1)?.text).toContain("Survey the second model");
		expect(context.workerRequests().at(-1)?.text).not.toContain("ran on the default model");
	});

	it("negative control: an admitted thinking level runs as its own specialist", async () => {
		const context = await createTwoModelHarness();
		context.appendWorkerReply("ran at the default thinking level");
		context.appendWorkerReply("ran at the raised thinking level");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Survey the default level" });
		const firstAgentId = agentIdOf(assertCompleted(first.record, "default thinking")) ?? "";

		const raised = await context.lanes().startWorkerDelegation({
			instructions: "Survey the raised level",
			// A reasoning-capable admitted model, so the level is a real choice rather than a refusal.
			authority: { model: { provider: "faux", modelId: REASONING_MODEL_ID }, thinkingLevel: "high" },
		});

		const settled = await assertRanAsDistinctSpecialist(context, "raised thinking", firstAgentId, raised);
		const contract = workerContractOf(context, agentIdOf(settled) ?? "");
		expect(contract.modelBinding.thinkingLevel).toBe("high");
		expect(context.workerRequests().at(-1)?.text).not.toContain("ran at the default thinking level");
	});

	it("continues on the specialist born from the same parent snapshot when the fork is repeated", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("read the parent thread");
		context.appendWorkerReply("continued on the same parent thread");
		await context.harness.session.prompt("The lease fence rewrite is the current parent thread.", {
			autoContinueGoal: false,
		});
		// Hold the parent-context input constant. Terminal handoffs can otherwise append foreground
		// messages between these starts, making this a different-snapshot test by accident.
		const parentContext = context.harness.sessionManager.buildSessionContext();
		vi.spyOn(context.harness.sessionManager, "buildSessionContext").mockImplementation(() =>
			structuredClone(parentContext),
		);

		const born = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start from the parent thread",
			forkTurns: "all",
		});
		const bornRecord = assertCompleted(born.record, "born-with-context task");
		const repeated = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Continue from the same parent thread",
			forkTurns: "all",
		});

		// The premise, from the durable birth references the ledger itself persisted: every birth
		// snapshot captured in this session is content-identical, so the second start really did ask to
		// be born from the snapshot the first specialist already holds.
		const birthReferences = context
			.attempts()
			.map((attempt) => attempt.dispatch.birthContextForkReference)
			.filter((reference): reference is NonNullable<typeof reference> => reference !== undefined);
		expect(birthReferences.length).toBeGreaterThan(0);
		expect(new Set(birthReferences.map((reference) => reference.contentDigest)).size).toBe(1);
		expect(new Set(birthReferences.map((reference) => reference.messageCount)).size).toBe(1);

		// Same initialization is not a reason for a second copy of it, and the worker must see its own
		// earlier turn.
		const repeatedRecord = assertCompleted(repeated.record, "repeated fork task");
		expect(agentIdOf(repeatedRecord)).toBe(agentIdOf(bornRecord));
		expect(Object.keys(context.agents())).toHaveLength(1);
		const repeatedRequest = context.workerRequests()[1]!;
		expect(repeatedRequest.text).toContain("lease fence rewrite");
		expect(repeatedRequest.text).toContain("Continue from the same parent thread");
		expect(repeatedRequest.text).toContain("read the parent thread");
	});

	it("negative control: a fork captured after the parent moved is a different initialization", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("read the first parent thread");
		context.appendWorkerReply("read the second parent thread");
		await context.harness.session.prompt("The retry ladder census is the current parent thread.", {
			autoContinueGoal: false,
		});

		const born = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start from the parent thread",
			forkTurns: "all",
		});
		const bornRecord = assertCompleted(born.record, "first fork task");
		await context.settleLanes();
		await context.harness.session.waitForForegroundIdle();
		// The parent really moves on between the two captures: the second fork is a different snapshot.
		await context.harness.session.prompt("The worktree lease audit replaced that parent thread.", {
			autoContinueGoal: false,
		});
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Start from the moved parent thread",
			forkTurns: "all",
		});

		const secondRecord = assertCompleted(second.record, "second fork task");
		expect(agentIdOf(secondRecord)).not.toBe(agentIdOf(bornRecord));
		expect(Object.keys(context.agents())).toHaveLength(2);
		// The two birth snapshots really are different content, which is why they are different
		// specialists.
		const digests = context
			.attempts()
			.map((attempt) => attempt.dispatch.birthContextForkReference?.contentDigest)
			.filter((digest): digest is string => digest !== undefined);
		expect(new Set(digests).size).toBe(2);
		const secondRequest = context.workerRequests()[1]!;
		expect(secondRequest.text).toContain("worktree lease audit");
		expect(secondRequest.text).not.toContain("read the first parent thread");
	});

	it("negative control: a caller who aborts during physical identity resolution admits nothing", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("held the only specialization");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the specialization" });
		const firstAgentId = agentIdOf(assertCompleted(first.record, "first task")) ?? "";
		const agentsBefore = Object.keys(context.agents()).sort();
		const requestsBefore = context.workerRequests().length;
		const attemptsBefore = context.attempts().length;

		const gate = holdNamespaceResolution();
		const caller = new AbortController();
		try {
			const pending = context.lanes().startWorkerDelegation({ instructions: "Continue that work" }, caller.signal);
			await gate.entered;
			// The caller walks away while the owner is still resolving workspace identity.
			caller.abort();
			gate.release();
			const outcome = await pending;
			await context.settleLanes();

			// Without the abort this start would have reused the idle specialist and run. Aborted, it may
			// neither run nor leave a second identity behind.
			expect(outcome.started).toBe(false);
			expect(Object.keys(context.agents()).sort()).toEqual(agentsBefore);
			expect(context.workerRequests()).toHaveLength(requestsBefore);
			expect(context.attempts()).toHaveLength(attemptsBefore);
			expect(context.agents()[firstAgentId]?.status).toBe("registered");
		} finally {
			gate.release();
		}
	});

	it("answers in bounded terms when physical identity resolution never completes", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("held the only specialization");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Hold the specialization" });
		assertCompleted(first.record, "first task");
		const agentsBefore = Object.keys(context.agents()).sort();
		const requestsBefore = context.workerRequests().length;

		const gate = holdNamespaceResolution();
		vi.useFakeTimers();
		const pending = context.lanes().startWorkerDelegation({ instructions: "Continue that work" });
		try {
			await gate.entered;
			// The backend honours abort and timeout; this start hands it neither, so the only bound left
			// is the directory preflight watchdog the same admission owner already defines.
			const watchdog = new Promise<"still_pending">((resolve) => {
				setTimeout(() => resolve("still_pending"), WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS + 1_000);
			});
			await vi.advanceTimersByTimeAsync(WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS + 1_000);
			const settled = await Promise.race([pending, watchdog]);

			// A worker start may not wait on one directory call forever: past the admission owner's own
			// preflight bound it has to become a bounded refusal that admits nothing.
			expect(settled).not.toBe("still_pending");
			expect(settled === "still_pending" ? false : settled.started).toBe(false);
			expect(Object.keys(context.agents()).sort()).toEqual(agentsBefore);
			expect(context.workerRequests()).toHaveLength(requestsBefore);
		} finally {
			vi.useRealTimers();
			gate.release();
			// The released call still has to finish before the harness is torn down.
			await pending;
			await context.settleLanes();
		}
	});

	it("negative control: a specialist admitted during identity resolution still bounds the decision", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		context.appendWorkerReply("first specialization done");
		context.appendWorkerReply("independent copy done");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Review the lease fences" });
		const firstAgentId = agentIdOf(assertCompleted(first.record, "first task")) ?? "";

		const gate = holdNamespaceResolution();
		try {
			const pending = context.lanes().startWorkerDelegation({ instructions: "Review the lease fences later" });
			await gate.entered;
			// A second compatible specialist is admitted, deliberately, while that start is still
			// resolving identity: the durable state it will decide against is not the one it started from.
			const independent: WorkerDelegationRequest = {
				instructions: "Review the lease fences from a second angle",
				parallelWork: {
					independentOf: [firstAgentId],
					justification: "A deliberately independent second reviewer.",
				},
			};
			const copy = await context.harness.session.runWorkerDelegationOnce(independent);
			assertCompleted(copy.record, "independent copy");
			expect(Object.keys(context.agents())).toHaveLength(2);
			const requestsBefore = context.workerRequests().length;
			const attemptsBefore = context.attempts().length;
			gate.release();
			const late = await pending;
			await context.settleLanes();

			// Two equally compatible idle specialists is an ambiguity the host cannot resolve silently. A
			// start that learned about the second one only after its await must answer with that bounded
			// refusal -- not mint a third copy, and not pick one by accident.
			expect(late.started).toBe(false);
			expect(late.started ? "" : (late.skipReason ?? "")).toMatch(/choice|ambiguous|which/i);
			expect(Object.keys(context.agents())).toHaveLength(2);
			expect(context.workerRequests()).toHaveLength(requestsBefore);
			expect(context.attempts()).toHaveLength(attemptsBefore);
		} finally {
			gate.release();
		}
	});

	it("keeps the work running when an admitted resource's content changes under the same uri", async () => {
		const skill = writeAdmittedSkill("LEASE_FENCE_DOCTRINE_V1");
		scratchRoots.push(skill.root);
		const context = await createResourceReuseHarness(skill.skillPath);
		context.appendWorkerReply("read the first doctrine");
		context.appendWorkerReply("read the changed doctrine");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Apply the lease doctrine" });
		const firstRecord = assertCompleted(first.record, "first resource task");
		const firstAgentId = agentIdOf(firstRecord) ?? "";
		expect(context.workerRequests()[0]?.text).toContain("LEASE_FENCE_DOCTRINE_V1");
		const pinnedBefore: AgentBindingContract | undefined = context.agents()[firstAgentId];
		const pinnedPointersBefore = JSON.stringify(pinnedBefore?.resumeContext.contextPointers ?? []);

		// The owner edits the admitted skill. The URI is unchanged and the content is still valid; only
		// what it says is different.
		writeAdmittedSkillContent(skill.skillPath, "LEASE_FENCE_DOCTRINE_V2");
		const second = await context.lanes().startWorkerDelegation({ instructions: "Apply the changed lease doctrine" });
		await context.settleLanes();

		// New content under the same URI is a different immutable admission. It may allocate a fresh
		// specialist and run with the new content; it may not accept the task onto the stale context and
		// then fail, and it may not repin the original specialist's birth metadata.
		expect(second.started ? "started" : (second.skipReason ?? "refused")).toBe("started");
		const settled = second.started
			? context.laneRecords().find((record) => record.laneId === second.record.laneId)
			: undefined;
		expect(`changed-resource:${settled?.status}`).toBe("changed-resource:succeeded");
		expect(agentIdOf(settled)).not.toBe(firstAgentId);
		expect(JSON.stringify(context.agents()[firstAgentId]?.resumeContext.contextPointers ?? [])).toBe(
			pinnedPointersBefore,
		);
		const requests = context.workerRequests();
		expect(requests).toHaveLength(2);
		expect(requests[1]?.text).toContain("LEASE_FENCE_DOCTRINE_V2");
		expect(requests[1]?.text).not.toContain("LEASE_FENCE_DOCTRINE_V1");
	});

	it("negative control: unchanged resource content keeps one specialist and one materialization", async () => {
		const skill = writeAdmittedSkill("LEASE_FENCE_DOCTRINE_V1");
		scratchRoots.push(skill.root);
		const context = await createResourceReuseHarness(skill.skillPath);
		context.appendWorkerReply("read the doctrine");
		context.appendWorkerReply("applied the doctrine again");
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "Apply the lease doctrine" });
		const firstRecord = assertCompleted(first.record, "first resource task");

		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "Apply the lease doctrine to the next fence",
		});

		// Same admitted pointer, same content: the same specialization, continuing on its own context.
		const secondRecord = assertCompleted(second.record, "second resource task");
		expect(agentIdOf(secondRecord)).toBe(agentIdOf(firstRecord));
		expect(Object.keys(context.agents())).toHaveLength(1);
		expect(context.workerRequests()[1]?.text).toContain("LEASE_FENCE_DOCTRINE_V1");
		expect(context.workerRequests()[1]?.text).toContain("read the doctrine");
	});
});
