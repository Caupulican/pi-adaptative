/**
 * Encoded-byte admission at the mailbox versus goal persistence.
 *
 * The mailbox has two independent capacities: a pending-message COUNT cap the enqueue mutator owns,
 * and an encoded-BYTE admission bound its durable write owns. Only the first one is checked before
 * the accepted message's goal criteria are materialized. These cases keep the pending count well
 * under the message cap and saturate bytes instead, so what refuses the start is provably the byte
 * bound and not the already-covered count cap.
 *
 * Everything runs through real owners: real `WorkerAgentControlCoordinator`, real `WorkerLifecycle`
 * and the real durable `WorkerAgentMailbox` file. Saturation is built from real peer messages that
 * are really pending; no mailbox state is hand-written.
 *
 * Current behaviour (batch9-production-baseline-manifest.txt): `enqueueWithReceipt` invokes its
 * `onAdmitted` goal-materialization hook inside the mutator, before `update()` runs
 * `pruneDeliveredHistory`, the encoded-byte admission check and the mailbox bounds assertion. A
 * start refused for encoded bytes therefore still leaves its new objective behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkerControlSeam,
	goalFixture,
	removeWorkerControlSeam,
	SEAM_AGENT_ID,
	type WorkerControlSeam,
} from "./fixtures/worker-control-seam.ts";

/** The mailbox's own named pending-message capacity, which these cases must never reach. */
const MAILBOX_PENDING_LIMIT = 64;
/** The mailbox's ordinary peer-message character bound. */
const MAILBOX_MESSAGE_CHARS = 4_096;
/**
 * Two-byte text: encoded size is what the byte bound measures, and it is not the character count
 * either bound above is written in.
 */
const MULTIBYTE = "é";

const seams: WorkerControlSeam[] = [];

afterEach(() => {
	while (seams.length > 0) {
		const seam = seams.pop();
		if (seam) removeWorkerControlSeam(seam);
	}
});

function seam(sessionId: string): WorkerControlSeam {
	const created = createWorkerControlSeam(sessionId);
	seams.push(created);
	return created;
}

/** A brief that is well inside every character bound but far from free in encoded bytes. */
function multibyteBrief(characters: number): string {
	return MULTIBYTE.repeat(characters);
}

/**
 * Fill the mailbox with real pending peer messages until its encoded-byte admission refuses one
 * more. The messages are ordinary coordination text, so they occupy bytes without ever approaching
 * the pending-message count cap.
 */
function saturateEncodedBytes(target: WorkerControlSeam): { refusal: string; pending: number } {
	for (let index = 0; index < MAILBOX_PENDING_LIMIT - 1; index++) {
		try {
			target.coordinator.sendSessionRootWorkerAgentMessage(
				SEAM_AGENT_ID,
				`${index} ${multibyteBrief(MAILBOX_MESSAGE_CHARS - 16)}`,
			);
		} catch (error) {
			return {
				refusal: error instanceof Error ? error.message : String(error),
				pending: target.mailbox.pending().length,
			};
		}
	}
	throw new Error("ordinary peer messages never reached the mailbox encoded-byte bound");
}

function startOutcome(target: WorkerControlSeam, goalId: string, requirementId: string, brief: string): string {
	try {
		const outcome = target.coordinator.startWorkerAgentTask(SEAM_AGENT_ID, brief, {
			idempotencyKey: `byte-capacity-${goalId}`,
			newTask: { goal: goalFixture(goalId, requirementId), requirementIds: [requirementId] },
		});
		return outcome.started === false ? (outcome.skipReason ?? "refused") : "started";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("worker control byte capacity", () => {
	it("does not persist a new objective when the mailbox refuses the start for encoded bytes", () => {
		const target = seam("byte-capacity-refusal");
		const saturation = saturateEncodedBytes(target);
		// The refusal under test must be the BYTE bound: the pending count is far below the message cap
		// that the already-frozen saturation case covers.
		expect(saturation.refusal).toMatch(/byte/i);
		expect(saturation.pending).toBeLessThan(MAILBOX_PENDING_LIMIT);
		const objectivesBefore = target.objectiveIds();
		const turnsBefore = target.turnTaskIds();
		const messagesBefore = target.mailbox.pending().length;

		// A brief that every CHARACTER bound admits, on a mailbox whose aggregate encoded size cannot
		// take it.
		const refusal = startOutcome(target, "goal-bytes", "req-bytes", multibyteBrief(3_000));

		expect(refusal).not.toBe("started");
		expect(refusal).toMatch(/byte|reserve|capacity/i);
		// Nothing of the refused request may be durable: not its objective, not a turn, not a message.
		expect(target.objectiveIds()).toEqual(objectivesBefore);
		expect(target.objectiveIds()).not.toContain("goal:goal-bytes");
		expect(target.turnTaskIds()).toEqual(turnsBefore);
		expect(target.mailbox.pending()).toHaveLength(messagesBefore);
	});

	it("negative control: the same-sized start is accepted on an unsaturated mailbox", () => {
		const target = seam("byte-capacity-accepted");
		const objectivesBefore = target.objectiveIds();

		const outcome = startOutcome(target, "goal-bytes", "req-bytes", multibyteBrief(3_000));

		// The brief itself is admissible; only the saturated aggregate refused it above. An accepted
		// start persists its goal and its durable turn together.
		expect(outcome).toBe("started");
		expect(target.objectiveIds()).not.toEqual(objectivesBefore);
		expect(target.objectiveIds()).toContain("goal:goal-bytes");
		expect(target.turnTaskIds()).toHaveLength(1);
		expect(target.lifecycle.getLatestAgentAttempt(SEAM_AGENT_ID)?.dispatch.requirementIds).toEqual(["req-bytes"]);
	});

	it("negative control: ordinary peer traffic is refused at the byte bound without disturbing durable state", () => {
		const target = seam("byte-capacity-peer-traffic");
		const saturation = saturateEncodedBytes(target);
		const objectivesBefore = target.objectiveIds();
		const pendingBefore = target.mailbox.pending().length;

		let refusal = "";
		try {
			// The same size the fill was refused at, so this asks the byte bound the same question again.
			target.coordinator.sendSessionRootWorkerAgentMessage(
				SEAM_AGENT_ID,
				multibyteBrief(MAILBOX_MESSAGE_CHARS - 16),
			);
			refusal = "accepted";
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}

		// A peer message carries no goal, so this documents the byte bound's own behaviour: it refuses
		// in bounded terms and leaves the mailbox exactly as it was.
		expect(refusal).not.toBe("accepted");
		expect(refusal).toMatch(/byte/i);
		expect(saturation.pending).toBeLessThan(MAILBOX_PENDING_LIMIT);
		expect(target.mailbox.pending()).toHaveLength(pendingBefore);
		expect(target.objectiveIds()).toEqual(objectivesBefore);
		expect(target.turnTaskIds()).toEqual([]);
	});
});
