import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { stateFile } from "../storage/paths.ts";
import { requireBoundedTrimmedText } from "../utils/bounded-value.ts";

const orchestrationHomeBrand: unique symbol = Symbol("orchestration-home");

/**
 * The directory that holds the orchestration state of the sessions rooted in it: one bundle per
 * session under `sessions/`, and the deletion tombstones and lifetime leases under `deletions/`.
 * Every bundle path is built from a home, never from an agentDir, so the place a session's bundle
 * lives is decided once, where the session is composed. Only the constructors below make one.
 */
export interface OrchestrationHome {
	readonly root: string;
	readonly [orchestrationHomeBrand]: true;
}

function orchestrationHomeAt(root: string): OrchestrationHome {
	return Object.freeze({ root, [orchestrationHomeBrand]: true as const });
}

/** `<agentDir>/state/orchestration` -- the owner's orchestration home. */
export function ownerOrchestrationHome(agentDir: string): OrchestrationHome {
	return orchestrationHomeAt(stateFile(agentDir, "orchestration"));
}

/** The same home with an absolute root, for state compared or recorded across working directories. */
export function resolvedOrchestrationHome(home: OrchestrationHome): OrchestrationHome {
	return orchestrationHomeAt(resolve(home.root));
}

function orchestrationSessionKey(parentSessionId: string): string {
	const normalized = requireBoundedTrimmedText(parentSessionId, 512, "Parent session id");
	const readable =
		encodeURIComponent(normalized)
			.replaceAll("%", "_")
			// encodeURIComponent deliberately leaves `*` unescaped, but Windows forbids it in paths.
			// Restrict the readable prefix to a portable ASCII subset; the digest retains exact identity.
			.replaceAll(/[^a-zA-Z0-9._~-]/g, "_")
			.slice(0, 80) || "session";
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return `${readable}-${digest}`;
}

/**
 * `<home>/sessions` -- the durable control-plane bundles of the sessions rooted in `home`. Event
 * state, worker mailboxes, mutation journals, and worker transcripts must stay beneath a session's
 * bundle so explicit session deletion can remove exactly its companion artifacts without scanning
 * global state.
 */
export function orchestrationSessionsDir(home: OrchestrationHome): string {
	return join(home.root, "sessions");
}

/**
 * `<home>/sessions/<session-key>` -- the one durable control-plane bundle owned by a foreground
 * session.
 */
export function orchestrationSessionDir(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionsDir(home), orchestrationSessionKey(parentSessionId));
}

/**
 * `<home>/deletions/<session-key>.json` -- outside the deleted bundle: a durable tombstone prevents
 * recreating deleted worker contexts.
 */
export function orchestrationSessionDeletionFile(home: OrchestrationHome, parentSessionId: string): string {
	return join(home.root, "deletions", `${orchestrationSessionKey(parentSessionId)}.json`);
}

/**
 * `<orchestrationSessionDir>/worker-conversations` -- durable Pi worker transcripts owned by one
 * foreground session. Worker conversations remain in SessionManager's established JSONL format,
 * but are intentionally outside the foreground session picker namespace.
 */
export function workerConversationSessionsDir(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionDir(home, parentSessionId), "worker-conversations");
}
