/**
 * The AgentSession open's side of its session's lifetime lease: the lease it takes on a persisted session, and what the
 * open owes the owner. The open releases an interrupted retention of the session (one whose removal began and stopped,
 * an earlier build's cleanup, or one whose wholeness proof does not read), which may already have removed part of its
 * worker and plan state, and records
 * the release in the bundle (`session-cleanup-release.ts`); the owner is told so once, as a harness notice the release's
 * id names, so an open that ends before telling it leaves it for the next one. The lease and its admission are the
 * kernel's (`session-bundle-lifecycle.ts`).
 */

import { readSessionCleanupRelease } from "../kernel/session/session-cleanup-release.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentSession } from "./agent-session.ts";
import { type HarnessNotice, wordedNotice } from "./harness-notice.ts";
import {
	acquireSessionBundleLease,
	type SessionBundleLease,
	type SessionLeaseRole,
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
 * Observes, for the built session, the latest cancellation of an unfinished cleanup its bundle records (this open's or an
 * earlier one's) as a harness notice (`session-cleanup-released`): its reason carries the cancellation's id, so each is
 * told once, and a session opened again finds the notice already saved.
 */
export function observeSessionCleanupRelease(
	session: Pick<AgentSession, "observeHarnessNoticeOrWarn">,
	sessionManager: SessionManager,
): void {
	session.observeHarnessNoticeOrWarn("session-cleanup-released", () => sessionCleanupReleaseNotice(sessionManager));
}

function sessionCleanupReleaseNotice(sessionManager: SessionManager): HarnessNotice | undefined {
	if (!sessionManager.isPersisted()) return undefined;
	const sessionId = sessionManager.getSessionId();
	const release = readSessionCleanupRelease(sessionManager.getStorageRoots().orchestrationHome, sessionId);
	if (!release) return undefined;
	return wordedNotice(`cleanup-released:${release.releaseId}`, (words) =>
		words.sessions.retention.interruptedRetentionReleased(sessionId, words.sessions.retention.releasedByOpen),
	);
}
