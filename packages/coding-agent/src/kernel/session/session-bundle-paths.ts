import { createHash } from "node:crypto";
import { join } from "node:path";
import { stateFile } from "../storage/paths.ts";
import { requireBoundedTrimmedText } from "../utils/bounded-value.ts";

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
 * `<agentDir>/state/orchestration/sessions/<session-key>` -- the one durable control-plane
 * bundle owned by a foreground session. Event state, worker mailboxes, mutation journals, and
 * worker transcripts must stay beneath this boundary so explicit session deletion can remove
 * exactly its companion artifacts without scanning global state.
 */
export function orchestrationSessionsDir(agentDir: string): string {
	return stateFile(agentDir, "orchestration", "sessions");
}

/**
 * `<agentDir>/state/orchestration/sessions/<session-key>` -- the one durable control-plane
 * bundle owned by a foreground session.
 */
export function orchestrationSessionDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionsDir(agentDir), orchestrationSessionKey(parentSessionId));
}

/** Outside the deleted bundle: a durable tombstone prevents recreating deleted worker contexts. */
export function orchestrationSessionDeletionFile(agentDir: string, parentSessionId: string): string {
	return stateFile(agentDir, "orchestration", "deletions", `${orchestrationSessionKey(parentSessionId)}.json`);
}
