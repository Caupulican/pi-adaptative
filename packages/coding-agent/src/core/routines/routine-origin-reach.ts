/**
 * Whether a routine's parent origin reaches the session open here: usable now, waiting (it may pass later), or lost (it can
 * provably never pass). The scheduler dispatches and delivers only under an origin usable now: this session's own file, the
 * anchor on the current branch, the anchor entry durable. A pending result whose origin is lost (the session file it names
 * is gone, or its anchor entry is absent from the durable session file, for example lost to a crash before it was written)
 * is settled undeliverable instead of waiting forever; one on another branch, not yet durable, in another existing file of
 * the session or under uncertain persistence waits.
 */
import { statSync } from "node:fs";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";

/** Why an origin can never pass: the session file it names is gone, or its anchor entry is absent from the session file. */
export type RoutineOriginLoss = "session-file-gone" | "origin-entry-absent";

export type RoutineOriginReach = "usable" | "waiting" | RoutineOriginLoss;

/** The delivery marker of a result settled because its origin is lost: the run's stored result keeps why it was not delivered. */
export function routineUndeliverableMarker(loss: RoutineOriginLoss): string {
	return `undeliverable:${loss}`;
}

/** The owner's one warning when a result is settled undeliverable, in the interface language. */
export function routineUndeliverableWarning(routineId: string, loss: RoutineOriginLoss): string {
	return interfaceText().notices.routineResultUndeliverable(routineId, loss);
}

/** Whether `path` provably does not exist. An unreadable path is not proof: it may be readable again. */
function fileMissing(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Whether the anchor entry is provably absent from this session: not in its entry graph (an entry on another branch or
 * buffered before the first flush is), and, for a persisted session, not in its durable file on disk either.
 */
function anchorEntryAbsent(manager: SessionManager, leafId: string): boolean {
	if (manager.getEntry(leafId) !== undefined) return false;
	// An in-memory session holds every entry it ever had.
	if (!manager.isPersisted()) return true;
	const sessionFile = manager.getSessionFile();
	if (!manager.hasDurableSessionFile() || sessionFile === undefined) return false;
	try {
		statSync(sessionFile);
	} catch {
		// The file cannot be read now, so its contents prove nothing.
		return false;
	}
	return !manager.isEntryPersisted(leafId);
}

/** Where `origin` stands for the session `manager` holds; `usable` is exactly the scheduler's origin gate. */
export function routineOriginReach(manager: SessionManager, origin: WorkerReceiptOrigin): RoutineOriginReach {
	if (origin.sessionId !== manager.getSessionId() || manager.isPersistenceStateUncertain()) return "waiting";
	const sessionFile = manager.getSessionFile();
	const sameFile = manager.isPersisted()
		? Boolean(sessionFile) && (origin.sessionFile === undefined || origin.sessionFile === sessionFile)
		: origin.sessionFile === undefined;
	if (!sameFile)
		return origin.sessionFile !== undefined && origin.sessionFile !== sessionFile && fileMissing(origin.sessionFile)
			? "session-file-gone"
			: "waiting";
	if (
		isSessionAppendAnchorCurrent(manager, origin) &&
		Boolean(origin.leafId && manager.isEntryDurableForSession(origin.leafId))
	)
		return "usable";
	return origin.leafId && anchorEntryAbsent(manager, origin.leafId) ? "origin-entry-absent" : "waiting";
}
