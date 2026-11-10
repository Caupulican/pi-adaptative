/**
 * The persistent sign that the session file refuses new writes. After a write fails in a way that leaves the file's
 * state unknown, the session refuses every append until the file is reopened; this keeps that visible in the footer
 * while it lasts and removes it when it lifts, and tells the owner once in full words when it starts.
 */

import { sessionSavePausedWords } from "../../core/autonomy-status/format.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";

export const SESSION_FENCE_STATUS_KEY = "session-save";

export interface PersistenceFenceIndicatorHost {
	readonly sessionManager: Pick<SessionManager, "isPersistenceStateUncertain" | "onPersistenceFenceChange">;
	readonly footerData: { setExtensionStatus(key: string, text: string | undefined): void };
	showWarning(message: string): void;
	/** Redraws the footer. */
	refresh(): void;
}

/**
 * Shows the footer sign while the session's fence is set, from the value it has now on. The listener only sets or clears
 * the sign and draws; it never writes to the session, since it runs inside the failed write. Returns the unsubscribe.
 */
export function bindPersistenceFenceIndicator(host: PersistenceFenceIndicatorHost): () => void {
	const sync = (): void => {
		const fenced = host.sessionManager.isPersistenceStateUncertain();
		host.footerData.setExtensionStatus(
			SESSION_FENCE_STATUS_KEY,
			fenced ? interfaceText().notices.savingPaused : undefined,
		);
		if (fenced) host.showWarning(sessionSavePausedWords());
		host.refresh();
	};
	sync();
	return host.sessionManager.onPersistenceFenceChange(sync);
}
