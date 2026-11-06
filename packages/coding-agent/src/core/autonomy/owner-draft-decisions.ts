/**
 * The owner's answers to held drafts from an owner channel, as pure functions over the session branch and an append
 * callback: no model and no side effect beyond the draft state entries. Approving binds the draft to its complete call
 * (`callDigest`) and to the delivery that carries the approval (`by.ref`); the remote-owner edge admits that call once
 * (`consumeOwnerApproval` in `agent-session-edge.ts`). A draft approved again stays approved and nothing is written.
 */

import type { SessionEntry } from "../../kernel/node.ts";
import {
	OUTWARD_DRAFT_STATE_CUSTOM_TYPE,
	type OutwardDraftStateRecord,
	type OutwardDraftStateView,
	outwardDraftStates,
	ownerDraftView,
} from "../agent-session-edge.ts";
import type {
	OwnerApprovalPolicy,
	OwnerDecisionBy,
	OwnerDraftDecisions,
	OwnerDraftView,
} from "../channels/owner-channel-types.ts";
import type { LiveRunOrigin } from "../turn-origin.ts";

export interface OwnerDraftDecisionDeps {
	getBranch(): readonly SessionEntry[];
	appendCustomEntry(customType: string, data: unknown): void;
	/** The run in progress (`RunTurnOrigin.live()`): its decisive origin and whether the run's own messages decided it. */
	getLiveRun?(): LiveRunOrigin | undefined;
	/** Whether the approval delivery with `ref` is still queued (delivered, not yet accepted or dropped). */
	isApprovalDeliveryPending?(ref: string): boolean;
	now?(): number;
}

function byRecord(by: OwnerDecisionBy): { channel: string; senderDigest: string; ref: string; eventDigest: string } {
	return { channel: by.channel, senderDigest: by.senderDigest, ref: by.ref, eventDigest: by.eventDigest };
}

export function createOwnerDraftDecisions(deps: OwnerDraftDecisionDeps): OwnerDraftDecisions {
	const states = (): OutwardDraftStateView[] => {
		const liveRun = deps.getLiveRun?.();
		return outwardDraftStates(deps.getBranch(), liveRun?.origin.k === "owner-typed", {
			...(liveRun ? { liveRun } : {}),
			...(deps.isApprovalDeliveryPending
				? { isApprovalDeliveryPending: (ref: string) => deps.isApprovalDeliveryPending?.(ref) === true }
				: {}),
			nowMs: deps.now?.() ?? Date.now(),
		});
	};
	const find = (draftId: string) => states().find(({ record }) => record.id === draftId);
	return {
		drafts(): readonly OwnerDraftView[] {
			return states().map(ownerDraftView);
		},
		approve(draftId, by, policy: OwnerApprovalPolicy) {
			const draft = find(draftId);
			if (!draft) return "absent";
			// An approval still active on an expired draft admits nothing (the edge reads `state`): the answer says so.
			if (draft.unexpiredState === "approved" && draft.state === "expired") return "expired";
			if (draft.unexpiredState !== "pending") return draft.unexpiredState;
			const { record } = draft;
			const remote = record.origin.k === "owner-channel";
			if (
				record.callDigest === undefined ||
				record.rendering === undefined ||
				record.operations.some((operation) => policy.terminalOnlyClasses.includes(operation.class)) ||
				(remote && (record.ownerSender === undefined || record.ownerSender !== by.senderDigest))
			)
				return "terminal-only";
			if (draft.state === "expired") return "expired";
			const approved: OutwardDraftStateRecord = {
				version: 1,
				id: record.id,
				state: "approved",
				at: new Date(deps.now?.() ?? Date.now()).toISOString(),
				callDigest: record.callDigest,
				by: byRecord(by),
			};
			deps.appendCustomEntry(OUTWARD_DRAFT_STATE_CUSTOM_TYPE, approved);
			return "approved";
		},
		deny(draftId, by) {
			const draft = find(draftId);
			if (!draft) return "absent";
			if (draft.state !== "pending" && draft.state !== "approved") return draft.state;
			const denied: OutwardDraftStateRecord = {
				version: 1,
				id: draft.record.id,
				state: "denied",
				at: new Date(deps.now?.() ?? Date.now()).toISOString(),
				by: byRecord(by),
			};
			deps.appendCustomEntry(OUTWARD_DRAFT_STATE_CUSTOM_TYPE, denied);
			return "denied";
		},
	};
}
