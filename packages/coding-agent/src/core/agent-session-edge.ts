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
	thirdPartyReleaseLine,
} from "./autonomy/edge-policy.ts";
import type { ToolDecision } from "./autonomy-status/tool-manifest.ts";
import { boundedRedactedDiagnosticText, MAX_RETAINED_DIAGNOSTIC_CHARS } from "./security/secret-text.ts";
import { entryTurnOrigin, isThirdPartyOrigin, latestDecisiveEntry, type TurnOriginRecord } from "./turn-origin.ts";

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
	/**
	 * Keeps operations a run carrying a third party's words may not run as one durable draft for the owner and tells
	 * the owner once (`keepOutwardDraft`); returns the draft's id (absent when the session's pending drafts are full) and
	 * whether the owner is actually told (false where no notice can be saved: an unpersisted or child session).
	 */
	prepareOutward?(draft: OutwardDraftInput): { readonly id?: string; readonly told: boolean };
	/**
	 * Records that the owner's own run performs a pending draft's operations (`releaseOutwardDrafts`); `operations` is
	 * read only while a draft is pending.
	 */
	releaseOutward?(toolName: string, operations: () => readonly EdgeOperation[]): void;
	/** Harness files and the session store, which a run carrying a third party's words does not write on its own. */
	getProtectedWritePaths?(): ProtectedWritePaths;
	/** Reports a call the third-party gate refused or prepared, for the run's tool manifest (`autonomy-status`). */
	noteToolRefusal?(decision: ToolDecision): void;
}

/** An outward action held for the owner, as the gate saw it. */
export interface OutwardDraftInput {
	readonly toolName: string;
	readonly operations: readonly EdgeOperation[];
	readonly origin: TurnOriginRecord;
}

export interface EdgeGrantDetails {
	note?: string;
	quote?: string;
	messageEntryId?: string;
	scopeKey?: string;
	/** The owner typed it (see `EdgeGrantRecord.standing`). */
	standing?: boolean;
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
		grantedAt: new Date().toISOString(),
	};
	deps.appendCustomEntry(EDGE_GRANT_CUSTOM_TYPE, record);
}

/** The run's origin when the run in progress carries a third party's words. */
function thirdPartyRunOrigin(deps: Pick<SessionEdgeDeps, "getRunOrigin">): TurnOriginRecord | undefined {
	const origin = deps.getRunOrigin?.();
	return isThirdPartyOrigin(origin) ? origin : undefined;
}

/** The grants the run in progress may use: on a run carrying a third party's words, only the owner's standing ones. */
export function effectiveEdgeGrants(
	deps: Pick<SessionEdgeDeps, "getEdgeRecords" | "getSettingsAllow" | "getThirdPartySettingsAllow" | "getRunOrigin">,
): EdgeGrantView[] {
	return thirdPartyRunOrigin(deps) ? standingEdgeGrants(deps) : sessionEdgeGrants(deps);
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

/** A draft is pending, released (the owner's own run performed it) or dismissed (the owner's own run ended without it). */
export type OutwardDraftState = "pending" | "released" | "dismissed";

export interface OutwardDraftRecord {
	readonly version: 1;
	/** The requesting message's entry and the operations: the same request asked again finds its draft, another adds one. */
	readonly id: string;
	/** The digest of the tool and its operations alone, which the owner's own run is matched against (`releaseOutwardDrafts`). */
	readonly operationsDigest: string;
	/** The entry of the third party's message that opened or steered the run, when the branch names one. */
	readonly requestEntryId?: string;
	readonly toolName: string;
	readonly operations: readonly { class: EdgeClass; operation: string; reason: string }[];
	readonly origin: TurnOriginRecord;
	readonly preparedAt: string;
}

/**
 * The recorded release of a kept draft, written when the owner's own run performs it. Dismissal is not written: it
 * follows from the branch (the owner's words after the draft, and the end of the run answering them).
 */
export interface OutwardDraftStateRecord {
	readonly version: 1;
	readonly id: string;
	readonly state: "released";
	readonly at: string;
}

function outwardOperationsDigest(toolName: string, operations: readonly EdgeOperation[]): string {
	return createHash("sha256")
		.update(JSON.stringify([toolName, operations.map((operation) => [operation.class, operation.operation])]))
		.digest("hex")
		.slice(0, 16);
}

function isOutwardDraftRecord(data: unknown): data is OutwardDraftRecord {
	return (
		typeof data === "object" &&
		data !== null &&
		Reflect.get(data, "version") === 1 &&
		typeof Reflect.get(data, "id") === "string" &&
		typeof Reflect.get(data, "operationsDigest") === "string"
	);
}

/**
 * Each kept draft on `branch` with its state. A draft stays pending until the owner's own words follow it: the owner's
 * run that answers them releases it by performing its operations (a recorded state), and once that run has ended a
 * draft it did not perform is dismissed. `ownerRunLive` names whether the run in progress is the owner's (its latest
 * owner words are still being answered).
 */
export function outwardDraftStates(
	branch: readonly SessionEntry[],
	ownerRunLive: boolean,
): { readonly record: OutwardDraftRecord; readonly state: OutwardDraftState }[] {
	const released = new Set<string>();
	const drafts: { record: OutwardDraftRecord; index: number }[] = [];
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
			const id = typeof data === "object" && data !== null ? Reflect.get(data, "id") : undefined;
			if (typeof id === "string" && Reflect.get(data as object, "state") === "released") released.add(id);
			continue;
		}
		if (entryTurnOrigin(entry)?.k === "owner-typed") {
			latestOwnerWords = index;
			ownerWordsAfter.push(index);
		}
	}
	return drafts.map(({ record, index }) => {
		if (released.has(record.id)) return { record, state: "released" as const };
		const answeredBy = ownerWordsAfter.find((ownerIndex) => ownerIndex > index);
		if (answeredBy === undefined || (answeredBy === latestOwnerWords && ownerRunLive))
			return { record, state: "pending" as const };
		return { record, state: "dismissed" as const };
	});
}

/**
 * Keeps one durable draft per held action and request on the branch (redacted, bounded), and returns its id with the
 * line the owner is told. `kept` is false when the branch already holds `MAX_OUTWARD_DRAFTS` pending drafts: the owner
 * is still told, and nothing is stored.
 */
export function keepOutwardDraft(
	manager: Pick<SessionManager, "getBranch" | "appendCustomEntry">,
	draft: OutwardDraftInput,
): { id: string; notice: string; kept: boolean } {
	const operations = draft.operations.map((operation) => ({
		class: operation.class,
		operation: boundedRedactedDiagnosticText(operation.operation) ?? draft.toolName,
		reason: operation.reason,
	}));
	const branch = manager.getBranch();
	const request = latestDecisiveEntry(branch);
	const requestEntryId = request && isThirdPartyOrigin(request.origin) ? request.entry.id : undefined;
	// The whole operation names the draft (a digest reveals none of it); only its redacted first line is stored.
	const operationsDigest = outwardOperationsDigest(draft.toolName, draft.operations);
	const id = `draft-${createHash("sha256")
		.update(JSON.stringify([requestEntryId ?? null, operationsDigest]))
		.digest("hex")
		.slice(0, 16)}`;
	const states = outwardDraftStates(branch, false);
	let kept = states.some(({ record }) => record.id === id);
	if (!kept && states.filter(({ state }) => state === "pending").length < MAX_OUTWARD_DRAFTS) {
		kept = true;
		const record: OutwardDraftRecord = {
			version: 1,
			id,
			operationsDigest,
			...(requestEntryId !== undefined ? { requestEntryId } : {}),
			toolName: draft.toolName,
			operations,
			origin: draft.origin,
			preparedAt: new Date().toISOString(),
		};
		manager.appendCustomEntry(OUTWARD_DRAFT_CUSTOM_TYPE, record);
	}
	const classes = [...new Set(operations.map((operation) => operation.class))];
	const grantable = grantableEdgeClasses(operations);
	// A notice is one bounded line (`MAX_RETAINED_DIAGNOSTIC_CHARS`): the action is shortened, never its origin or release.
	const action = operations.map((operation) => operation.operation).join("; ");
	return {
		id,
		kept,
		notice: boundedActionLine(
			"Held, not run: ",
			action,
			` (${classes.join(", ")}), asked by ${originLabel(draft.origin)}. It runs if you ask for it yourself${grantable.length > 0 ? `; ${grantable.map((edgeClass) => `/edge allow ${edgeClass}`).join(", ")} lets such runs do it` : ""}.`,
			MAX_RETAINED_DIAGNOSTIC_CHARS,
		),
	};
}

/** Records every pending draft whose operations the owner's own run is about to perform as released. */
export function releaseOutwardDrafts(
	manager: Pick<SessionManager, "getBranch" | "getCustomEntriesOnBranch" | "appendCustomEntry">,
	toolName: string,
	readOperations: () => readonly EdgeOperation[],
): void {
	if (manager.getCustomEntriesOnBranch([OUTWARD_DRAFT_CUSTOM_TYPE]).length === 0) return;
	const pending = outwardDraftStates(manager.getBranch(), true).filter(({ state }) => state === "pending");
	if (pending.length === 0) return;
	const operations = readOperations();
	if (operations.length === 0) return;
	const digest = outwardOperationsDigest(toolName, operations);
	for (const { record } of pending) {
		if (record.operationsDigest !== digest) continue;
		const released: OutwardDraftStateRecord = {
			version: 1,
			id: record.id,
			state: "released",
			at: new Date().toISOString(),
		};
		manager.appendCustomEntry(OUTWARD_DRAFT_STATE_CUSTOM_TYPE, released);
	}
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
 * Used by run_toolkit_script authorizer and composite child execution.
 */
export async function enforceSessionEdgeOperation(
	deps: SessionEdgeDeps,
	operation: EdgeOperation,
	toolName = "operation",
	signal?: AbortSignal,
): Promise<{ authorized: boolean; decision?: EdgeDecision; reason?: string; correction?: string }> {
	const origin = thirdPartyRunOrigin(deps);
	if (origin) {
		return isEdgeOperationGranted(operation, effectiveEdgeGrants(deps))
			? { authorized: true }
			: { authorized: false, ...prepareOutward(deps, origin, toolName, [operation]) };
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
