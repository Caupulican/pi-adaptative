/**
 * The edge, bound to one session: grants live on the branch, the confirmation handler belongs to
 * the interactive host, and a child session never asks. The coordinator (agent-session.ts) only
 * supplies these dependencies; the classification itself is `autonomy/edge-policy.ts`.
 */
import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import {
	classifyEdgeOperation,
	collectEdgeGrants,
	EDGE_GRANT_CUSTOM_TYPE,
	EDGE_REVOKE_CUSTOM_TYPE,
	type EdgeClass,
	type EdgeConfirmationHandler,
	type EdgeGrantRecord,
	type EdgeGrantView,
	type EdgeRevokeRecord,
	edgeBlockReason,
} from "./autonomy/edge-policy.ts";

export interface SessionEdgeDeps {
	getBranch(): readonly SessionEntry[];
	getSettingsAllow(): readonly string[];
	appendCustomEntry(customType: string, data: unknown): void;
	getCwd(): string;
	isChildSession(): boolean;
	getConfirmation(): EdgeConfirmationHandler | undefined;
}

export interface EdgeGrantDetails {
	note?: string;
	quote?: string;
	messageEntryId?: string;
}

/** Granted edge classes: settings first, then the branch's grant and revoke records in order. */
export function sessionEdgeGrants(deps: SessionEdgeDeps): EdgeGrantView[] {
	return collectEdgeGrants(deps.getBranch(), deps.getSettingsAllow());
}

/** Record a grant on the branch: the operator's decision here, or the model's citation of their words. */
export function recordEdgeGrant(
	deps: SessionEdgeDeps,
	edgeClass: EdgeClass,
	source: "operator" | "instructions",
	details: EdgeGrantDetails = {},
): void {
	const record: EdgeGrantRecord = {
		version: 1,
		class: edgeClass,
		source,
		...(details.quote ? { quote: details.quote } : {}),
		...(details.messageEntryId ? { messageEntryId: details.messageEntryId } : {}),
		...(details.note ? { note: details.note } : {}),
		grantedAt: new Date().toISOString(),
	};
	deps.appendCustomEntry(EDGE_GRANT_CUSTOM_TYPE, record);
}

/** Revoke a session or instruction grant; a settings grant is the machine's. Returns whether one was removed. */
export function recordEdgeRevoke(deps: SessionEdgeDeps, edgeClass: EdgeClass): boolean {
	const current = sessionEdgeGrants(deps).find((grant) => grant.class === edgeClass);
	if (!current || current.source === "settings") return false;
	const record: EdgeRevokeRecord = { version: 1, class: edgeClass, revokedAt: new Date().toISOString() };
	deps.appendCustomEntry(EDGE_REVOKE_CUSTOM_TYPE, record);
	return true;
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
	const operation = classifyEdgeOperation({ toolName, args, cwd: executionCwd ?? scopeCwd, scopeCwd });
	if (!operation) return undefined;
	if (sessionEdgeGrants(deps).some((grant) => grant.class === operation.class)) return undefined;
	const handler = deps.isChildSession() ? undefined : deps.getConfirmation();
	if (!handler) return { block: true, reason: edgeBlockReason(operation, false) };
	const decision = await handler({ ...operation, toolName }, signal);
	signal?.throwIfAborted();
	if (decision === "deny") return { block: true, reason: edgeBlockReason(operation, true) };
	if (decision === "allow-session")
		recordEdgeGrant(deps, operation.class, "operator", { note: "allowed at the prompt" });
	return undefined;
}
