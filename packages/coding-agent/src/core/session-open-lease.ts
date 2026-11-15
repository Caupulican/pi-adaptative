/**
 * The AgentSession open's side of its session's lifetime lease: the lease it takes on a persisted session, and what the
 * open owes the owner. The open releases an interrupted retention of the session (an earlier build's cleanup, or one
 * whose wholeness proof does not read), which may already have removed part of its worker and plan state, and the owner
 * is told so once. The lease and its admission are the kernel's (`session-bundle-lifecycle.ts`).
 */

import type { SessionManager } from "../kernel/session/session-manager.ts";
import { interfaceText } from "./language/interface-text.ts";
import {
	acquireSessionBundleLease,
	type SessionBundleLease,
	type SessionLeaseRole,
	takeReleasedInterruptedRetention,
} from "./orchestration/session-bundle-lifecycle.ts";
import { managerSessionHomeNow } from "./orchestration-homes.ts";

/**
 * The open's lease on its session, in the home its manager's roots name; none for a session that is not persisted. A
 * session a channel or bot host holds is refused (`SessionHostedError`): theirs is that host's own.
 */
export function acquireOpeningSessionLease(
	sessionManager: SessionManager,
	role: SessionLeaseRole,
): SessionBundleLease | undefined {
	if (!sessionManager.isPersisted()) return undefined;
	return acquireSessionBundleLease(sessionManager.getStorageRoots().orchestrationHome, sessionManager.getSessionId(), {
		role,
		opening: true,
		homeNow: managerSessionHomeNow(sessionManager),
	});
}

/**
 * Tells the opened session's owner, once, that an open of it in this process released an interrupted retention of its
 * bundle: this open's, or a session switch's, which takes its lease before it builds the session.
 */
export function tellReleasedInterruptedRetention(
	sessionManager: SessionManager,
	warn: (message: string) => void,
): void {
	const sessionId = sessionManager.getSessionId();
	if (
		sessionManager.isPersisted() &&
		takeReleasedInterruptedRetention(sessionManager.getStorageRoots().orchestrationHome, sessionId)
	)
		warn(interfaceText().sessions.retention.interruptedRetentionReleased(sessionId));
}
