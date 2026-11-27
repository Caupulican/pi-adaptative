/**
 * The owner's decisions on held drafts, recorded against the session branch through an append
 * callback: no model and no side effect beyond the draft state entries. Approving binds the draft to its complete call
 * (`callDigest`) and to the delivery that carries the approval (`by.ref`); the remote-owner edge admits that call once
 * (`consumeOwnerApproval` in `agent-session-edge.ts`). A draft approved again stays approved and nothing is written.
 */

import type { SessionEntry, SessionManager } from "../../kernel/node.ts";
import { SessionAppendCommittedError } from "../../kernel/session/session-append-receipt.ts";
import { AgentToolPolicyDeniedError } from "../../kernel/types.ts";
import {
	type EdgeCall,
	OUTWARD_DRAFT_CUSTOM_TYPE,
	OUTWARD_DRAFT_STATE_CUSTOM_TYPE,
	type OutwardDraftStateRecord,
	type OutwardDraftStateView,
	outwardDraftStates,
	outwardOperationsDigest,
	ownerDraftView,
} from "../agent-session-edge.ts";
import type {
	OwnerApprovalPolicy,
	OwnerDecisionBy,
	OwnerDraftDecisions,
	OwnerDraftView,
} from "../channels/owner-channel-types.ts";
import type { LiveRunOrigin } from "../turn-origin.ts";
import type { EdgeOperation } from "./edge-policy.ts";
import { ownerCallDigest } from "./owner-draft-rendering.ts";

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

/** Only a started owner call can settle its matching drafts. Recheck the branch and pending state at start. */
export function registerOutwardDraftRelease(
	manager: Pick<
		SessionManager,
		"getBranch" | "getCustomEntriesOnBranch" | "appendCustomEntry" | "captureBranchContext" | "getEntry"
	>,
	call: EdgeCall,
	readOperations: () => readonly EdgeOperation[],
	registerStart: (start: () => void) => void,
): void {
	if (!manager.getCustomEntriesOnBranch([OUTWARD_DRAFT_CUSTOM_TYPE]).length) return;
	const pending = () =>
		outwardDraftStates(manager.getBranch(), true).filter(({ state }) => state === "pending" || state === "approved");
	const candidates = pending().filter(({ record }) => record.toolName === call.toolName);
	if (!candidates.length) return;
	const callDigest = ownerCallDigest(call.toolName, call.args);
	const ids = new Set<string>();
	let legacyDigest: string | undefined;
	for (const { record } of candidates) {
		if (record.callDigest !== undefined) {
			if (record.callDigest === callDigest) ids.add(record.id);
		} else {
			legacyDigest ??= outwardOperationsDigest(call.toolName, readOperations());
			if (record.operationsDigest === legacyDigest) ids.add(record.id);
		}
	}
	if (!ids.size) return;
	const assertBranch = manager.captureBranchContext();
	const releaseAtStart = () => {
		try {
			assertBranch();
			if (ownerCallDigest(call.toolName, call.args) !== callDigest)
				throw new Error("The held call's arguments changed after admission.");
			const [first, ...others] = pending()
				.map(({ record }) => record.id)
				.filter((id) => ids.has(id));
			if (first) appendOutwardDraftReleased(manager, first, others);
		} catch (error) {
			throw new AgentToolPolicyDeniedError(
				`The held call did not start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	registerStart(releaseAtStart);
}

/** One start receipt retires all matching drafts, including when publication reports a later observer failure. */
export function appendOutwardDraftReleased(
	manager: Pick<SessionManager, "appendCustomEntry" | "getEntry">,
	id: string,
	others: readonly string[] = [],
): void {
	const released: OutwardDraftStateRecord = {
		version: 1,
		id,
		state: "released",
		at: new Date().toISOString(),
		...(others.length ? { alsoReleased: others } : {}),
	};
	try {
		manager.appendCustomEntry(OUTWARD_DRAFT_STATE_CUSTOM_TYPE, released);
	} catch (error) {
		if (!(error instanceof SessionAppendCommittedError) || error.receipt.entries.length !== 1) throw error;
		const committed = manager.getEntry(error.receipt.entries[0]!.id);
		if (
			committed?.type !== "custom" ||
			committed.customType !== OUTWARD_DRAFT_STATE_CUSTOM_TYPE ||
			committed.data !== released
		)
			throw error;
	}
}
