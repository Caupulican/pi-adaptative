import type { SessionEntriesPersistedListener, SessionManager } from "../kernel/session/session-manager.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";

/** Distinct observer failures one session reports; a later one would only repeat a broken observer's noise. */
const MAX_OBSERVER_FAILURE_WARNINGS = 8;

/**
 * Reports each distinct failure of a session persistence observer (same observer and same message once) as a warning,
 * at most eight per session id. The write the observer saw is already committed and stays; the observer is not retried.
 * The warning is emitted past the write's stack, never inside the transaction that announced the entries.
 */
export function reportSessionObserverFailures(manager: SessionManager, warn: (message: string) => void): () => void {
	let sessionId: string | undefined;
	let reported = 0;
	let seen = new WeakMap<SessionEntriesPersistedListener, Set<string>>();
	return manager.onObserverError((observer, error) => {
		if (manager.getSessionId() !== sessionId) {
			sessionId = manager.getSessionId();
			reported = 0;
			seen = new WeakMap();
		}
		if (reported >= MAX_OBSERVER_FAILURE_WARNINGS) return;
		const detail =
			boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "no message";
		const details = seen.get(observer) ?? new Set<string>();
		if (details.has(detail)) return;
		details.add(detail);
		seen.set(observer, details);
		reported++;
		const last =
			reported === MAX_OBSERVER_FAILURE_WARNINGS ? " Later observer failures in this session are not reported." : "";
		const message = `A session persistence observer failed; the write it observed is kept: ${detail}${last}`;
		queueMicrotask(() => {
			try {
				warn(message);
			} catch {
				// A diagnostic never fails the session that reports it.
			}
		});
	});
}
