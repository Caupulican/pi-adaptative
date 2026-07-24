import { SessionReplacementCallbackError, SessionReplacementRuntimeError } from "../../core/agent-session-runtime.ts";

export type NonFatalSessionReplacementDisposition = "previous_restored" | "replacement_committed";

/** Single TUI policy for failures that still leave one valid, rebound session active. */
export function handleNonFatalSessionReplacementError(
	host: { renderCurrentSessionState(): void; showError(message: string): void },
	error: unknown,
): NonFatalSessionReplacementDisposition | undefined {
	const disposition =
		error instanceof SessionReplacementCallbackError
			? "replacement_committed"
			: error instanceof SessionReplacementRuntimeError && error.recovered
				? "previous_restored"
				: undefined;
	if (!disposition) return undefined;
	host.renderCurrentSessionState();
	host.showError(error instanceof Error ? error.message : String(error));
	return disposition;
}
