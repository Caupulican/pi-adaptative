/**
 * The edge, bound to one session: grants live on the branch, the confirmation handler belongs to
 * the interactive host, and a child session never asks. The coordinator (agent-session.ts) only
 * supplies these dependencies; the classification itself is `autonomy/edge-policy.ts`.
 */
import { createHash } from "node:crypto";
import { type BeforeToolCallResult, MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS } from "../kernel/index.ts";
import type { SessionEntry } from "../kernel/node.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import {
	boundedActionLine,
	classifyAllEdgeOperations,
	classifyOutwardEdgeOperations,
	classifyYoloBoundary,
	collectEdgeGrants,
	EDGE_GRANT_CUSTOM_TYPE,
	EDGE_REVOKE_CUSTOM_TYPE,
	type EdgeClass,
	type EdgeConfirmationHandler,
	type EdgeDecision,
	type EdgeGrantRecord,
	type EdgeGrantView,
	type EdgeOperation,
	type EdgeRevokeRecord,
	edgeBlockReason,
	grantableEdgeClasses,
	isEdgeOperationGranted,
	ownerOnlyToolCallReason,
	type ProtectedWritePaths,
	parseEdgeScope,
	remoteOwnerTypedOnlyOperation,
	remoteOwnerTypedOnlyReason,
	remoteOwnerUnclassifiedAction,
	thirdPartyReleaseLine,
} from "./autonomy/edge-policy.ts";
import { ownerCallDigest, renderOwnerDraftCall } from "./autonomy/owner-draft-rendering.ts";
import type { ToolDecision } from "./autonomy-status/tool-manifest.ts";
import type { OwnerDraftView } from "./channels/owner-channel-types.ts";
import { boundedRedactedDiagnosticText, MAX_RETAINED_DIAGNOSTIC_CHARS } from "./security/secret-text.ts";
import {
	entryTurnOrigin,
	isRemoteOwnerOrigin,
	isThirdPartyOrigin,
	type LiveRunOrigin,
	latestDecisiveEntry,
	type TurnOriginRecord,
} from "./turn-origin.ts";

export interface SessionEdgeDeps {
	getMode?(): "guarded" | "yolo";
	getBranch(): readonly SessionEntry[];
	/** The branch's edge grant and revoke records in order, read incrementally (see `getCustomEntriesOnBranch`). */
	getEdgeRecords(): readonly SessionEntry[];
	getSettingsAllow(): readonly string[];
	/** `edge.thirdPartyAllow` (`ResolvedEdgeSettings.thirdPartyAllow`): settings grants that stand for a third party's run. */
	getThirdPartySettingsAllow?(): readonly string[];
	getDenyCommands?(): readonly string[];
	appendCustomEntry(customType: string, data: unknown): void;
	getCwd(): string;
	isChildSession(): boolean;
	getConfirmation(): EdgeConfirmationHandler | undefined;
	deferOwnerOperation?(operation: EdgeOperation): string | undefined;
	/**
	 * Whether the worktree currently holds changes at paths this session never wrote. Resolves the
	 * `unowned_worktree_changes` condition. Absent means the state cannot be read, and a conditional
	 * operation then stays ordinary work rather than asking on a state nobody established.
	 */
	mayHoldUnownedWorktreeChanges?(signal?: AbortSignal): Promise<boolean>;
	/** The decisive origin of the run in progress (`RunTurnOrigin`); absent or owner-controlled outside such a run. */
	getRunOrigin?(): TurnOriginRecord | undefined;
	/** The run in progress with whether its own messages decided its origin (`RunTurnOrigin.live`): an approval reads it. */
	getLiveRun?(): LiveRunOrigin | undefined;
	/**
	 * Keeps operations a run carrying a third party's words may not run as one durable draft for the owner and tells
	 * the owner once (`keepOutwardDraft`); returns the draft's id (absent when the session's pending drafts are full) and
	 * whether the owner is actually told (false where no notice can be saved: an unpersisted or child session), and the
	 * state of a draft already held under that id.
	 */
	prepareOutward?(draft: OutwardDraftInput): {
		readonly id?: string;
		readonly told: boolean;
		readonly state?: OutwardDraftState;
	};
	/**
	 * Records that the owner's own run performs a pending draft's operations (`releaseOutwardDrafts`); `operations` is
	 * read only while a draft is pending.
	 */
	releaseOutward?(toolName: string, operations: () => readonly EdgeOperation[]): void;
	/** Harness files and the session store, which a run carrying a third party's words does not write on its own. */
	getProtectedWritePaths?(): ProtectedWritePaths;
	/** Reports a call the third-party or remote-owner gate refused or held, for the run's tool manifest (`autonomy-status`). */
	noteToolRefusal?(decision: ToolDecision): void;
	/**
	 * Whether the owner channel that opened a remote-owner run still holds the owner's authority (the sender is still
	 * listed, the provider is the shipped one, the emergency stop is not engaged). Asked again at every guarded call of
	 * such a run; absent means it does not, so a remote-owner run with no answer holds no authority.
	 */
	isOwnerChannelLive?(origin: TurnOriginRecord): boolean;
	/** Shows a draft held on a remote-owner run to the owner's phone; the notice in the session is written either way. */
	presentOwnerDraft?(view: OwnerDraftView): void;
	/**
	 * The sender digest of the owner identity whose message opened the remote-owner run `origin` names: only that
	 * identity approves the draft from a channel. Absent or `undefined` leaves the draft to the owner's terminal.
	 */
	ownerChannelSender?(origin: TurnOriginRecord): string | undefined;
	/**
	 * Claims the owner's approval of draft `draftId` for the call with these arguments (the same arguments object), which
	 * the remote-owner edge admits on it: a claimed approval admits no other call, the operation gate admits this call
	 * instead of holding it again, and `released` is written only once the call executed (the tool gate settles the
	 * claim). `claimed` when this call now holds it (or these arguments already hold a claim); `in-use` when another call
	 * holds it; `untracked` when the arguments are not an object, so nothing is admitted and the call is held.
	 */
	claimApprovedCall?(draftId: string, args: unknown): "claimed" | "in-use" | "untracked";
	/**
	 * Whether executing the call reaches the edge again with no call (a dangerous automation's toolkit authorizer), which
	 * would hold it once more after an approval: on a remote-owner run its draft is then left to the terminal.
	 */
	holdsAgainAtExecution?(call: EdgeCall): boolean;
}

/** A tool call as the edge received it: its complete arguments, before any redaction or shortening. */
export interface EdgeCall {
	readonly toolName: string;
	readonly args: unknown;
}

/** An outward action held for the owner, as the gate saw it. */
export interface OutwardDraftInput {
	readonly toolName: string;
	readonly operations: readonly EdgeOperation[];
	readonly origin: TurnOriginRecord;
	/** The complete call, on a remote-owner run that held one: the draft is then bound to it and rendered. */
	readonly call?: EdgeCall;
	/** The sender digest of the owner identity that opened the remote-owner run (`ownerChannelSender`). */
	readonly ownerSender?: string;
	/** The call cannot be released by an approval from a channel: it is kept bound to its call but not rendered. */
	readonly terminalOnly?: boolean;
}

export interface EdgeGrantDetails {
	note?: string;
	quote?: string;
	messageEntryId?: string;
	scopeKey?: string;
	/** The owner typed it (see `EdgeGrantRecord.standing`). */
	standing?: boolean;
	/** The owner answered the edge prompt (see `EdgeGrantRecord.prompt`). */
	prompt?: boolean;
}

function requireValidEdgeScope(scopeKey: unknown, kind: "grant" | "revoke"): string | undefined {
	const parsed = parseEdgeScope(scopeKey);
	if (!parsed.valid) {
		throw new Error(
			`Invalid narrow edge ${kind}: scopeKey must be a non-empty string, got ${JSON.stringify(scopeKey)}`,
		);
	}
	return parsed.scopeKey;
}

/** The branch's edge grant and revoke records in order, from any reader of the session's history. */
export function edgeRecordsOnBranch(reader: Pick<SessionManager, "getCustomEntriesOnBranch">): readonly SessionEntry[] {
	return reader.getCustomEntriesOnBranch([EDGE_GRANT_CUSTOM_TYPE, EDGE_REVOKE_CUSTOM_TYPE]);
}

/** Granted edge classes: settings first, then the branch's grant and revoke records in order. */
export function sessionEdgeGrants(
	deps: Pick<SessionEdgeDeps, "getEdgeRecords" | "getSettingsAllow" | "getThirdPartySettingsAllow">,
): EdgeGrantView[] {
	return collectEdgeGrants(deps.getEdgeRecords(), deps.getSettingsAllow(), deps.getThirdPartySettingsAllow?.());
}

/**
 * The owner's standing grants: the settings classes they wrote and the grants they typed. Read apart from the defaulted
 * settings grants, which would otherwise hide a typed grant of the same class.
 */
export function standingEdgeGrants(
	deps: Pick<SessionEdgeDeps, "getEdgeRecords" | "getThirdPartySettingsAllow">,
): EdgeGrantView[] {
	const written = deps.getThirdPartySettingsAllow?.() ?? [];
	return collectEdgeGrants(deps.getEdgeRecords(), written, written).filter((grant) => grant.standing === true);
}

/** Record a grant on the branch: the operator's decision here, or the model's citation of their words. */
export function recordEdgeGrant(
	deps: SessionEdgeDeps,
	edgeClass: EdgeClass,
	source: "operator" | "instructions",
	details: EdgeGrantDetails = {},
): void {
	const scopeKey = "scopeKey" in details ? requireValidEdgeScope(details.scopeKey, "grant") : undefined;
	const record: EdgeGrantRecord = {
		version: 1,
		class: edgeClass,
		source,
		...(details.quote ? { quote: details.quote } : {}),
		...(details.messageEntryId ? { messageEntryId: details.messageEntryId } : {}),
		...(details.note ? { note: details.note } : {}),
		...(scopeKey !== undefined ? { scopeKey } : {}),
		...(details.standing === true ? { standing: true as const } : {}),
		...(details.prompt === true ? { prompt: true as const } : {}),
		grantedAt: new Date().toISOString(),
	};
	deps.appendCustomEntry(EDGE_GRANT_CUSTOM_TYPE, record);
}

/** The run's origin when the run in progress carries a third party's words. */
function thirdPartyRunOrigin(deps: Pick<SessionEdgeDeps, "getRunOrigin">): TurnOriginRecord | undefined {
	const origin = deps.getRunOrigin?.();
	return isThirdPartyOrigin(origin) ? origin : undefined;
}

/** The run's origin when the run in progress was opened from an owner channel (the owner's phone). */
function remoteOwnerRunOrigin(deps: Pick<SessionEdgeDeps, "getRunOrigin">): TurnOriginRecord | undefined {
	const origin = deps.getRunOrigin?.();
	return isRemoteOwnerOrigin(origin) ? origin : undefined;
}

/**
 * The grants a run opened from an owner channel uses: the owner's standing grants (typed `/edge allow` and
 * `edge.thirdPartyAllow`) and the owner's answers to the edge prompt. Never a grant derived from words (one cited from
 * instructions, or System One's reading of the owner's request), and never the defaulted `edge.allow` classes, which
 * stand for the owner at the terminal.
 */
export function remoteOwnerEdgeGrants(
	deps: Pick<SessionEdgeDeps, "getEdgeRecords" | "getThirdPartySettingsAllow">,
): EdgeGrantView[] {
	const written = deps.getThirdPartySettingsAllow?.() ?? [];
	return collectEdgeGrants(deps.getEdgeRecords(), written, written).filter(
		(grant) => grant.standing === true || (grant.source === "operator" && grant.prompt === true),
	);
}

/**
 * The grants the run in progress may use: on a run carrying a third party's words, only the owner's standing ones; on
 * a run opened from an owner channel, `remoteOwnerEdgeGrants`.
 */
export function effectiveEdgeGrants(
	deps: Pick<SessionEdgeDeps, "getEdgeRecords" | "getSettingsAllow" | "getThirdPartySettingsAllow" | "getRunOrigin">,
): EdgeGrantView[] {
	if (thirdPartyRunOrigin(deps)) return standingEdgeGrants(deps);
	return remoteOwnerRunOrigin(deps) ? remoteOwnerEdgeGrants(deps) : sessionEdgeGrants(deps);
}

export function originLabel(origin: TurnOriginRecord): string {
	if (origin.k === "peer-agent") return `a peer agent on ${origin.channel ?? "the chat mesh"}`;
	if (origin.k === "host-event") return "an event written by someone else";
	return origin.channel ? `the ${origin.channel} channel` : "a source whose origin could not be read";
}

export const OUTWARD_DRAFT_CUSTOM_TYPE = "pi_outward_draft";
/** A kept draft's later state (`OutwardDraftStateRecord`), apart from the drafts themselves. */
export const OUTWARD_DRAFT_STATE_CUSTOM_TYPE = "pi_outward_draft_state";
/** Pending drafts one branch keeps; past it the gate still prepares (refuses to run) but keeps no further draft. */
export const MAX_OUTWARD_DRAFTS = 64;

/**
 * A draft is pending; approved from an owner channel (bound to its complete call, admitted once); released (performed:
 * by the owner's own run, or by the approved call); denied from an owner channel; dismissed (the owner's own run ended
 * without it); or expired (a draft held on a remote-owner run, unanswered for `OWNER_DRAFT_EXPIRY_MS`).
 */
export type OutwardDraftState = "pending" | "approved" | "released" | "denied" | "dismissed" | "expired";

/** The states from which a draft is never approved: the same call asked again under the same request stays there. */
const OWNER_DRAFT_FINAL_STATES: ReadonlySet<OutwardDraftState> = new Set([
	"released",
	"denied",
	"dismissed",
	"expired",
]);

/** How long a draft held on a remote-owner run waits for an answer, from `preparedAt`; derived, nothing is written. */
export const OWNER_DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface OutwardDraftRecord {
	readonly version: 1;
	/**
	 * The requesting message's entry and the operations (a remote-owner draft: the complete call): the same request
	 * asked again finds its draft, another adds one.
	 */
	readonly id: string;
	/** The digest of the tool and its operations alone, which the owner's own run is matched against (`releaseOutwardDrafts`). */
	readonly operationsDigest: string;
	/** The entry of the third party's or the owner channel's message that opened or steered the run, when the branch names one. */
	readonly requestEntryId?: string;
	readonly toolName: string;
	readonly operations: readonly { class: EdgeClass; operation: string; reason: string }[];
	readonly origin: TurnOriginRecord;
	readonly preparedAt: string;
	/** The versioned digest of the complete held call (`ownerCallDigest`): an approval admits only this call. */
	readonly callDigest?: string;
	/** What the owner reads before approving (`renderOwnerDraftCall`); absent leaves the draft to the terminal. */
	readonly rendering?: string;
	/** The sender digest of the owner identity that opened the run: only it approves the draft from a channel. */
	readonly ownerSender?: string;
}

/** Who decided on a draft from an owner channel: the channel, the sender's digest, the delivery ref, the event's digest. */
export interface OwnerDecisionByRecord {
	readonly channel: string;
	readonly senderDigest: string;
	readonly ref: string;
	readonly eventDigest: string;
}

/**
 * A kept draft's recorded state. `released` is written when the owner's own run performs it or the approved call is
 * admitted; `approved` and `denied` are the owner's answers from an owner channel. Dismissal and expiry are not
 * written: they follow from the branch and the clock.
 */
export type OutwardDraftStateRecord =
	| { readonly version: 1; readonly id: string; readonly state: "released"; readonly at: string }
	| {
			readonly version: 1;
			readonly id: string;
			readonly state: "approved";
			readonly at: string;
			readonly callDigest: string;
			readonly by: OwnerDecisionByRecord;
	  }
	| {
			readonly version: 1;
			readonly id: string;
			readonly state: "denied";
			readonly at: string;
			readonly by: OwnerDecisionByRecord;
	  };

/** Reads to derive a draft's approval and expiry: the live run's decisive origin and the delivery queue. */
export interface OutwardDraftStateContext {
	/**
	 * The run in progress (`RunTurnOrigin.live`): an approval delivered to the branch is active only in the run whose own
	 * delivery of it decided the run (`decidedInRun`), never in a later run that inherits that origin.
	 */
	readonly liveRun?: LiveRunOrigin;
	/** Whether the approval delivery with `ref` is still queued (delivered, not yet accepted or dropped). */
	isApprovalDeliveryPending?(ref: string): boolean;
	readonly nowMs?: number;
}

export interface OutwardDraftStateView {
	readonly record: OutwardDraftRecord;
	readonly state: OutwardDraftState;
	/** The state before expiry applies (an approval decision reads it to name the state it refuses). */
	readonly unexpiredState: Exclude<OutwardDraftState, "expired">;
	/** The active approval, while `state` is `approved`. */
	readonly approval?: { readonly callDigest: string; readonly by: OwnerDecisionByRecord };
}

function stringField(data: object, key: string): string | undefined {
	const value = Reflect.get(data, key);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decisionBy(data: object): OwnerDecisionByRecord | undefined {
	const by: unknown = Reflect.get(data, "by");
	if (typeof by !== "object" || by === null) return undefined;
	const channel = stringField(by, "channel");
	const senderDigest = stringField(by, "senderDigest");
	const ref = stringField(by, "ref");
	const eventDigest = stringField(by, "eventDigest");
	return channel && senderDigest && ref && eventDigest ? { channel, senderDigest, ref, eventDigest } : undefined;
}

function outwardOperationsDigest(toolName: string, operations: readonly EdgeOperation[]): string {
	return createHash("sha256")
		.update(JSON.stringify([toolName, operations.map((operation) => [operation.class, operation.operation])]))
		.digest("hex")
		.slice(0, 16);
}

/** A stored draft the readers can use without throwing: a malformed one is skipped, never read. */
function isOutwardDraftRecord(data: unknown): data is OutwardDraftRecord {
	if (typeof data !== "object" || data === null) return false;
	const origin: unknown = Reflect.get(data, "origin");
	const operations: unknown = Reflect.get(data, "operations");
	return (
		Reflect.get(data, "version") === 1 &&
		typeof Reflect.get(data, "id") === "string" &&
		typeof Reflect.get(data, "operationsDigest") === "string" &&
		typeof origin === "object" &&
		origin !== null &&
		typeof Reflect.get(origin, "k") === "string" &&
		Array.isArray(operations) &&
		operations.every(
			(operation: unknown) =>
				typeof operation === "object" && operation !== null && typeof Reflect.get(operation, "class") === "string",
		)
	);
}

/**
 * Each kept draft on `branch` with its state. A draft stays pending until the owner's own words follow it: the owner's
 * run that answers them releases it by performing its operations (a recorded state), and once that run has ended a
 * draft it did not perform is dismissed. `ownerRunLive` names whether the run in progress is the owner's (its latest
 * owner words are still being answered).
 *
 * Owner-channel answers (`context`): a denial is final; a draft held on a remote-owner run expires
 * `OWNER_DRAFT_EXPIRY_MS` after it was prepared; the latest approval is active while its delivery is still queued (no
 * owner-channel entry with its `ref` on the branch and `isApprovalDeliveryPending(ref)`) or while the run that delivery
 * opened and decided is the run in progress (a later run inheriting its origin does not count), and has lapsed
 * otherwise, so the draft reads as it would without it. A state record
 * of a state this build does not know is skipped, never thrown on.
 */
export function outwardDraftStates(
	branch: readonly SessionEntry[],
	ownerRunLive: boolean,
	context: OutwardDraftStateContext = {},
): OutwardDraftStateView[] {
	const released = new Set<string>();
	const denied = new Set<string>();
	const approvals = new Map<string, { callDigest: string; by: OwnerDecisionByRecord; index: number }>();
	const drafts: { record: OutwardDraftRecord; index: number }[] = [];
	const channelRefs: { ref: string; index: number }[] = [];
	let latestOwnerWords = -1;
	const ownerWordsAfter: number[] = [];
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "custom" && entry.customType === OUTWARD_DRAFT_CUSTOM_TYPE) {
			const data: unknown = entry.data;
			if (isOutwardDraftRecord(data)) drafts.push({ record: data, index });
			continue;
		}
		if (entry.type === "custom" && entry.customType === OUTWARD_DRAFT_STATE_CUSTOM_TYPE) {
			const data: unknown = entry.data;
			if (typeof data !== "object" || data === null) continue;
			const id: unknown = Reflect.get(data, "id");
			const state = Reflect.get(data, "state");
			if (typeof id !== "string") continue;
			if (state === "released") released.add(id);
			else if (state === "denied") denied.add(id);
			else if (state === "approved") {
				const callDigest = stringField(data, "callDigest");
				const by = decisionBy(data);
				if (callDigest && by) approvals.set(id, { callDigest, by, index });
			}
			continue;
		}
		const origin = entryTurnOrigin(entry);
		if (origin?.k === "owner-typed") {
			latestOwnerWords = index;
			ownerWordsAfter.push(index);
		} else if (origin?.k === "owner-channel" && origin.ref !== undefined)
			channelRefs.push({ ref: origin.ref, index });
	}
	const now = context.nowMs ?? Date.now();
	const liveRun = context.liveRun;
	return drafts.map(({ record, index }): OutwardDraftStateView => {
		if (released.has(record.id)) return { record, state: "released", unexpiredState: "released" };
		if (denied.has(record.id)) return { record, state: "denied", unexpiredState: "denied" };
		// An unreadable preparation time counts as expired: an unanswered draft never waits forever.
		const expired =
			record.origin.k === "owner-channel" && !(now - Date.parse(record.preparedAt) < OWNER_DRAFT_EXPIRY_MS);
		const approval = approvals.get(record.id);
		const delivered =
			approval && channelRefs.some(({ ref, index: at }) => ref === approval.by.ref && at > approval.index);
		const approvalActive =
			approval !== undefined &&
			(delivered
				? liveRun?.decidedInRun === true &&
					liveRun.origin.k === "owner-channel" &&
					liveRun.origin.ref === approval.by.ref
				: context.isApprovalDeliveryPending?.(approval.by.ref) === true);
		let unexpiredState: "approved" | "pending" | "dismissed";
		if (approvalActive) unexpiredState = "approved";
		else {
			const answeredBy = ownerWordsAfter.find((ownerIndex) => ownerIndex > index);
			unexpiredState =
				answeredBy === undefined || (answeredBy === latestOwnerWords && ownerRunLive) ? "pending" : "dismissed";
		}
		if (expired) return { record, state: "expired", unexpiredState };
		return approvalActive && approval
			? { record, state: "approved", unexpiredState, approval: { callDigest: approval.callDigest, by: approval.by } }
			: { record, state: unexpiredState, unexpiredState };
	});
}

/** A draft as an owner channel shows it (`OwnerDraftView`). */
export function ownerDraftView(view: Pick<OutwardDraftStateView, "record" | "state">): OwnerDraftView {
	const { record } = view;
	return {
		id: record.id,
		classes: [...new Set(record.operations.map((operation) => operation.class))],
		toolName: record.toolName,
		rendering: record.callDigest !== undefined ? record.rendering : undefined,
		origin: record.origin,
		state: view.state,
		preparedAt: record.preparedAt,
	};
}

/**
 * Keeps one durable draft per held action and request on the branch (redacted, bounded), and returns its id with the
 * line the owner is told. `kept` is false when the branch already holds `MAX_OUTWARD_DRAFTS` pending drafts: the owner
 * is still told, and nothing is stored. `state` is the state of a draft the branch already held under this id.
 */
export function keepOutwardDraft(
	manager: Pick<SessionManager, "getBranch" | "appendCustomEntry">,
	draft: OutwardDraftInput,
): { id: string; notice: string; kept: boolean; added?: OutwardDraftRecord; state?: OutwardDraftState } {
	const operations = draft.operations.map((operation) => ({
		class: operation.class,
		operation: boundedRedactedDiagnosticText(operation.operation) ?? draft.toolName,
		reason: operation.reason,
	}));
	const branch = manager.getBranch();
	const request = latestDecisiveEntry(branch);
	const requestEntryId =
		request && (isThirdPartyOrigin(request.origin) || isRemoteOwnerOrigin(request.origin))
			? request.entry.id
			: undefined;
	// The whole operation names the draft (a digest reveals none of it); only its redacted first line is stored.
	const operationsDigest = outwardOperationsDigest(draft.toolName, draft.operations);
	// A draft held on a remote-owner run is bound to its complete call; a third party's draft keeps its operations' name.
	const remoteOwner = isRemoteOwnerOrigin(draft.origin);
	const callDigest = remoteOwner && draft.call ? ownerCallDigest(draft.call.toolName, draft.call.args) : undefined;
	const rendering =
		callDigest !== undefined && draft.call && draft.terminalOnly !== true
			? renderOwnerDraftCall(draft.call.toolName, draft.call.args)
			: undefined;
	const id = `draft-${createHash("sha256")
		.update(JSON.stringify([requestEntryId ?? null, callDigest ?? operationsDigest]))
		.digest("hex")
		.slice(0, 16)}`;
	const states = outwardDraftStates(branch, false);
	const existing = states.find(({ record }) => record.id === id);
	let kept = existing !== undefined;
	let added: OutwardDraftRecord | undefined;
	if (!kept && states.filter(({ state }) => state === "pending" || state === "approved").length < MAX_OUTWARD_DRAFTS) {
		kept = true;
		added = {
			version: 1,
			id,
			operationsDigest,
			...(requestEntryId !== undefined ? { requestEntryId } : {}),
			toolName: draft.toolName,
			operations,
			origin: draft.origin,
			preparedAt: new Date().toISOString(),
			...(callDigest !== undefined ? { callDigest } : {}),
			...(rendering !== undefined ? { rendering } : {}),
			...(remoteOwner && draft.ownerSender ? { ownerSender: draft.ownerSender } : {}),
		};
		manager.appendCustomEntry(OUTWARD_DRAFT_CUSTOM_TYPE, added);
	}
	const classes = [...new Set(operations.map((operation) => operation.class))];
	const grantable = grantableEdgeClasses(operations);
	// A notice is one bounded line (`MAX_RETAINED_DIAGNOSTIC_CHARS`): the action is shortened, never its origin or release.
	const action = operations.map((operation) => operation.operation).join("; ");
	return {
		id,
		kept,
		...(added ? { added } : {}),
		...(existing ? { state: existing.state } : {}),
		notice: boundedActionLine(
			"Held, not run: ",
			action,
			` (${classes.join(", ")}), asked by ${originLabel(draft.origin)}. It runs if you ask for it yourself${grantable.length > 0 ? `; ${grantable.map((edgeClass) => `/edge allow ${edgeClass}`).join(", ")} lets such runs do it` : ""}.`,
			MAX_RETAINED_DIAGNOSTIC_CHARS,
		),
	};
}

/** Records every pending (or approved) draft whose operations the owner's own run is about to perform as released. */
export function releaseOutwardDrafts(
	manager: Pick<SessionManager, "getBranch" | "getCustomEntriesOnBranch" | "appendCustomEntry">,
	toolName: string,
	readOperations: () => readonly EdgeOperation[],
): void {
	if (manager.getCustomEntriesOnBranch([OUTWARD_DRAFT_CUSTOM_TYPE]).length === 0) return;
	const pending = outwardDraftStates(manager.getBranch(), true).filter(
		({ state }) => state === "pending" || state === "approved",
	);
	if (pending.length === 0) return;
	const operations = readOperations();
	if (operations.length === 0) return;
	const digest = outwardOperationsDigest(toolName, operations);
	for (const { record } of pending) {
		if (record.operationsDigest === digest) appendOutwardDraftReleased(manager, record.id);
	}
}

/** Records draft `id` as released (performed). */
export function appendOutwardDraftReleased(manager: Pick<SessionManager, "appendCustomEntry">, id: string): void {
	const released: OutwardDraftStateRecord = { version: 1, id, state: "released", at: new Date().toISOString() };
	manager.appendCustomEntry(OUTWARD_DRAFT_STATE_CUSTOM_TYPE, released);
}

/** A refusal of a run carrying a third party's words: what was held and why, and the model's next action. */
interface ThirdPartyRefusal {
	/** The tool result's diagnostic, bounded by the failure record (`MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS`). */
	readonly reason: string;
	readonly correction: string;
}

/**
 * The prepared form of operations a run carrying a third party's words may not run: one durable draft and one owner
 * notice (`prepareOutward`), and a tool result that says what was held and from whom (the bounded diagnostic) and how
 * the owner releases it (the correction, shown as the record's next action).
 */
function prepareOutward(
	deps: SessionEdgeDeps,
	origin: TurnOriginRecord,
	toolName: string,
	operations: readonly EdgeOperation[],
): ThirdPartyRefusal {
	const prepared = deps.prepareOutward?.({ toolName, operations, origin });
	const actions = operations.map((operation) => `${operation.operation} (${operation.class}: ${operation.reason})`);
	const classes = [...new Set(operations.map((operation) => operation.class))];
	return {
		reason: boundedActionLine(
			"Prepared, not run: ",
			actions.join("; "),
			`, asked by ${originLabel(origin)}; no standing grant of the owner covers ${classes.join(", ")}.`,
			MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS,
		),
		// What the owner does, and what the model reports: never a gate to work around in this run.
		correction: [
			thirdPartyReleaseLine(operations),
			prepared?.id
				? `It is kept as draft ${prepared.id}.`
				: prepared
					? "No draft was kept: the session's pending drafts are full."
					: "This session keeps no drafts.",
			prepared?.told
				? "The owner is told with their next turn; report it in your answer and continue with the rest."
				: "No owner notice can be saved in this session: report the held action in your answer.",
		].join(" "),
	};
}

/**
 * The gate of a run that carries a third party's words, in front of every other edge rule (YOLO included: it is not
 * a grant). The owner's own decisions are refused; outward operations run only under the owner's standing grants and
 * are prepared otherwise. Deterministic: no model takes part.
 */
async function enforceThirdPartyEdge(
	deps: SessionEdgeDeps,
	origin: TurnOriginRecord,
	toolName: string,
	args: unknown,
	executionCwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BeforeToolCallResult | undefined> {
	const ownerOnly = ownerOnlyToolCallReason(toolName, args);
	if (ownerOnly) {
		deps.noteToolRefusal?.({
			tool: toolName,
			code: "third-party-owner-only",
			owner: "third-party gate",
			detail: ownerOnly,
		});
		return {
			block: true,
			reason: `Refused: ${ownerOnly}, which only the owner's own turn decides. This run carries words from ${originLabel(origin)}.`,
			correction: "Tell the owner what was asked instead.",
		};
	}
	const scopeCwd = deps.getCwd();
	const classified = classifyOutwardEdgeOperations({
		toolName,
		args,
		cwd: executionCwd ?? scopeCwd,
		scopeCwd,
		protectedWrites: deps.getProtectedWritePaths?.(),
	});
	if (classified.length === 0) return undefined;
	const operations = await resolveEdgeConditions(deps, classified, signal);
	const grants = effectiveEdgeGrants(deps);
	const ungranted = operations.filter((operation) => !isEdgeOperationGranted(operation, grants));
	if (ungranted.length === 0) return undefined;
	deps.noteToolRefusal?.({
		tool: toolName,
		code: "third-party-prepared",
		owner: "third-party gate",
		detail: `no standing grant covers ${[...new Set(ungranted.map((operation) => operation.class))].join(", ")}`,
	});
	return { block: true, ...prepareOutward(deps, origin, toolName, ungranted) };
}

const REMOTE_OWNER_GATE = "remote-owner gate";
const REMOTE_OWNER_ENDED = "the phone owner's authority ended";

/** The live check of a remote-owner run: the owner channel that opened it must still hold the owner's authority. */
function remoteOwnerEnded(
	deps: SessionEdgeDeps,
	origin: TurnOriginRecord,
	toolName: string,
): ThirdPartyRefusal | undefined {
	if (deps.isOwnerChannelLive?.(origin) === true) return undefined;
	deps.noteToolRefusal?.({ tool: toolName, code: "remote-owner-ended", owner: REMOTE_OWNER_GATE });
	return {
		reason: `Refused: ${REMOTE_OWNER_ENDED}; this run no longer acts for the owner.`,
		correction: "Stop and report what is left; the owner continues from the terminal or a new message.",
	};
}

function remoteOwnerTypedOnly(deps: SessionEdgeDeps, toolName: string, why: string): ThirdPartyRefusal {
	deps.noteToolRefusal?.({ tool: toolName, code: "remote-owner-typed-only", owner: REMOTE_OWNER_GATE, detail: why });
	return {
		reason: `Refused: ${why}, which only the owner's own turn at the terminal decides. This run was opened from an owner channel.`,
		correction: "Tell the owner what is needed; they do it at the terminal.",
	};
}

/**
 * Admits the call once when the owner approved exactly it from the owner channel for this run: the digest of the
 * complete call equals an active approval's `callDigest`, the approval's delivery opened and decided the run in
 * progress, and the draft has not expired. The approval is claimed for this call (`claimApprovedCall`) in the same
 * synchronous step as the branch read, so a parallel call with the same arguments finds it claimed (`in-use`) and a
 * repeat after the call ran finds it released; `released` itself is written once the call executed, and a refusal by a
 * later gate or a call the loop never starts frees the approval again. Arguments that cannot be tracked (not an object)
 * admit nothing: the call is held.
 */
function consumeOwnerApproval(
	deps: Pick<SessionEdgeDeps, "getBranch" | "getLiveRun" | "claimApprovedCall">,
	origin: TurnOriginRecord,
	call: EdgeCall,
): "admitted" | "in-use" | undefined {
	if (typeof call.args !== "object" || call.args === null || !deps.claimApprovedCall) return undefined;
	const digest = ownerCallDigest(call.toolName, call.args);
	const liveRun = deps.getLiveRun?.();
	const approved = outwardDraftStates(deps.getBranch(), false, liveRun ? { liveRun } : {}).filter(
		({ record, state, approval }) =>
			state === "approved" &&
			record.callDigest === digest &&
			approval?.callDigest === digest &&
			approval.by.ref === origin.ref,
	);
	let inUse = false;
	for (const { record } of approved) {
		const claim = deps.claimApprovedCall(record.id, call.args);
		if (claim === "claimed") return "admitted";
		inUse ||= claim === "in-use";
	}
	return inUse ? "in-use" : undefined;
}

/** The refusal of a call whose matching approval an identical call admitted earlier still holds. */
function approvalInUse(deps: SessionEdgeDeps, toolName: string): ThirdPartyRefusal {
	deps.noteToolRefusal?.({ tool: toolName, code: "remote-owner-approval-in-use", owner: REMOTE_OWNER_GATE });
	return {
		reason:
			"Not run: an identical call admitted earlier holds the owner's approval of this call, and its outcome is not known yet; one approval admits one call.",
		correction:
			"Wait for that call's result. If it ran, the approval is spent; if it did not run, the approval admits this call when it is issued again.",
	};
}

/**
 * The hold of a remote-owner run: one durable draft bound to the complete call (when there is one), the session notice
 * and the presentation on the owner's phone (`prepareOutward`), and a tool result that says what waits for approval.
 */
function holdForOwner(
	deps: SessionEdgeDeps,
	origin: TurnOriginRecord,
	toolName: string,
	operations: readonly EdgeOperation[],
	call: EdgeCall | undefined,
): ThirdPartyRefusal {
	const ownerSender = deps.ownerChannelSender?.(origin);
	// A toolkit script, or a call whose execution reaches the edge again with no call, would be held a second time after
	// an approval: only the terminal releases it.
	const terminalOnly =
		operations.some((operation) => operation.class === "toolkit.script") ||
		(call !== undefined && deps.holdsAgainAtExecution?.(call) === true);
	const prepared = deps.prepareOutward?.({
		toolName,
		operations,
		origin,
		...(call ? { call } : {}),
		...(ownerSender ? { ownerSender } : {}),
		...(terminalOnly ? { terminalOnly } : {}),
	});
	const classes = [...new Set(operations.map((operation) => operation.class))];
	const final =
		prepared?.id !== undefined && prepared.state !== undefined && OWNER_DRAFT_FINAL_STATES.has(prepared.state);
	deps.noteToolRefusal?.({
		tool: toolName,
		code: "remote-owner-held",
		owner: REMOTE_OWNER_GATE,
		detail: final ? `draft ${prepared?.state}` : `no grant covers ${classes.join(", ")}`,
	});
	return {
		reason: boundedActionLine(
			final ? "Not run: " : "Held for your approval: ",
			operations.map((operation) => `${operation.operation} (${operation.class}: ${operation.reason})`).join("; "),
			`, asked from ${originLabel(origin)}; no grant of the owner covers ${classes.join(", ")}.`,
			MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS,
		),
		correction: final
			? `Draft ${prepared?.id} is already ${prepared?.state} and cannot be approved. Report it in your answer and continue with the rest; the owner asks for it again in a new message or performs it at the terminal.`
			: [
					prepared?.id
						? terminalOnly
							? `It is kept as draft ${prepared.id}: only the owner at the terminal can perform it.`
							: `It is kept as draft ${prepared.id}: the owner approves it from the owner channel or performs it at the terminal.`
						: prepared
							? "No draft was kept: the session's pending drafts are full."
							: "This session keeps no drafts.",
					terminalOnly
						? "Report the held action in your answer and continue with the rest; do not issue it again from this run."
						: "Report the held action in your answer and continue with the rest; issue the same call again only once the owner approves it.",
				].join(" "),
	};
}

/**
 * The gate of a run opened from an owner channel (the owner's listed identity on a chat platform), in front of every
 * other edge rule (YOLO included: it stands for the owner at the terminal). In order: the live check; the hardline and
 * `edge.deny` patterns in every mode (a block refused, a confirmation held, never granted); the typed-only table and
 * settings authority, refused; the operations the outward classifier names (destructive and conditional
 * ones included) and the harness actions it does not classify, each against `remoteOwnerEdgeGrants`; the owner's
 * approval of exactly this call, consumed once; otherwise a held draft. No confirmation handler and no owner follow-up
 * take part, and no model decides.
 */
async function enforceRemoteOwnerEdge(
	deps: SessionEdgeDeps,
	origin: TurnOriginRecord,
	toolName: string,
	args: unknown,
	executionCwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BeforeToolCallResult | undefined> {
	const ended = remoteOwnerEnded(deps, origin, toolName);
	if (ended) return { block: true, ...ended };
	const scopeCwd = deps.getCwd();
	// The hardline and the owner's `edge.deny` patterns, in every mode: a block is refused, a confirmation is held.
	const boundary = classifyYoloBoundary({
		toolName,
		args,
		cwd: executionCwd ?? scopeCwd,
		scopeCwd,
		denyCommands: deps.getDenyCommands?.(),
	});
	if (boundary?.kind === "block") {
		deps.noteToolRefusal?.({
			tool: toolName,
			code: "remote-owner-hardline",
			owner: REMOTE_OWNER_GATE,
			detail: boundary.reason,
		});
		return { block: true, reason: `Refused: ${boundary.reason}.` };
	}
	const typedOnly = remoteOwnerTypedOnlyReason(toolName, args);
	if (typedOnly) return { block: true, ...remoteOwnerTypedOnly(deps, toolName, typedOnly) };
	const classified = classifyOutwardEdgeOperations({
		toolName,
		args,
		cwd: executionCwd ?? scopeCwd,
		scopeCwd,
		protectedWrites: deps.getProtectedWritePaths?.(),
	});
	const settings = remoteOwnerTypedOnlyOperation(classified);
	if (settings) return { block: true, ...remoteOwnerTypedOnly(deps, toolName, settings.reason) };
	const unclassified = remoteOwnerUnclassifiedAction(toolName, args);
	if (unclassified) classified.push(unclassified);
	// What YOLO asks the owner about on every call: no grant covers it here either, only the approval of this call.
	if (boundary?.kind === "confirm")
		classified.push({
			class: "destructive.fs",
			operation: String((args as { command?: unknown })?.command ?? toolName),
			reason: boundary.reason,
			ungrantable: true,
		});
	if (classified.length === 0) return undefined;
	const operations = await resolveEdgeConditions(deps, classified, signal);
	// The condition read may have waited: the owner channel's authority is read again before anything is admitted.
	const endedMeanwhile = remoteOwnerEnded(deps, origin, toolName);
	if (endedMeanwhile) return { block: true, ...endedMeanwhile };
	const grants = remoteOwnerEdgeGrants(deps);
	const ungranted = operations.filter((operation) => !isEdgeOperationGranted(operation, grants));
	if (ungranted.length === 0) return undefined;
	const call: EdgeCall = { toolName, args };
	const approval = consumeOwnerApproval(deps, origin, call);
	if (approval === "admitted") return undefined;
	if (approval === "in-use") return { block: true, ...approvalInUse(deps, toolName) };
	return { block: true, ...holdForOwner(deps, origin, toolName, ungranted, call) };
}

/** Revoke a session or instruction grant; a settings grant is the machine's. Returns whether one was removed. */
export function recordEdgeRevoke(deps: SessionEdgeDeps, edgeClass: EdgeClass, scopeKey?: string): boolean {
	const validatedScope = requireValidEdgeScope(scopeKey, "revoke");
	const current = sessionEdgeGrants(deps).filter((grant) => grant.class === edgeClass);
	if (current.length === 0 || current.every((grant) => grant.source === "settings")) return false;
	const record: EdgeRevokeRecord = {
		version: 1,
		class: edgeClass,
		...(validatedScope !== undefined ? { scopeKey: validatedScope } : {}),
		revokedAt: new Date().toISOString(),
	};
	deps.appendCustomEntry(EDGE_REVOKE_CUSTOM_TYPE, record);
	return true;
}

/**
 * Enforce the edge for a specific typed EdgeOperation.
 * Used by run_toolkit_script authorizer, composite child execution and the operation gate's operator question. On a
 * remote-owner run it never asks a handler or writes an owner follow-up: the operation runs under a remote-owner grant
 * or the owner's approval of exactly `call`, and is held as a draft otherwise (with no `call`, a draft only the
 * terminal performs).
 */
export async function enforceSessionEdgeOperation(
	deps: SessionEdgeDeps,
	operation: EdgeOperation,
	toolName = "operation",
	signal?: AbortSignal,
	call?: EdgeCall,
): Promise<{ authorized: boolean; decision?: EdgeDecision; reason?: string; correction?: string }> {
	const origin = thirdPartyRunOrigin(deps);
	if (origin) {
		return isEdgeOperationGranted(operation, effectiveEdgeGrants(deps))
			? { authorized: true }
			: { authorized: false, ...prepareOutward(deps, origin, toolName, [operation]) };
	}
	const remote = remoteOwnerRunOrigin(deps);
	if (remote) {
		const ended = remoteOwnerEnded(deps, remote, call?.toolName ?? toolName);
		if (ended) return { authorized: false, ...ended };
		if (remoteOwnerTypedOnlyOperation([operation]))
			return { authorized: false, ...remoteOwnerTypedOnly(deps, call?.toolName ?? toolName, operation.reason) };
		if (isEdgeOperationGranted(operation, remoteOwnerEdgeGrants(deps))) return { authorized: true };
		const approval = call ? consumeOwnerApproval(deps, remote, call) : undefined;
		if (approval === "admitted") return { authorized: true };
		if (approval === "in-use") return { authorized: false, ...approvalInUse(deps, call?.toolName ?? toolName) };
		return { authorized: false, ...holdForOwner(deps, remote, call?.toolName ?? toolName, [operation], call) };
	}
	if (deps.getMode?.() === "yolo") return { authorized: true };
	const grants = sessionEdgeGrants(deps);
	if (isEdgeOperationGranted(operation, grants)) {
		return { authorized: true };
	}
	const handler = deps.isChildSession() ? undefined : deps.getConfirmation();
	if (!handler) {
		const followUp = deps.isChildSession() ? undefined : deps.deferOwnerOperation?.(operation);
		return {
			authorized: false,
			reason: `${edgeBlockReason(operation, false)}${followUp ? ` Owner follow-up: ${followUp}.` : ""}`,
		};
	}
	const decision = await handler({ ...operation, toolName }, signal);
	signal?.throwIfAborted();
	if (decision === "deny") {
		return { authorized: false, decision, reason: edgeBlockReason(operation, true) };
	}
	if (decision === "allow-session") {
		recordEdgeGrant(deps, operation.class, "operator", {
			scopeKey: operation.scopeKey,
			note: "allowed at the prompt",
			prompt: true,
		});
	}
	return { authorized: true, decision };
}

/**
 * Drop every conditional operation whose condition does not hold right now. A condition is only
 * ever asked once per call. Its one condition guards an irreversible discard, so a condition that
 * cannot be evaluated keeps the operation: on an unknown state the operator decides (the authority
 * line's rule for an irreversible operation).
 */
async function resolveEdgeConditions(
	deps: SessionEdgeDeps,
	operations: readonly EdgeOperation[],
	signal: AbortSignal | undefined,
): Promise<EdgeOperation[]> {
	if (operations.every((operation) => operation.condition === undefined)) return [...operations];
	let unownedChanges: boolean | undefined;
	const resolved: EdgeOperation[] = [];
	for (const operation of operations) {
		if (operation.condition === undefined) {
			resolved.push(operation);
			continue;
		}
		if (unownedChanges === undefined) {
			unownedChanges = deps.mayHoldUnownedWorktreeChanges
				? await deps.mayHoldUnownedWorktreeChanges(signal).catch(() => true)
				: false;
			signal?.throwIfAborted();
		}
		if (unownedChanges) resolved.push(operation);
	}
	return resolved;
}

/**
 * Enforce the edge for one tool call. Ordinary work and granted classes pass; an ungranted class
 * asks the interactive host once (allow once, allow for the session, deny) and is blocked with the
 * reason when nobody can answer — a child session never asks. A call the owner's own run is allowed
 * to make releases the pending drafts it performs.
 */
export async function enforceSessionEdge(
	deps: SessionEdgeDeps,
	toolName: string,
	args: unknown,
	executionCwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BeforeToolCallResult | undefined> {
	const origin = thirdPartyRunOrigin(deps);
	if (origin) {
		const prepared = await enforceThirdPartyEdge(deps, origin, toolName, args, executionCwd, signal);
		return prepared ?? enforceEdgeRules(deps, toolName, args, executionCwd, signal);
	}
	// A run opened from an owner channel is decided by its own gate alone: YOLO, the confirmation handler and the
	// owner's terminal release stand for the owner at the terminal.
	const remote = remoteOwnerRunOrigin(deps);
	if (remote) return enforceRemoteOwnerEdge(deps, remote, toolName, args, executionCwd, signal);
	const decided = await enforceEdgeRules(deps, toolName, args, executionCwd, signal);
	if (!decided?.block && deps.releaseOutward) {
		const scopeCwd = deps.getCwd();
		deps.releaseOutward(toolName, () =>
			classifyOutwardEdgeOperations({
				toolName,
				args,
				cwd: executionCwd ?? scopeCwd,
				scopeCwd,
				protectedWrites: deps.getProtectedWritePaths?.(),
			}),
		);
	}
	return decided;
}

async function enforceEdgeRules(
	deps: SessionEdgeDeps,
	toolName: string,
	args: unknown,
	executionCwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BeforeToolCallResult | undefined> {
	const scopeCwd = deps.getCwd();
	if (deps.getMode?.() === "yolo") {
		const boundary = classifyYoloBoundary({
			toolName,
			args,
			cwd: executionCwd ?? scopeCwd,
			scopeCwd,
			denyCommands: deps.getDenyCommands?.(),
		});
		if (!boundary) return undefined;
		if (boundary.kind === "block") return { block: true, reason: `YOLO hardline: ${boundary.reason}` };
		const handler = deps.isChildSession() ? undefined : deps.getConfirmation();
		if (!handler) return { block: true, reason: `Owner approval required: ${boundary.reason}` };
		const decision = await handler(
			{
				class: "destructive.fs",
				operation: String((args as { command?: unknown })?.command ?? toolName),
				reason: boundary.reason,
				toolName,
			},
			signal,
		);
		signal?.throwIfAborted();
		return decision === "deny" ? { block: true, reason: `Owner denied: ${boundary.reason}` } : undefined;
	}
	const classified = classifyAllEdgeOperations(
		{ toolName, args, cwd: executionCwd ?? scopeCwd, scopeCwd },
		{ includeConditional: true },
	);
	if (classified.length === 0) return undefined;
	const operations = await resolveEdgeConditions(deps, classified, signal);
	if (operations.length === 0) return undefined;
	const grants = sessionEdgeGrants(deps);
	const ungranted = operations.filter((op) => !isEdgeOperationGranted(op, grants));
	if (ungranted.length === 0) return undefined;

	const allowOnceOps = new Set<EdgeOperation>();
	for (const operation of ungranted) {
		if (isEdgeOperationGranted(operation, sessionEdgeGrants(deps))) continue;
		const result = await enforceSessionEdgeOperation(deps, operation, toolName, signal);
		if (!result.authorized) {
			return { block: true, reason: result.reason, correction: result.correction };
		}
		if (result.decision === "allow-once") {
			allowOnceOps.add(operation);
		}
	}

	const currentGrants = sessionEdgeGrants(deps);
	for (const operation of operations) {
		if (allowOnceOps.has(operation)) continue;
		if (!isEdgeOperationGranted(operation, currentGrants)) {
			return { block: true, reason: edgeBlockReason(operation, false) };
		}
	}

	return undefined;
}
