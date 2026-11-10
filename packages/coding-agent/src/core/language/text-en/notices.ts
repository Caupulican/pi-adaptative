/**
 * The English notices the host writes on screen: the error and warning lines it wraps around a failure, what a
 * compaction and a retry say as they start, end and fall back, and the one-line notices of the start-up checks. Nothing
 * here reaches a model: a message that a tool or a provider wrote is handed in whole and keeps its own words.
 */

export const NOTICES = {
	/** The announcement a command draws: its headline and the line above the link it carries. */
	earendilJoined: "pi has joined Earendil",
	earendilReadPost: "Read the blog post:",
	/** The colour frame around a message the host caught from somewhere else. */
	error: (message: string) => `Error: ${message}`,
	warning: (message: string) => `Warning: ${message}`,
	toCancel: (keys: string) => `(${keys} to cancel)`,
	/** A failure the host caught with no message of its own. */
	unknownErrorOccurred: "Unknown error occurred",
	unknownError: "Unknown error",
	/** The single word a failed turn leaves where its tool results were. */
	errorWord: "Error",

	/** A compaction: why it stopped, how it ended, and what it kept when it fell back. */
	compactionCancelled: "Compaction cancelled",
	compactionFailed: "Compaction failed",
	contextCompacted: "Context compacted",
	contextCompactedWithFallback: (cause: string) => `Context compacted (fallback: ${cause})`,
	compactionFallbackLost: (cause: string) =>
		`Compaction fell back to a simpler checkpoint (${cause}): the narrative summary was lost; only files and task facts were kept.`,
	compactionSkipped: (reason: string) => `Compaction skipped · ${reason}`,
	compactingContext: (cancelHint: string) => `Compacting context ${cancelHint}`,
	autoCompacting: (overflow: boolean, cancelHint: string) =>
		`${overflow ? "Context overflow · " : ""}Auto-compacting ${cancelHint}`,
	/** Why the summary model could not be used, by the reason the compaction reports. */
	compactionFallbackCause: (cause: string) =>
		(
			({
				unresolved: "the summary model is not configured",
				unauthed: "the summary model has no credentials",
				exhausted: "the summary model's quota is used up",
			}) as Readonly<Record<string, string>>
		)[cause] ?? "the summary model was unavailable",

	/** A retry the harness scheduled after a transient failure. */
	retryCountdown: (attempt: number, maxAttempts: number, seconds: number, keys: string) =>
		`Retry ${attempt}/${maxAttempts} in ${seconds}s · ${keys} cancel`,
	retryFailed: (attempts: number, error: string) => `Retry failed after ${attempts} attempts: ${error}`,

	/** A rejection nobody awaited: the session lives on. */
	unhandledRejection: (headline: string) => `Unhandled promise rejection — session kept alive. ${headline}`,

	/** The start-up checks. */
	migratedCredentials: (providers: string) => `Migrated credentials to auth.json: ${providers}`,
	modelsJsonError: (error: string) => `models.json error: ${error}`,
	themeLoadFailed: (theme: string, error: string) =>
		`Failed to load theme "${theme}": ${error}\nFell back to dark theme.`,
	autoLearnOfferFailed: (error: string) => `Auto Learn re-offer failed: ${error}`,
	historyLoadFailed: (error: string) => `Failed to load TUI history: ${error}`,
	pendingInputResumeFailed: (error: string) => `Failed to resume pending user input: ${error}`,
	curatorArchived: (count: number, names: string) =>
		`Curator: auto-archived ${count} stale skill(s) — ${names}. Restore with /curate restore <name>.`,

	/** The fence that keeps a paused session from writing to disk, and the way back into it. */

	/** The frames the host puts in front of a failure a handler or an extension reported. */
	shortcutHandlerError: (message: string) => `Shortcut handler error: ${message}`,
	terminalInputHandlerError: (message: string) => `Terminal input handler error: ${message}`,
	handlerFailed: "Handler failed.",
	extensionError: (extension: string, error: string) => `Extension "${extension}" error: ${error}`,

	savingPaused: "Saving paused: /resume reopens this session",
	/** The whole story of a paused session file, told once when the fence lifts. */
	sessionSavePaused:
		"Saving is paused: the last write to this session's file did not finish cleanly, so nothing more is saved until the file is reopened. What is on screen stays. Use /resume and choose this session to reopen it, or /new to start a new one.",
	resumeThisSession: "To resume this session:",

	/** What the terminal cannot do, said where the gesture was asked for. */
	suspendUnsupported: "Suspend to background is not supported on Windows",

	/** The two frames the host puts in front of a failure that ended the session. */
	failedToCreateSession: "Failed to create session",
	failedToForkSession: "Failed to fork session",

	/** What a widget the extension drew too tall to keep becomes at the top of its frame. */
	widgetTruncated: "... (widget truncated)",
	/** The billing notice under a session signed in with a subscription key. */
	anthropicSubscriptionAuth:
		"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.",
	/** What the collaboration extension reports when its own steps fail: the error text follows. */
	collaboration: {
		controlHandoffFailed: (error: string) => `Collaboration control handoff failed: ${error}`,
		cleanupExhausted: (jobId: string, agentId: string, error: string) =>
			`Collaboration cleanup exhausted for ${jobId}/${agentId}; live work remains fenced: ${error}`,
		peerDeliveryFailed: (error: string) => `Collaboration peer delivery failed: ${error}`,
		handoffFailed: (error: string) => `Collaboration handoff failed: ${error}`,
		signalFailed: (error: string) => `Collaboration signal failed: ${error}`,
		restorationFailed: (error: string) => `Collaboration restoration failed: ${error}`,
		paneUnverified: (paneId: string, reason: string) =>
			`Herdr pane ${paneId} could not be verified (${reason}); placement falls back to managed-workspace.`,
	},
};
