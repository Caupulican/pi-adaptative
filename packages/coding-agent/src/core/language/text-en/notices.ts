/**
 * The English notices the host writes on screen: the error and warning lines it wraps around a failure, what a
 * compaction and a retry say as they start, end and fall back, and the one-line notices of the start-up checks. Nothing
 * here reaches a model, except the harness notice sentences (`wordedNotice` in `harness-notice.ts`), which the model reads
 * in English while the owner reads them in the interface language: a message that a tool or a provider wrote is handed in
 * whole and keeps its own words.
 */

import type { UnansweredReason } from "../../channels/batch-outcome.ts";
import type { ChannelGapRecord } from "../../channels/channel-journal.ts";
import type { KnowledgeNoticeReason } from "../../context/memory-diagnostics.ts";
import type { HostEventReplayGap } from "../../events/host-event-contract.ts";
import type { ExternalKeep } from "../../orchestration/retention.ts";
import type { RetentionHold } from "../../orchestration/retention-eligibility.ts";
import type { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../../system-one/semantic-plane-health.ts";
import type { TurnOriginRecord } from "../../turn-origin.ts";

/** What the owner can do about a paused knowledge collection, as the sentence after its cause. */
const KNOWLEDGE_ACTIONS: Readonly<Record<KnowledgeNoticeReason, string>> = {
	invalid_settings:
		" Fix autoLearn.knowledgeMaxUsd, knowledgeSessionMaxUsd, knowledgeIdleDelayMs or knowledgeMaxSourcesPerPass.",
	no_model: " Set autoLearn.model to a configured, signed-in model.",
	model_unpriced: " Set autoLearn.model to a model with a declared price.",
	no_engine: "",
};

/** What a paused routine intake leaves working, as the sentence after its cause. */
const INTAKE_UNREAD =
	"Requests for automatic work in the owner's messages are not read while this lasts; the routine tool still works.";

/** Why a closed objective stays, in the words the refusal uses. Every projection hold has one. */
const HOLD_WORDS: Readonly<Record<RetentionHold, string>> = {
	unfinished_task: "with an unfinished or unverified task",
	live_attempt: "with a turn still running",
	pending_notice: "with a notice not yet delivered",
	pending_approval: "with an approval pending",
	open_plan: "under an open plan",
	receipt_outbox: "with a result or charge not yet received by the parent",
	awaiting_parent: "whose last result the parent has not yet answered",
	host_event_custody: "with host events still in flight",
	resume_basis: "that an active agent resumes from",
	managed_lane: "whose managed worker is not retired",
	tree_live: "whose worker tree is still running",
	referenced: "that retained work depends on",
};

/** The words each external keep reads as, in the store-full notice and in the refusal texts. */
const EXTERNAL_KEEP_WORDS: Readonly<Record<ExternalKeep, string>> = {
	outcome_undelivered: "with an outcome not yet delivered to its parent",
	delegated_message_pending: "with a delegated message still pending",
	follower_open: "with a follower still open",
	current_goal: "that is the current goal",
	delegation_open_parent: "under an open parent delegation",
	legacy_window: "inside an open delegation's window",
	agent_message_pending: "with a message queued for one of its agents",
};

/** Why CI results never reached a session, by the reason its replay gap records. */
const GAP_CAUSES: Readonly<Record<HostEventReplayGap["reason"], string>> = {
	consumer_expired: "this session's event custody expired after it stayed closed for 7 days",
	consumer_evicted: "this session's event custody was removed while it was closed to make room for live sessions",
	consumer_inactive: "this session's saved event position is older than the source's retained history",
};

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
	/** A watch saved on your approval whose use could not be recorded, and whose save could not be undone either. */
	watchArmedApprovalUnrecorded: (watchId: string, cause: string) =>
		`Watch "${watchId}" is armed, but the use of your approval of its check could not be recorded and undoing the save failed too (${cause}). The approval is not marked as used; delete the watch if it should not run.`,
	/** Why a routine result can never reach the session it was addressed to (`routine-origin-reach.ts`). */
	routineOriginLoss: (loss: "session-file-gone" | "origin-entry-absent"): string =>
		loss === "session-file-gone"
			? "the session file it was addressed to no longer exists"
			: "the point of this conversation it was addressed to is missing from the session file, for example lost in a crash before it was written",
	/**
	 * The routine states a session's scheduler tells as harness notices (`routine-state-notices.ts`): one sentence each, the
	 * model's line worded with the English catalogue and the owner's with the interface language.
	 */
	routineStates: {
		paused: (routineId: string, after: number) =>
			`Routine ${routineId} was paused after ${after} failed runs in a row and stays paused until the owner resumes it.`,
		unschedulable: (routineId: string, timeZone: string) =>
			`Routine ${routineId} cannot be scheduled: time zone ${JSON.stringify(timeZone)} is not supported by this runtime, so it does not run until the owner changes the zone or a runtime that supports it opens the session.`,
		/** `held`: the routine runs nothing now (paused after failed runs, or off), so the note reaches its first run after that. */
		snag: (routineId: string, seenCount: number, held: "paused" | "off" | undefined): string => {
			const stumbling = `keeps stumbling on the same thing (${seenCount} runs so far).`;
			if (held === undefined)
				return `Routine ${routineId} ${stumbling} A note through the routine tool reaches its next run.`;
			const state = held === "paused" ? "paused until the owner resumes it" : "off until the owner enables it";
			return `Routine ${routineId} is ${state}; a note through the routine tool reaches its first run after that. It ${stumbling}`;
		},
		/** `why`: the loss, worded by `routineOriginLoss` of the same catalogue. */
		resultUndeliverable: (routineId: string, why: string) =>
			`A result of routine ${routineId} can never reach this session, so it no longer waits for delivery: ${why}.`,
		removedOriginLost: (routineId: string) =>
			`Routine ${routineId} was removed: the point of this session it was saved at can never be reached again (its session file is gone, or its entry is missing from the session file), so none of its runs could ever report here. Save it again to keep it running.`,
	},

	/**
	 * The knowledge collection's paused states (`memory-diagnostics.ts`). `cause` is the domain's English sentence for the
	 * reason, which the English line keeps.
	 */
	knowledgeCollection: {
		paused: (reason: KnowledgeNoticeReason, cause: string): string =>
			`Automatic knowledge collection paused because ${cause}.${KNOWLEDGE_ACTIONS[reason]}`,
		sessionSpent: (cause: string): string =>
			`Automatic knowledge collection paused because ${cause} (autoLearn.knowledgeSessionMaxUsd). Raise autoLearn.knowledgeSessionMaxUsd to resume it in this session.`,
		sourceUnpaid:
			"Automatic knowledge collection paused because autoLearn.knowledgeMaxUsd is zero, so no source can be paid for. Raise autoLearn.knowledgeMaxUsd to resume it.",
		capReached:
			"Automatic knowledge collection paused because this session's estimated cost cap allows no further spend.",
	},
	/** A proactive review that did not start for a cause the owner can act on (`proactivity-controller.ts`). */
	proactiveReview: {
		spendReached:
			"Proactive review paused because review spend over the last 24 hours, across this agent's sessions, reached proactivity.maxUsdPerDay. Reviews start again once older spend leaves the rolling day, or sooner if that setting is raised.",
		modelUnresolved: (model: string) =>
			`Proactive review paused because proactivity.model ${JSON.stringify(model)} does not resolve to an available model. Set proactivity.model to a configured, signed-in model, or remove it to use the session model.`,
		modelTooSmall:
			"Proactive review paused because its model's capability tier allows no background lanes. Set proactivity.model to a model with a larger context window.",
	},
	/** Finished results past the owner's review threshold (`review-gauge.ts`). */
	reviewBacklog: (waiting: number) =>
		`${waiting} finished results are waiting for your review: new work is piling up faster than it is reviewed. Consider tightening the checks or pausing new fan-out until you catch up; nothing was held.`,
	/** Routine results held for the owner's next turn by the day's wake bound (`routine-runtime-assembly.ts`). */
	routineResultWakesHeld: (bound: number) =>
		`Routine results started ${bound} parent turns in the last 24 hours, the routines.maxResultWakesPerDay bound; later results wait for the owner's next turn until the day has room. Raising the setting lets more start turns.`,
	/** A worker model's provider login expired and could not be refreshed (`worker-credential-health.ts`). */
	workerLogin: {
		expiredMoved: (name: string, provider: string) =>
			`Your ${name} login has expired, so workers use another subscription model. Run /login ${provider} to sign in again.`,
		expiredUnstarted: (name: string, provider: string) =>
			`Your ${name} login has expired, so a worker on it could not start. Run /login ${provider} to sign in again.`,
	},
	/** A CI fix act-ahead prepared (`act-ahead-controller.ts`); the basis and the patch path come first. */
	actAhead: {
		readyReproduced: (sha: string, where: string, files: number, command: string) =>
			`CI failed on ${sha}, reproduced locally: a fix is ready at ${where}, ${files} file(s); \`${command}\` passes with it. Say "apply it" to apply it.`,
		readyDiagnosed: (sha: string, where: string, files: number, command: string) =>
			`CI failed on ${sha}: a fix diagnosed from the CI log (the failing step is not re-run locally) is ready at ${where}, ${files} file(s); \`${command}\` passes with it. Say "apply it" to apply it.`,
	},
	/** System One is configured but has no engine (`session-edge-intent-controller.ts`); its English cause is the domain's own. */
	systemOneNoEngine: (cause: typeof SYSTEM_ONE_NO_ENGINE_CAUSE) =>
		`${cause}, so tool calls run under the deterministic gates only, without System One's review of their effects.`,
	/** CI results a session never received (`host-event-session-controller.ts`). */
	ciResults: {
		gap: (count: number, reason: HostEventReplayGap["reason"]) =>
			`Up to ${count} CI ${count === 1 ? "result was" : "results were"} never delivered to this session: ${GAP_CAUSES[reason]}. Check CI directly for results from that period.`,
		journalReplaced:
			"CI results this session had not yet received were dropped: the CI event journal was replaced because it was unreadable or another release started a new one. Check CI directly for results from before now.",
	},

	/**
	 * The soul review's notices (`soul-controller.ts`): a held or refused soul.md write or change and how it ended.
	 * `error` and `reason` are System One's words, handed in whole.
	 */
	soul: {
		holdUnreadable:
			"An earlier session left a soul.md review hold that could not be read; soul.md was accepted as it is.",
		holdResumedDeleted:
			"An earlier session ended while a deletion of soul.md was waiting to be undone. It is put back.",
		holdResumedChanged:
			"An earlier session ended before System One reviewed a change to soul.md. The change stays on disk but is not accepted until System One reviews it; it is reverted if the review rejects it.",
		writeUnsupported: (error: string) =>
			`The agent's soul.md writes are refused: ${error}. Configure a System One engine that can run the soul review.`,
		writeHeld: (error: string) =>
			`System One could not review the agent's soul.md write (${error}). It is held, not written: the harness writes it once System One reviews and allows it.`,
		writeReplaced:
			"The held soul.md write was dropped: a newer soul.md write was reviewed, allowed and written. Its text is kept in /soul history.",
		writeDropped:
			"The held soul.md write was dropped for a newer allowed write that did not complete. Its text is kept in /soul history.",
		changeHeld: (error: string, attempts: number) =>
			`soul.md was changed during a tool call while System One could not review it (${error}). The change stays on disk but is not accepted until System One reviews it; it is reverted after ${attempts} failed reviews.`,
		changeReplaced:
			"The soul.md change held for System One review was replaced by a newer change before it was reviewed.",
		changeAccepted: "System One reviewed and allowed the held soul.md change; it is accepted.",
		changeAcceptedUnreviewed:
			"The held soul.md change was accepted without review: System One is no longer configured.",
		changeReverted: (reason: string) => `The held soul.md change was not accepted (${reason}); it was reverted.`,
		changeWithheld: (attempts: number) =>
			`System One could not review the held soul.md change in ${attempts} attempts; it was reverted and its text is kept in /soul history.`,
		writeStale:
			"The held soul.md write was not written: soul.md changed since it was proposed. Its text is kept in /soul history.",
		writeWithheld: (attempts: number) =>
			`System One could not review the held soul.md write in ${attempts} attempts; it was not written and its text is kept in /soul history.`,
		heldUnsupported: (error: string) =>
			`The held soul.md write was not written: ${error}. Its text is kept in /soul history.`,
		writeRejected: (clauses: string) =>
			`System One rejected the held soul.md write (${clauses}); it was not written.`,
		writeApplied: "System One reviewed and allowed the held soul.md write; the harness wrote it.",
		writeAppliedUnreviewed: "The held soul.md write was written without review: System One is no longer configured.",
		writeLocked:
			"The held soul.md write was allowed but not written: soul.md stayed locked by another session. Its text is kept in /soul history.",
	},

	/** Where the words of a run that asked a held action came from (`originLabel` in `agent-session-edge.ts`). */
	heldActionOrigin: (origin: TurnOriginRecord): string => {
		if (origin.k === "peer-agent") return `a peer agent on ${origin.channel ?? "the chat mesh"}`;
		if (origin.k === "host-event") return "an event written by someone else";
		return origin.channel ? `the ${origin.channel} channel` : "a source whose origin could not be read";
	},
	/**
	 * A held action kept as a draft, as the frame around its bounded action (`keepOutwardDraft`): `classes` its edge
	 * classes, `origin` worded by `heldActionOrigin`, `grants` the `/edge allow` commands that let such runs do it, or "".
	 */
	heldDraft: (classes: string, origin: string, grants: string) => ({
		head: "Held, not run: ",
		tail: ` (${classes}), asked by ${origin}. It runs if you ask for it yourself${grants === "" ? "" : `; ${grants} lets such runs do it`}.`,
	}),
	/** No more held actions are recorded: `max` of them already wait for the owner. */
	heldDraftsFull: (origin: string, max: number) =>
		`Held, not run: actions asked by ${origin}; ${max} held actions already wait for you, so no more are recorded. They run if you ask for them yourself.`,

	/**
	 * A channel's notices (`owner-notice-text.ts`, `session-channels.ts`): its state, a held sender, a gap, a reply that
	 * did not happen and what the daemon's host left. `detail` and a draft's `reason` are the transport's or the record's
	 * own words, handed in whole.
	 */
	channels: {
		notConfigured: (name: string) =>
			`Channel ${name} is registered but not started: no channels.${name} policy in the global or directory-profile settings.`,
		invalid: (name: string, detail: string | undefined) =>
			`Channel ${name} is not started: ${detail ?? "its policy cannot be read"}.`,
		servedElsewhere: (name: string) =>
			`Channel ${name} is not started in this session: another open session serves it.`,
		connectionLost: (name: string, detail: string) => `Channel ${name} is not receiving messages: ${detail}.`,
		/** `builtIn`: the transport is a shipped one, which a session start tries again. */
		startFailed: (name: string, detail: string | undefined, builtIn: boolean) =>
			`Channel ${name} did not start (${detail ?? "start failed"}); it is tried again when settings change or ${builtIn ? "a session starts" : "the provider registers again"}.`,
		capped: (name: string, detail: string | undefined) =>
			`Channel ${name} holds new messages: ${detail ?? "its daily bound is reached"}. They wait up to 24 hours.`,
		senderHeld: (name: string, senderId: string) =>
			`Channel ${name} held a message from sender ${senderId}, who is not in channels.${name}.allowedSenders. To let them start turns, add "${senderId}" to that list.`,
		senderHeldUnnamed: (name: string) =>
			`Channel ${name} held a verified sender not in channels.${name}.allowedSenders; the channel_reply list action shows its id.`,
		gap: (name: string, reason: ChannelGapRecord["reason"], count: number): string =>
			reason === "expired"
				? `Channel ${name}: ${count} message(s) waited more than 24 hours and were dropped undelivered.`
				: reason === "unanswered"
					? `Channel ${name}: ${count} delivered conversation(s) got no reply (the turn ended without an answer for them, or the session that served them closed).`
					: `Channel ${name}: its journal could not be read and was replaced; messages and drafts it held are not delivered.`,
		full: (name: string, max: number) =>
			`Channel ${name} refuses new messages: ${max} wait undelivered. The provider is asked to deliver them again later.`,
		unanswered: (name: string, reason: UnansweredReason) =>
			`Channel ${name}: a delivered conversation got no reply (${reason.replaceAll("_", " ")}).`,
		ownerUnanswered: (name: string, reason: UnansweredReason) =>
			`Channel ${name}: an owner message got no reply (${reason.replaceAll("_", " ")}).`,
		draftWaits: (name: string, draftId: string, reason: string) =>
			`Channel ${name}: a reply waits as draft ${draftId} (${reason}). The channel_reply tool sends or dismisses it.`,
		ownerUnverifiable: (name: string) =>
			`Channel ${name}: owner senders listed but the transport cannot verify them; owner authority is off.`,
		ownerUnhostable: (name: string) =>
			`Channel ${name}: owner senders listed but this session cannot host owner turns; owner authority is off.`,
		/** What the daemon's host left: `served` joins the parts, each a count and what it counts. */
		away: {
			served: (name: string, parts: readonly string[]) =>
				`While the daemon served channel ${name}: ${parts.join("; ")}.`,
			/** `listed`: the drafts named by id and reason, with `more` at their end. */
			drafts: (count: number, listed: readonly string[]) =>
				`${count} reply draft(s) wait for channel_reply${listed.length > 0 ? ` (${listed.join(", ")})` : ""}`,
			more: (count: number) => `and ${count} more`,
			expired: (count: number) => `${count} message(s) expired after 24 hours`,
			unanswered: (count: number) => `${count} delivered conversation(s) got no reply`,
			/** `kinds`: the held messages by reason, or undefined when the line has no room for them. */
			held: (count: number, kinds: readonly string[] | undefined) =>
				`${count} message(s) held${kinds ? ` (${kinds.join(", ")})` : ""}`,
			notAllowed: (count: number, name: string) => `${count} not in channels.${name}.allowedSenders`,
			unverified: (count: number) => `${count} unverified`,
			burst: (count: number, name: string) => `${count} over channels.${name}.maxPendingPerConversation`,
		},
	},

	/** An automatic routine intake state the owner can act on (`routine-intake.ts`). */
	routineIntake: {
		noModel: `Automatic routine intake is inactive: no model is available to read the owner's messages. ${INTAKE_UNREAD}`,
		modelUnpriced: `Automatic routine intake is inactive: the session model declares no prices, so intake cannot bound its spending. ${INTAKE_UNREAD}`,
		noEngine: `Automatic routine intake is inactive: no judge that can bound its spending is available. ${INTAKE_UNREAD}`,
		budgetExhausted: (maxUsd: number) =>
			`Automatic routine intake is inactive: its spending allowance for this session (at most $${maxUsd.toFixed(2)}, within the session's cost bound) is spent. ${INTAKE_UNREAD}`,
		sourceSecret:
			"Routine intake did not read an owner message that states timing because it contains text that looks like a secret. Any request for automatic work in it was not scheduled; the owner can restate it without the secret.",
		sourceOversize: (maxChars: number) =>
			`Routine intake did not read an owner message that states timing because it is longer than the ${maxChars.toLocaleString("en-US")} characters intake reads. Any request for automatic work in it was not scheduled; the owner can restate it in a shorter message.`,
		sourcesFailed:
			"Routine intake stopped reading the owner's latest messages after repeated failures. Any request for automatic work in them was not scheduled; the owner can restate it.",
		sourcesSpent:
			"Routine intake's spending allowance for the owner's latest messages ran out before they were read. Any request for automatic work in them was not scheduled; the owner can restate it.",
	},
	/** The always-on service for routines and channels while no session is open (`away-service.ts`). */
	awayService: {
		available:
			'Routines and channels served while no session is open keep running after reboot only if you enable always-on: set `routines.away.autostart` to "on" in your global settings, or run `/bot daemon service install`.',
		/** `why`: the service manager's own words for what is missing. */
		unavailable: (why: string) =>
			`Routines of closed sessions and channels served while no session is open stop at reboot, and always-on cannot be enabled here: ${why}`,
	},
	/**
	 * What the orchestration store keeps when it is full (`retention.ts`): the store-full notice, and in English the
	 * refusal a model reads.
	 */
	objectiveLimit: {
		hold: (hold: RetentionHold): string => HOLD_WORDS[hold],
		keep: (keep: ExternalKeep): string => EXTERNAL_KEEP_WORDS[keep],
		/** `heldParts`: the held objectives counted by hold, each a count and `hold`'s words. */
		summary: (
			counts: {
				readonly kept: number;
				readonly open: number;
				readonly session: number;
				readonly held: number;
				readonly free: number;
			},
			heldParts: readonly string[],
		) =>
			`${counts.kept} objectives are kept in this session's store: ${counts.open} open, ${counts.session} session work (which never closes; its finished tasks are released one by one, or with the closed plan that names them), ${counts.held} closed and held${heldParts.length === 0 ? "" : ` (${heldParts.join(", ")})`}, and ${counts.free} closed with no hold.`,
		release:
			"Closed work with nothing in this store holding it is released at the next idle moment: after orchestration.retention.closedObjectiveDays (default 14 days), or at once while the store is nearly full (0 keeps it for the session's life).",
		/** `parts`: the objectives kept outside the store, each a count and `keep`'s words. */
		keptOutside: (total: number, parts: readonly string[]) =>
			`Of the closed objectives counted above with no hold, ${total} ${total === 1 ? "is" : "are"} kept by delegation state outside the store (${parts.join(", ")}); ${total === 1 ? "it is" : "they are"} not released at idle until that state ends.`,
		oldestClosed: (date: string) => `The oldest closed objective has been closed since ${date}.`,
		heldReleased: "Held work is released when its hold ends; otherwise start a new session.",
	},
	/** Why the CI source cannot follow results now (`ci-host-event-source.ts`); `error` is the failure's own text. */
	ciConnection: {
		commandMissing:
			"CI results are not followed: the gh command is not installed. They start by themselves once gh is installed and signed in.",
		repositoryUnavailable: (error: string) =>
			`CI results are waiting for GitHub: the repository could not be resolved (${error}). They resume by themselves when it answers.`,
		reconcileFailing: (failures: number, error: string) =>
			`CI results are suspended after ${failures} failed checks in a row (${error}). They retry by themselves at least once every 30 minutes.`,
		/** What the away host recorded while the session was closed: `text` is its kept English line, handed in whole. */
		whileClosed: (since: string, text: string) => `Since ${since}, while this session was closed: ${text}`,
	},

	/** What a widget the extension drew too tall to keep becomes at the top of its frame. */
	widgetTruncated: "... (widget truncated)",
	/** The billing notice under a session signed in with a subscription key. */
	anthropicSubscriptionAuth:
		"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.",
	/** A session whose commands run as a worker's closed while some of them still ran: they were ended. */
	sessionProcessesStopped: (count: number, detail: string) =>
		`This session closed with ${count} process(es) its commands started still running; they were stopped (${detail}). Its commands leave nothing running after it closes.`,
	/**
	 * A model ran out of quota or credit: where the work continues, or why it stopped. `failed` is the model's id, `model`
	 * a `provider/model` reference.
	 */
	billingFailover: {
		continuing: (failed: string, model: string) => `${failed} quota reached — continuing on ${model}`,
		halted: (model: string) =>
			`Provider quota/limit reached for ${model}: switch models (/model), wait for the limit window, or re-send to retry`,
		/** The session is pinned to its model, so no other model takes the work. */
		haltedPinned: (model: string) =>
			`Provider quota/limit reached for ${model}: this session stays on its model; wait for the limit window, or re-send to retry`,
	},
	/** A subscription's usage is used up: the work waits for the recorded reset (`at`, an ISO instant) and resumes on its own. */
	usageReset: {
		workerWaits: (laneId: string, at: string) =>
			`Worker ${laneId}: its subscription's usage is used up; it resumes on its own when the usage resets (${at}).`,
		sessionWaits: (at: string) =>
			`The subscription's usage is used up; this session continues on its own when the usage resets (${at}).`,
		sessionResumeFailed: (error: string) => `The session could not continue after the usage reset: ${error}`,
	},
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
