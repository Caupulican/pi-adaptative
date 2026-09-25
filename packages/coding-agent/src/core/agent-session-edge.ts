/**
 * The edge, bound to one session: grants live on the branch, the confirmation handler belongs to
 * the interactive host, and a child session never asks. The coordinator (agent-session.ts) only
 * supplies these dependencies; the classification itself is `autonomy/edge-policy.ts`.
 */
import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import {
	classifyAllEdgeOperations,
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
	isEdgeOperationGranted,
	parseEdgeScope,
} from "./autonomy/edge-policy.ts";

export interface SessionEdgeDeps {
	getBranch(): readonly SessionEntry[];
	/** The branch's edge grant and revoke records in order, read incrementally (see `getCustomEntriesOnBranch`). */
	getEdgeRecords(): readonly SessionEntry[];
	getSettingsAllow(): readonly string[];
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
}

export interface EdgeGrantDetails {
	note?: string;
	quote?: string;
	messageEntryId?: string;
	scopeKey?: string;
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

/** Granted edge classes: settings first, then the branch's grant and revoke records in order. */
export function sessionEdgeGrants(deps: SessionEdgeDeps): EdgeGrantView[] {
	return collectEdgeGrants(deps.getEdgeRecords(), deps.getSettingsAllow());
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
		grantedAt: new Date().toISOString(),
	};
	deps.appendCustomEntry(EDGE_GRANT_CUSTOM_TYPE, record);
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
): Promise<{ authorized: boolean; decision?: EdgeDecision; reason?: string }> {
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
 * reason when nobody can answer — a child session never asks.
 */
export async function enforceSessionEdge(
	deps: SessionEdgeDeps,
	toolName: string,
	args: unknown,
	executionCwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<BeforeToolCallResult | undefined> {
	const scopeCwd = deps.getCwd();
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
			return { block: true, reason: result.reason };
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
