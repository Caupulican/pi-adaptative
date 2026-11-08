import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { AgentToolCall, BeforeToolCallResult } from "../../kernel/index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { checkSoulText, DEFAULT_AGENT_NAME, SOUL_FILE_NAME } from "../agent-identity.ts";
import { configFile, soulLockFile } from "../agent-paths.ts";
import { canonicalPathScopeIdentity, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import type { SemanticEvaluationRecord } from "../system-one/semantic-evaluation-ledger.ts";
import { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../system-one/semantic-plane-health.ts";
import {
	applyEditMatchPlanToSource,
	type Edit,
	normalizeToLF,
	planEditsToNormalizedContent,
} from "../tools/edit-diff.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	entryKeepsText,
	type SoulAuthor,
	SoulHistory,
	type SoulHistoryEntry,
	type SoulReviewer,
	soulSha256,
} from "./soul-history.ts";
import { reviewSoulText, type SoulReviewOutcome } from "./soul-review.ts";
import { type SoulRevision, SoulWatch } from "./soul-watch.ts";

/**
 * The controller is wired as the tool gate of root sessions only: a worker cannot write the agent directory, so only the
 * root agent's writes are reviewed.
 */
export interface SoulControllerDeps {
	readonly agentDir: string;
	/** The session's semantic plane. */
	readonly systemOne: {
		/** The recorded System One engine (every evaluation lands on the semantic evaluation ledger); absent while System One is off or no engine is bound. */
		recordingSemanticEngine(): SemanticDecisionEngine | undefined;
		/** System One is on and was given a controller or a steering plane; true with no engine bound is a configuration fault. */
		readonly configured: boolean;
		/** Every settled System One evaluation of the session; returns the unsubscribe. */
		onSemanticEvaluation(listener: (record: SemanticEvaluationRecord) => void): () => void;
	};
	/** Owner-visible warning. */
	emitWarning(message: string): void;
	/** The session's once-per-episode owner notices; false when no notice can be kept (no transcript). */
	observeHarnessNotice(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): boolean;
}

/** Evaluations one identical candidate gets: the first, and one retry after an unsettled answer. */
const UNSETTLED_EVALUATIONS_PER_CANDIDATE = 2;
const MAX_TRACKED_CANDIDATES = 64;
/** `replacesHeld`: allowing this write dropped the held write (its text already kept as `withheld`). */
type GatedWrite = { reviewedText: string; before: string | undefined; reviewer: SoulReviewer; replacesHeld: boolean };

type HistoryRecord = Parameters<SoulHistory["record"]>[0];
type DeferredAudit = HistoryRecord;

/**
 * A verdict whose commit the soul lock refused. It keeps the exact revision it was made on, the accounting baseline
 * that gave it authority to restore, and the commit itself; it is resolved before anything else is accounted for, so
 * the revision it rejected is never adopted as the owner's in the meantime.
 */
interface DeferredSettlement {
	readonly observed: SoulRevision;
	/** The owner-change count when the verdict was made: an owner change since takes its authority away. */
	readonly ownerMark: number;
	readonly action: () => string | undefined;
	/** The verdict reverts the file (rather than accepting it). */
	readonly rejects: boolean;
	readonly since: number;
	attempts: number;
}

/** A deferred verdict is retried at each admission and settlement, then given up on. */
const MAX_DEFERRED_ATTEMPTS = 5;
const DEFERRED_TTL_MS = 10 * 60 * 1000;
const MAX_DEFERRED_AUDIT = 32;

/**
 * An agent write the gate could not have reviewed because System One failed or timed out: not written, kept for the
 * harness to review and write itself. `bytes` is exactly what the write path stores; `basedOn` is the file it started from.
 */
interface HeldWrite {
	readonly bytes: string;
	readonly basedOn: string | undefined;
	/** The owner-change count when it was held: an owner save, restore or adopted change since supersedes it. */
	readonly ownerMark: number;
	failures: number;
	/**
	 * The review allowed it (or System One is no longer configured) and only the write is left: the soul lock refused it. Kept so
	 * a later attempt pays for no second review; bounded like a deferred verdict.
	 */
	allowed?: { readonly reviewer: SoulReviewer; readonly at: number; lockRefusals: number };
}

/**
 * A change found on disk at settlement whose review failed or timed out: not adopted and not recorded as accepted until
 * a review settles. It owns the exact revision and the accounting it was found against, like a deferred verdict.
 */
interface AwaitingReview {
	readonly observed: SoulRevision;
	readonly text: string;
	/** The owner-change count when the change was found: an owner change since supersedes it. */
	readonly ownerMark: number;
	/** The accounted text when the change was found: what the review compares against. */
	readonly standing: string | undefined;
	/** What a revert writes back. */
	readonly restoreTo: string | undefined;
	failures: number;
}

/** Failed reviews a held write or a held change gets; then the write is dropped and the change reverted, text kept. */
const MAX_HELD_REVIEW_FAILURES = 5;
/** A held review is retried at an admitted tool call at most this often; a settled System One answer retries it at once. */
const HELD_RETRY_SPACING_MS = 2 * 60 * 1000;
/**
 * After a failed retry no trigger starts the next one sooner: System One may answer other questions while only the soul
 * review keeps failing (its 20 s budget at high consequence), and those answers must not spend the failures in seconds.
 */
const HELD_RETRY_MIN_SPACING_MS = 30 * 1000;
const CLOSE_LOCK_WARNING =
	"The soul.md change no review settled could not be reverted at close because the soul lock is held elsewhere; it stays on disk unreviewed.";

type SoulNoticeScope = "write" | "change";

/** The deterministic screen and the soul review of a document already on disk. */
type SoulVerdict =
	| { readonly kind: "accept"; readonly reviewer: SoulReviewer }
	| { readonly kind: "reject"; readonly reason: string }
	/** System One is bound but its review failed or timed out. */
	| { readonly kind: "unavailable"; readonly error: string };

/** An owner-path write: refused, or held off by the soul lock (`locked`, worth trying again). */
type SoulWriteResult = SoulSaveResult | { readonly ok: false; readonly reason: string; readonly locked: true };

/** The owner's words for why a review rejected the text: the clause of each adverse decision, joined. */
function adverseReasons(outcome: SoulReviewOutcome): string {
	if (outcome.kind !== "adverse") return "the review could not settle the text";
	return outcome.findings
		.filter((finding) => finding.answer === "adverse")
		.map((finding) => finding.adverse)
		.join("; ");
}

/** A verdict that went stale because the file moved is made again at most this many times, then the file is adopted. */
const MAX_REJUDGE_ROUNDS = 3;
/** A call admitted this long ago and never settled was blocked after admission. */
const MAX_CALL_RUN_MS = 60 * 60 * 1000;
const LOCK_RETRIES = 6;
/** A verdict made on a revision the file no longer has. */
const STALE: unique symbol = Symbol("stale soul revision");

function isLockContention(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ELOCKED";
}

/** The harness cuts a block reason longer than this when it folds the block into a failure record. */
const MAX_BLOCK_REASON_CHARS = 239;

/** What `/soul review` reports. */
export type SoulReviewReport =
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "unavailable" }
	| { readonly kind: "reviewed"; readonly outcome: SoulReviewOutcome };

export type SoulSaveResult =
	| { readonly ok: true; readonly bytes: number }
	| { readonly ok: false; readonly reason: string };

function joinNotices(first: string | undefined, second: string | undefined): string | undefined {
	return first && second ? `${first} ${second}`.slice(0, MAX_BLOCK_REASON_CHARS) : (first ?? second);
}

/** The same text, allowing for the line endings the tool preserved. */
function sameText(left: string, right: string): boolean {
	return left === right || normalizeToLF(left) === normalizeToLF(right);
}

function block(reason: string): BeforeToolCallResult {
	return { block: true, reason: reason.slice(0, MAX_BLOCK_REASON_CHARS) };
}

/**
 * The whole document a `write` or `edit` call would leave in the file, or why it cannot be judged. A `write` carries it
 * inline. An `edit` is applied to the current text by the edit tool's own planner (`planEditsToNormalizedContent`,
 * `applyEditMatchPlanToSource`), so the screen and the review judge exactly what the file will hold, name and body
 * together. An edit that does not apply is left to the edit tool, which fails it with its own message.
 */
function resultingDocument(
	toolName: string,
	args: Record<string, unknown>,
	current: string | undefined,
	path: string,
): { text: string } | { refusal: string } | { inapplicable: true } {
	if (toolName === "write") {
		return typeof args.content === "string"
			? { text: args.content }
			: { refusal: "soul.md content must be inline (no contentRef or payloadRef)." };
	}
	if (!Array.isArray(args.edits)) return { refusal: "soul.md edits must be inline (no payloadRef)." };
	if (current === undefined) return { inapplicable: true };
	try {
		const plan = planEditsToNormalizedContent(normalizeToLF(current), args.edits as Edit[], path);
		return { text: applyEditMatchPlanToSource(current, plan, path).sourceContent };
	} catch {
		return { inapplicable: true };
	}
}

/**
 * Everything the harness does with `<agentDir>/soul.md` after the prompt is built: the gate that screens and has System
 * One review the root agent's writes, the owner's edit, review and restore, and the history both write into.
 *
 * Every write passes the deterministic screen (`checkSoulText`). Only an agent write is also judged by the soul-review
 * program, and only while System One is configured; an owner write is the owner's authority and skips the judgment.
 * While System One is configured, an agent write or change is never taken in unreviewed: when its review fails or times
 * out it is held (a write is not written, a change on disk is not accepted) and reviewed again when System One answers.
 */
export class SoulController {
	private readonly deps: SoulControllerDeps;
	private readonly historyStore: SoulHistory;
	private readonly evaluations = new Map<string, number>();
	/** Allowed writes whose tool call has not finished, keyed by the call itself. */
	private readonly pending = new WeakMap<AgentToolCall, GatedWrite>();

	private readonly watch: SoulWatch;
	/** Calls of the root agent admitted and not yet settled, with when: a change found while any run is theirs. */
	private readonly running = new Map<AgentToolCall, number>();
	/** Settling is one at a time: two calls ending together must not judge the same change twice. */
	private settling: Promise<undefined> = Promise.resolve(undefined);
	/** True while this process holds the soul lock: history operations inside it must not acquire it again. */
	private holding = false;
	/** A verdict on an exact revision that could not be committed because the soul lock stayed held elsewhere. */
	private deferred: DeferredSettlement | undefined;
	/** History entries that could not be written for the same reason; flushed under the lock at the next chance. */
	private readonly deferredAudit: DeferredAudit[] = [];
	/** A notice produced while no call was settling (a deferred revert completing at admission), told at the next settle. */
	private carriedNotice: string | undefined;
	/** The agent write held while System One could not review it; one at a time, the newest replaces it. */
	private heldWrite: HeldWrite | undefined;
	/** The change on disk whose review failed; while it exists the revision is never adopted and no judgment starts. */
	private awaitingReview: AwaitingReview | undefined;
	/** The held review in flight; one at a time. */
	private retrying: Promise<void> | undefined;
	private lastRetryAt = 0;
	/** When the last held retry failed (a review or a locked write): every trigger waits {@link HELD_RETRY_MIN_SPACING_MS}. */
	private lastFailedRetryAt = 0;
	/**
	 * Owner changes of the accounting: owner saves and restores, changes adopted as the owner's. A content digest cannot
	 * tell an owner's round trip back to the same text from no change at all; this count can. A revert does not count:
	 * it restores what the owner had.
	 */
	private ownerChanges = 0;
	/** Aborted at close: no review in flight runs on after the session ends. */
	private readonly closing = new AbortController();
	/**
	 * Settlements in flight. A call leaves {@link running} when its settlement starts, so while one judges, the change it
	 * judges is not between calls: close leaves it to that settlement, which reverts it once its review is aborted.
	 */
	private settlingCalls = 0;
	/** Gate reviews in flight: a System One answer they receive retries the held review only once the gate has used it. */
	private gateReviews = 0;
	/** Subscribed to System One's settled evaluations only while something is held. */
	private offEvaluations: (() => void) | undefined;
	/** The last notice reason told per scope: one notice per episode, whichever channel carries it. */
	private readonly told = new Map<SoulNoticeScope, string>();
	private closed = false;

	constructor(deps: SoulControllerDeps) {
		this.deps = deps;
		this.historyStore = new SoulHistory(deps.agentDir);
		this.watch = new SoulWatch(this.path);
	}

	get path(): string {
		return configFile(this.deps.agentDir, SOUL_FILE_NAME);
	}

	/** The file's text, or undefined when it does not exist. */
	read(): string | undefined {
		return existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined;
	}

	/** What the owner edits when no file exists yet. */
	template(): string {
		return `---\nname: ${DEFAULT_AGENT_NAME}\n---\nYou are ... Describe who you are and how you work, in the second person. No tasks, no secrets.\n`;
	}

	/** Entries newest first: the order `/soul history` numbers them and `/soul restore <n>` counts. */
	history(): readonly SoulHistoryEntry[] {
		return [...this.historyStore.list()].reverse();
	}

	/** An owner write: the deterministic screen, then the file, then the history. The owner's edit skips the judgment. */
	saveFromOwner(text: string, basedOn: { readonly text: string | undefined }): SoulSaveResult {
		return this.write(text, "owner", "unreviewed", basedOn);
	}

	/** Writes an earlier version back through the same screen; `n` is the number `/soul history` shows. */
	restore(n: number): SoulSaveResult {
		const entry = this.history()[n - 1];
		if (!entry) return { ok: false, reason: `no history entry ${n}` };
		if (!entryKeepsText(entry)) {
			return { ok: false, reason: `entry ${n} records a blocked write; its text was not kept` };
		}
		const text = this.historyStore.readVersion(entry.sha256);
		if (text === undefined) return { ok: false, reason: `the text of entry ${n} was not kept` };
		const current = this.read();
		if (text === current) return { ok: false, reason: `entry ${n} is the current text` };
		return this.write(text, "owner", "unreviewed", { text: current });
	}

	/** Runs the soul-review program on the current file. */
	async review(signal?: AbortSignal): Promise<SoulReviewReport> {
		const current = this.read();
		if (current === undefined) return { kind: "missing", path: this.path };
		const engine = this.deps.systemOne.recordingSemanticEngine();
		if (!engine && this.deps.systemOne.configured)
			return { kind: "reviewed", outcome: { kind: "unsupported", error: SYSTEM_ONE_NO_ENGINE_CAUSE } };
		if (!engine) return { kind: "unavailable" };
		return {
			kind: "reviewed",
			outcome: await reviewSoulText(engine, { proposedText: current, currentSoul: current }, signal),
		};
	}

	/**
	 * Admission of a root tool call: the file is reconciled with the accounted revision before the call can touch it. A
	 * difference with no other call running happened between calls, so it is the owner's (adopted, not judged). While
	 * another call runs, a difference may be its write and is left to settlement. A call refused after admission leaves at
	 * its invocation cleanup; entries older than the longest plausible call are dropped as well, for a caller that passes
	 * no cleanup, so a call that never settles cannot hold the check off. A held change the
	 * owner's accounting moved past, or one the file moved off between calls, is dropped first (owner priority); a held
	 * review is retried here at most every {@link HELD_RETRY_SPACING_MS}, never awaited.
	 */
	private admit(call: AgentToolCall): void {
		const now = Date.now();
		for (const [other, admittedAt] of this.running) {
			if (now - admittedAt > MAX_CALL_RUN_MS) this.running.delete(other);
		}
		this.carriedNotice = joinNotices(this.carriedNotice, this.resolveDeferred());
		const awaiting = this.awaitingReview;
		if (
			awaiting &&
			(this.ownerChanges !== awaiting.ownerMark ||
				(this.running.size === 0 && this.watch.current().digest !== awaiting.observed.digest))
		) {
			this.dropAwaiting();
		}
		if (this.deferredAudit.length > 0) this.withLock(() => undefined);
		// A revision a deferred verdict or a held review still owns is not between-call change: it is never adopted as the owner's.
		if (!this.deferred && !this.awaitingReview && this.running.size === 0 && this.watch.reconcile())
			this.adoptOwner();
		this.running.set(call, now);
		if (now - this.lastRetryAt >= HELD_RETRY_SPACING_MS) this.retryHeld();
	}

	/**
	 * The tool gate for the root agent's `write` and `edit` calls on `soul.md`: the deterministic screen on every such
	 * write, then the System One judgment while System One is configured. Outcomes: all good allows (and replaces a held
	 * write, whose text is kept as `withheld`; the owner is told at settlement whether the newer write landed); an adverse
	 * answer blocks with its codes; an unsettled answer blocks with "simplify the text" and the same text gets one retry;
	 * an evaluation that fails or times out blocks the call, holds the text (replacing an older held one) and tells the
	 * owner once per episode: the harness reviews it again when System One answers and writes it itself if the review
	 * allows it. A review the call's own abort cancelled blocks and holds nothing. An engine that can never run the review,
	 * or System One configured with no engine bound, refuses the write and tells the owner it is a configuration fault.
	 * Only while System One is not configured (turned off, or never set up) is a non-empty write taken unreviewed. After close no
	 * soul.md write is taken.
	 *
	 * `registerCleanup` is the invocation's end: it runs when the call is refused (by this gate or a later one), abandoned
	 * or finalized. A call that never reaches settlement leaves {@link running} there, so it cannot hold changes off as
	 * its own after it ended.
	 */
	async checkWrite(
		call: AgentToolCall,
		args: unknown,
		cwd: string,
		signal: AbortSignal | undefined,
		registerCleanup?: (cleanup: () => void) => void,
	): Promise<BeforeToolCallResult | undefined> {
		this.admit(call);
		registerCleanup?.(() => {
			// A settled call left already; this one never ran, so an allowed write it carried did not land.
			if (!this.running.delete(call)) return;
			const gated = this.pending.get(call);
			this.pending.delete(call);
			if (gated?.replacesHeld) this.tellReplaced(false);
		});
		const toolName = call.name;
		if (toolName !== "write" && toolName !== "edit") return undefined;
		if (typeof args !== "object" || args === null) return undefined;
		const input = args as Record<string, unknown>;
		if (typeof input.path !== "string" || !this.isSoulFile(input.path, cwd)) return undefined;
		// After close nothing is reviewed or held: the call is refused.
		if (this.closed) return block("The session is closing: soul.md is not written now.");

		const current = this.read();
		const candidate = resultingDocument(toolName, input, current, input.path);
		if ("inapplicable" in candidate) return undefined;
		if ("refusal" in candidate) return block(candidate.refusal);
		const screened = checkSoulText(candidate.text);
		if (!screened.ok) {
			this.record(candidate.text, "block");
			return block(`soul.md write refused: ${screened.reason}.`);
		}

		const engine = this.deps.systemOne.recordingSemanticEngine();
		if (screened.soul === undefined || (!engine && !this.deps.systemOne.configured))
			return this.hold(call, candidate.text, current, "unreviewed", false);
		if (!engine) return this.refuseUnsupported(candidate.text, SYSTEM_ONE_NO_ENGINE_CAUSE);

		const identity = soulSha256(candidate.text);
		if ((this.evaluations.get(identity) ?? 0) >= UNSETTLED_EVALUATIONS_PER_CANDIDATE) {
			this.record(candidate.text, "block");
			return block(
				"System One could not settle this soul.md text twice. Rewrite it materially, as a plain self-description.",
			);
		}
		this.gateReviews += 1;
		let outcome: SoulReviewOutcome;
		try {
			outcome = await reviewSoulText(
				engine,
				{ proposedText: candidate.text, currentSoul: current ?? "" },
				signal ? AbortSignal.any([signal, this.closing.signal]) : this.closing.signal,
			);
		} finally {
			this.gateReviews -= 1;
		}
		if (outcome.kind === "failed") {
			if (signal?.aborted) return block("The soul.md review was cancelled with the call; nothing was written.");
			return this.holdWrite(`${screened.soul}\n`, current, outcome.error);
		}
		if (outcome.kind === "unsupported") return this.refuseUnsupported(candidate.text, outcome.error);
		if (outcome.kind === "allow") {
			this.evaluations.delete(identity);
			const held = this.heldWrite;
			// The held text is kept at once: whether the newer write lands is known only when its call settles.
			if (held) this.dropHeld(held);
			return this.hold(call, candidate.text, current, "allow", held !== undefined);
		}
		// System One answered: a held review can be tried now.
		this.retryHeld();
		this.record(candidate.text, "block");
		if (outcome.kind === "unsettled") {
			if (this.evaluations.size >= MAX_TRACKED_CANDIDATES) this.evaluations.clear();
			this.evaluations.set(identity, (this.evaluations.get(identity) ?? 0) + 1);
			return block("System One could not settle this soul.md text. Simplify the text and write it again.");
		}
		return block(
			`System One blocked the soul.md write: ${adverseReasons(outcome)}. Rewrite it as a plain description of who you are and how you work.`,
		);
	}

	/**
	 * No review can ever run on the agent's write (the engine cannot run the program, or System One is configured with no
	 * engine bound): a configuration fault, not an outage. The write is refused and recorded `block`; nothing is held.
	 */
	private refuseUnsupported(text: string, error: string): BeforeToolCallResult {
		this.record(text, "block");
		this.tell(
			"write",
			"write-unsupported",
			`The agent's soul.md writes are refused: ${error}. Configure a System One engine that can run the soul review.`,
		);
		return block(`soul.md write refused: ${error}.`);
	}

	/**
	 * The gate's review failed or timed out: the call is blocked and the text kept, as the exact bytes the write path
	 * stores, for the harness to review again and write itself. A newer held text replaces an older one in the same episode.
	 */
	private holdWrite(bytes: string, basedOn: string | undefined, error: string): BeforeToolCallResult {
		// The session closed during the review: nothing is reviewed after close, so the text is kept, not held.
		if (this.closed) {
			this.recordWithheld(bytes);
			return block(
				"soul.md write not written: the session closed before System One reviewed it. Its text is kept in /soul history.",
			);
		}
		this.heldWrite = { bytes, basedOn, ownerMark: this.ownerChanges, failures: 0 };
		this.lastRetryAt = Date.now();
		this.syncSubscription();
		this.tell(
			"write",
			"write-held",
			`System One could not review the agent's soul.md write (${error}). It is held, not written: the harness writes it once System One reviews and allows it.`,
		);
		return {
			block: true,
			reason: `soul.md write held: System One could not review it (${error})`.slice(0, MAX_BLOCK_REASON_CHARS),
			correction:
				"Do not write soul.md again: the harness keeps this text, has System One review it when it is available again, and writes it if the review allows it.",
		};
	}

	/**
	 * The gate lets the call through. Nothing is recorded yet: the tool re-reads the file and may fail or find other
	 * text, so the version is recorded by `settleWrite`, from what is on disk once the call has run.
	 */
	private hold(
		call: AgentToolCall,
		reviewedText: string,
		before: string | undefined,
		reviewer: SoulReviewer,
		replacesHeld: boolean,
	): undefined {
		this.pending.set(call, { reviewedText, before, reviewer, replacesHeld });
		return undefined;
	}

	/**
	 * The check after every tool call of the root agent, which makes the gate complete: whatever wrote `soul.md`, the
	 * file is reconciled with the last revision the harness accounted for (one `stat`; the text is read and hashed only
	 * when the stamp moved). Every call reconciles at admission, so a difference found there happened between calls and
	 * is adopted as the owner's (no judgment, no revert). A difference found here, relative to that baseline, happened
	 * while calls were running and is attributed to them: to this call, or to a parallel sibling whose change is seen
	 * first (whichever settles first reports it). It is judged like a gated write, on the revision observed:
	 * - an allowed gated write is recorded from the text on disk once its call succeeded;
	 * - any other change goes through the deterministic screen and, while System One is configured, the soul review; if
	 *   it fails either, the accounted-for text (for a gated write whose text another writer replaced: the reviewed text)
	 *   is written back, a typed `reverted` entry is recorded, the owner is told and the model gets a notice; a review
	 *   that fails or times out holds the change (`AwaitingReview`): it stays on disk, is neither adopted nor recorded,
	 *   and is reviewed again when System One answers; after close no review starts (one in flight is aborted) and the
	 *   change is reverted instead, its text kept as `withheld`, since nothing would review it later;
	 * - a deletion is put back the same way, as a `removed` entry.
	 * A verdict holds for one revision only. It is committed under the soul lock after the file is read again; if the
	 * file moved during the review the verdict is discarded and the new revision is reconciled the same way (a bounded
	 * number of times, then adopted with a warning). Returns the notice for the tool result when something was reverted.
	 * The offending text is on disk from its write until it is reverted.
	 */
	settleWrite(call: AgentToolCall, succeeded: boolean): Promise<string | undefined> {
		return this.serialized(() => this.settle(call, succeeded));
	}

	/** Settlements and held-review commits run one at a time, in order. */
	private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
		const run = this.settling.then(operation);
		this.settling = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async settle(call: AgentToolCall, succeeded: boolean): Promise<string | undefined> {
		const pending = this.pending.get(call);
		this.pending.delete(call);
		this.running.delete(call);
		this.settlingCalls += 1;
		let notice: string | undefined;
		try {
			notice = await this.settleChange(pending && succeeded ? pending : undefined);
		} finally {
			this.settlingCalls -= 1;
		}
		if (pending?.replacesHeld) {
			const known = this.watch.known;
			this.tellReplaced(succeeded && known !== undefined && sameText(known, pending.reviewedText));
		}
		return notice;
	}

	/** The notice for a held write a newer allowed write replaced, told once that write's fate is known. */
	private tellReplaced(landed: boolean): void {
		this.tell(
			"write",
			landed ? "write-replaced" : "write-dropped",
			landed
				? "The held soul.md write was dropped: a newer soul.md write was reviewed, allowed and written. Its text is kept in /soul history."
				: "The held soul.md write was dropped for a newer allowed write that did not complete. Its text is kept in /soul history.",
		);
	}

	private async settleChange(pending: GatedWrite | undefined): Promise<string | undefined> {
		const carried = joinNotices(this.carriedNotice, this.resolveDeferred());
		this.carriedNotice = undefined;
		if (this.deferred) return carried;
		const awaiting = this.awaitingReview;
		if (awaiting) {
			// A newer revision supersedes the held change; it is judged below like any change found while calls ran.
			if (this.awaitingStands(awaiting)) return carried;
			this.dropAwaiting();
		}
		const observed = this.watch.reconcile();
		if (!observed) return carried;
		return joinNotices(carried, await this.judge(observed, pending, 0));
	}

	private async judge(
		observed: SoulRevision,
		gated: GatedWrite | undefined,
		round: number,
	): Promise<string | undefined> {
		const known = this.watch.known;
		const restoreTo = gated?.reviewedText ?? known;
		let action: () => string | undefined;
		let rejects = false;
		if (observed.text === undefined) {
			rejects = restoreTo !== undefined;
			action = this.deletionAction(restoreTo);
		} else if (gated && sameText(observed.text, gated.reviewedText)) {
			const text = observed.text;
			action = () => {
				this.historyStore.record({
					text,
					keepText: true,
					standing: gated.before,
					author: "agent",
					reviewer: gated.reviewer,
				});
				return undefined;
			};
		} else {
			const text = observed.text;
			const verdict = await this.verdict(text, known);
			// Held for a later review only while the session lives; after close (or a review close cut short) nothing would
			// review it, so it is reverted with its text kept.
			if (verdict.kind === "unavailable" && !this.closed) {
				return this.awaitReview(observed, text, known, restoreTo, verdict.error);
			}
			rejects = verdict.kind !== "accept";
			action =
				verdict.kind === "unavailable"
					? () => this.withhold(text, restoreTo)
					: this.verdictAction(text, known, restoreTo, verdict);
		}
		const outcome = this.commit(observed, action);
		if (outcome.kind === "done") return outcome.notice;
		if (outcome.kind === "deferred") {
			this.deferCommit(observed, this.ownerChanges, action, rejects);
			return undefined;
		}
		// The file moved while this verdict was being made: it says nothing about the new revision.
		const next = this.watch.reconcile();
		if (!next) return undefined;
		if (this.running.size > 0 && round + 1 < MAX_REJUDGE_ROUNDS) return this.judge(next, undefined, round + 1);
		if (this.running.size > 0) {
			this.deps.emitWarning(`soul.md kept changing during review; the current text was adopted. ${this.path}`);
		}
		this.adoptOwner();
		return undefined;
	}

	/** A settled verdict's commit: record an accepted change, or write the restore target back. */
	private verdictAction(
		text: string,
		standing: string | undefined,
		restoreTo: string | undefined,
		verdict: Exclude<SoulVerdict, { kind: "unavailable" }>,
	): () => string | undefined {
		if (verdict.kind === "reject") {
			return () =>
				this.revert(
					restoreTo,
					"reverted",
					`soul.md was changed outside the soul gate (${verdict.reason}) and was reverted`,
				);
		}
		return () => {
			this.historyStore.record({ text, keepText: true, standing, author: "agent", reviewer: verdict.reviewer });
			return undefined;
		};
	}

	/** A deleted `soul.md` is put back (nothing to do when there was none). */
	private deletionAction(restoreTo: string | undefined): () => string | undefined {
		return restoreTo === undefined
			? () => undefined
			: () => this.revert(restoreTo, "removed", "soul.md was deleted outside the soul gate and was put back");
	}

	/** The lock refused a verdict's commit: kept as a {@link DeferredSettlement}, retried at the next tool call. */
	private deferCommit(
		observed: SoulRevision,
		ownerMark: number,
		action: () => string | undefined,
		rejects: boolean,
	): void {
		this.deferred = { observed, ownerMark, action, rejects, since: Date.now(), attempts: 0 };
		this.deps.emitWarning(
			this.closed && rejects
				? `${CLOSE_LOCK_WARNING} ${this.path}`
				: "soul.md is locked by another session; the verdict on its change is kept and retried at the next tool call, and the change is not adopted meanwhile.",
		);
	}

	/**
	 * The review of a change on disk failed or timed out: the change is held. It stays on disk, is not adopted or
	 * recorded, and blocks other judgments until a review settles it, a newer revision or an owner save supersedes it,
	 * or {@link MAX_HELD_REVIEW_FAILURES} reviews fail (then it is reverted, its text kept as a `withheld` entry).
	 */
	private awaitReview(
		observed: SoulRevision,
		text: string,
		standing: string | undefined,
		restoreTo: string | undefined,
		error: string,
	): string {
		this.awaitingReview = {
			observed,
			text,
			ownerMark: this.ownerChanges,
			standing,
			restoreTo,
			failures: 0,
		};
		this.lastRetryAt = Date.now();
		this.syncSubscription();
		this.tell(
			"change",
			"change-held",
			`soul.md was changed during a tool call while System One could not review it (${error}). The change stays on disk but is not accepted until System One reviews it; it is reverted after ${MAX_HELD_REVIEW_FAILURES} failed reviews.`,
		);
		return "soul.md changed while System One could not review it: the change is held for review and is reverted if the review rejects it.";
	}

	private awaitingStands(awaiting: AwaitingReview): boolean {
		return this.ownerChanges === awaiting.ownerMark && this.watch.current().digest === awaiting.observed.digest;
	}

	/** A newer revision or an owner save superseded the held change before a review settled it. */
	private dropAwaiting(): void {
		this.awaitingReview = undefined;
		this.syncSubscription();
		this.tell(
			"change",
			"change-replaced",
			"The soul.md change held for System One review was replaced by a newer change before it was reviewed.",
		);
	}

	/**
	 * Reviews what is held, at most one pass at a time and never on a caller's stack: the held change first, then the
	 * held write (not while a verdict or a change still owns the file). The reviews run outside the settlement order, so
	 * no tool result waits for them; whether the held write still applies, and every commit, are decided inside it. After
	 * a failed retry no trigger starts another within {@link HELD_RETRY_MIN_SPACING_MS}.
	 */
	private retryHeld(): void {
		if (this.closed || this.retrying || (!this.heldWrite && !this.awaitingReview)) return;
		if (Date.now() - this.lastFailedRetryAt < HELD_RETRY_MIN_SPACING_MS) return;
		this.lastRetryAt = Date.now();
		this.retrying = this.reviewHeld()
			.catch((error: unknown) => {
				this.deps.emitWarning(
					`The held soul.md review could not finish: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				this.retrying = undefined;
				this.syncSubscription();
			});
	}

	private async reviewHeld(): Promise<void> {
		const awaiting = this.awaitingReview;
		if (awaiting) {
			const verdict = await this.verdict(awaiting.text, awaiting.standing);
			await this.serialized(() => this.finishAwaiting(awaiting, verdict));
		}
		const held = this.heldWrite;
		if (!held) return;
		// An allowed write the lock refused is only written again: no second review is paid for.
		if (held.allowed) {
			await this.serialized(() => this.applyHeld(held));
			return;
		}
		// No review is paid for a write that no longer applies, and that is decided in the settlement order.
		if ((await this.serialized(() => this.heldStanding(held))) !== "ready") return;
		const engine = this.deps.systemOne.recordingSemanticEngine();
		const outcome = engine
			? await reviewSoulText(
					engine,
					{ proposedText: held.bytes, currentSoul: held.basedOn ?? "" },
					this.closing.signal,
				)
			: this.deps.systemOne.configured
				? ({ kind: "unsupported", error: SYSTEM_ONE_NO_ENGINE_CAUSE } as const)
				: "unbound";
		await this.serialized(() => this.finishHeld(held, outcome));
	}

	/**
	 * Whether the held write still applies, decided from the accounting and never from a raw read: a change on disk that a
	 * running call has not settled yet (a sibling's shell write the call's settlement may still revert) is waited out. A
	 * change no call can have made is the owner's and is adopted first, as at admission. The write is stale once an owner
	 * change happened since it was held (a save or restore back to the same text included) or the accounted text is no
	 * longer what it was based on (an accepted agent change); then it ends with its text kept.
	 */
	private heldStanding(held: HeldWrite): "ready" | "wait" | "done" {
		if (this.heldWrite !== held || this.closed) return "done";
		if (this.deferred || this.awaitingReview) return "wait";
		if (this.watch.reconcile()) {
			if (this.running.size > 0) return "wait";
			this.adoptOwner();
		}
		if (this.ownerChanges !== held.ownerMark || this.watch.known !== held.basedOn) {
			this.endHeld(
				held,
				"write-stale",
				"The held soul.md write was not written: soul.md changed since it was proposed. Its text is kept in /soul history.",
				true,
			);
			return "done";
		}
		return "ready";
	}

	private finishAwaiting(awaiting: AwaitingReview, verdict: SoulVerdict): void {
		if (this.awaitingReview !== awaiting || this.closed) return;
		if (verdict.kind === "unavailable") {
			awaiting.failures += 1;
			this.lastFailedRetryAt = Date.now();
			if (awaiting.failures < MAX_HELD_REVIEW_FAILURES) return;
		}
		if (!this.awaitingStands(awaiting)) {
			this.dropAwaiting();
			return;
		}
		const action =
			verdict.kind === "unavailable"
				? () => this.withhold(awaiting.text, awaiting.restoreTo)
				: this.verdictAction(awaiting.text, awaiting.standing, awaiting.restoreTo, verdict);
		// The held change keeps owning the revision until its commit returns: a commit that throws (the revert could not
		// be written) leaves it held, so the next admission cannot adopt the unreviewed change as the owner's.
		const outcome = this.commit(awaiting.observed, action);
		if (outcome.kind === "stale") {
			this.dropAwaiting();
			return;
		}
		this.awaitingReview = undefined;
		this.syncSubscription();
		if (outcome.kind === "deferred") {
			this.deferCommit(awaiting.observed, awaiting.ownerMark, action, verdict.kind !== "accept");
			return;
		}
		this.carriedNotice = joinNotices(this.carriedNotice, outcome.notice);
		if (verdict.kind === "accept") {
			this.tell(
				"change",
				"change-accepted",
				verdict.reviewer === "allow"
					? "System One reviewed and allowed the held soul.md change; it is accepted."
					: "The held soul.md change was accepted without review: System One is no longer configured.",
			);
		} else if (verdict.kind === "reject") {
			this.tell(
				"change",
				"change-reverted",
				`The held soul.md change was not accepted (${verdict.reason}); it was reverted.`,
			);
		} else {
			this.tell(
				"change",
				"change-withheld",
				`System One could not review the held soul.md change in ${MAX_HELD_REVIEW_FAILURES} attempts; it was reverted and its text is kept in /soul history.`,
			);
		}
	}

	/**
	 * Reverts a change no review settled, keeping its text first as a `withheld` entry the owner can restore. Runs inside
	 * the soul lock.
	 */
	private withhold(text: string, restoreTo: string | undefined): string {
		this.recordWithheld(text);
		return this.revert(
			restoreTo,
			"reverted",
			"soul.md was changed while System One could not review it and was reverted; its text is kept in /soul history",
		);
	}

	/** A text no review let in, kept as a `withheld` history entry (`agent`/`unreviewed`) the owner can restore. */
	private recordWithheld(text: string): void {
		this.recordAudit({
			text,
			keepText: true,
			standing: undefined,
			author: "agent",
			reviewer: "unreviewed",
			withheld: true,
			now: new Date(),
		});
	}

	private finishHeld(held: HeldWrite, outcome: SoulReviewOutcome | "unbound"): void {
		if (this.heldWrite !== held || this.closed) return;
		if (outcome === "unbound" || outcome.kind === "allow") {
			held.allowed = { reviewer: outcome === "unbound" ? "unreviewed" : "allow", at: Date.now(), lockRefusals: 0 };
			this.applyHeld(held);
			return;
		}
		if (outcome.kind === "failed") {
			held.failures += 1;
			this.lastFailedRetryAt = Date.now();
			if (held.failures >= MAX_HELD_REVIEW_FAILURES) {
				this.endHeld(
					held,
					"write-withheld",
					`System One could not review the held soul.md write in ${MAX_HELD_REVIEW_FAILURES} attempts; it was not written and its text is kept in /soul history.`,
					true,
				);
			}
			return;
		}
		if (outcome.kind === "unsupported") {
			this.endHeld(
				held,
				"write-unsupported",
				`The held soul.md write was not written: ${outcome.error}. Its text is kept in /soul history.`,
				true,
			);
			return;
		}
		this.record(held.bytes, "block");
		this.endHeld(
			held,
			"write-rejected",
			`System One rejected the held soul.md write (${adverseReasons(outcome)}); it was not written.`,
			false,
		);
	}

	/**
	 * Writes an allowed held write through the write path, which checks the same standing again under the soul lock. A
	 * write the lock refuses keeps its allowance and is tried again at the next retry, spaced like a failed review, until
	 * {@link MAX_DEFERRED_ATTEMPTS} refusals or {@link DEFERRED_TTL_MS}; then it ends with its text kept.
	 */
	private applyHeld(held: HeldWrite): void {
		const allowed = held.allowed;
		if (!allowed || this.heldStanding(held) !== "ready") return;
		const saved = this.write(held.bytes, "agent", allowed.reviewer, { text: held.basedOn, accountedOnly: true });
		if (saved.ok) {
			this.endHeld(
				held,
				"write-applied",
				allowed.reviewer === "allow"
					? "System One reviewed and allowed the held soul.md write; the harness wrote it."
					: "The held soul.md write was written without review: System One is no longer configured.",
				false,
			);
			return;
		}
		// Refused without the lock: the file moved after the standing check; the next retry decides on it.
		if (!("locked" in saved)) return;
		allowed.lockRefusals += 1;
		this.lastFailedRetryAt = Date.now();
		if (allowed.lockRefusals >= MAX_DEFERRED_ATTEMPTS || Date.now() - allowed.at > DEFERRED_TTL_MS) {
			this.endHeld(
				held,
				"write-locked",
				"The held soul.md write was allowed but not written: soul.md stayed locked by another session. Its text is kept in /soul history.",
				true,
			);
		}
	}

	/** A newer allowed write took the held write's place: its text is kept now, the notice waits for the newer write. */
	private dropHeld(held: HeldWrite): void {
		this.heldWrite = undefined;
		this.recordWithheld(held.bytes);
		this.syncSubscription();
	}

	/** The held write is done with; a text no review settled is kept as a `withheld` entry the owner can restore. */
	private endHeld(held: HeldWrite, reason: string, text: string, keepText: boolean): void {
		this.heldWrite = undefined;
		if (keepText) this.recordWithheld(held.bytes);
		this.syncSubscription();
		this.tell("write", reason, text);
	}

	/** Listens for System One's settled answers only while something is held; a settled answer retries the held review. */
	private syncSubscription(): void {
		const waiting = !this.closed && (this.heldWrite !== undefined || this.awaitingReview !== undefined);
		if (waiting && !this.offEvaluations) {
			this.offEvaluations = this.deps.systemOne.onSemanticEvaluation((record) => {
				// The gate's own review is used by the gate first; it retries once it has its outcome.
				if (record.outcome === "ok" && this.gateReviews === 0) queueMicrotask(() => this.retryHeld());
			});
		} else if (!waiting && this.offEvaluations) {
			this.offEvaluations();
			this.offEvaluations = undefined;
		}
	}

	/** One owner notice per episode and scope; a session that keeps no notices gets the line as a warning. */
	private tell(scope: SoulNoticeScope, reason: string, text: string): void {
		if (this.told.get(scope) === reason) return;
		this.told.set(scope, reason);
		if (!this.deps.observeHarnessNotice("soul-review", () => ({ scope, state: { reason, text } }))) {
			this.deps.emitWarning(text);
		}
	}

	/**
	 * The session ends: nothing is reviewed after it (reviews in flight are aborted, later settlements start none), and,
	 * while System One is configured, no unreviewed agent text stays on disk. A held write is kept as a `withheld` history
	 * entry. A change on disk no review settled (the held change, or a newer revision while calls still run) is reverted
	 * to the accounted text with its text kept as `withheld`; a running call's allowed write landing is left to its
	 * settlement, and a change no call can have made is the owner's. When the soul lock is held elsewhere the change
	 * stays on disk with a warning. Nothing held is applied by a later session.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closing.abort();
		this.syncSubscription();
		const held = this.heldWrite;
		this.heldWrite = undefined;
		if (held) {
			this.recordWithheld(held.bytes);
			this.deps.emitWarning(
				"The held soul.md write was not written before the session closed; its text is kept in /soul history.",
			);
		}
		const awaiting = this.awaitingReview;
		this.awaitingReview = undefined;
		this.resolveDeferred();
		if (this.deferred) {
			if (this.deferred.rejects) this.deps.emitWarning(`${CLOSE_LOCK_WARNING} ${this.path}`);
			return;
		}
		// A settlement judging a change finishes it: its review is aborted above and its verdict reverts the change.
		if (this.settlingCalls > 0) return;
		const ownsAwaiting = awaiting !== undefined && this.ownerChanges === awaiting.ownerMark;
		for (let round = 0; round < MAX_REJUDGE_ROUNDS; round++) {
			const observed = this.watch.reconcile();
			if (!observed) return;
			// As at admission: with no call running, only the held change's own revision is not the owner's.
			if (this.running.size === 0 && !(ownsAwaiting && observed.digest === awaiting.observed.digest)) {
				this.adoptOwner();
				return;
			}
			for (const call of this.running.keys()) {
				const gated = this.pending.get(call);
				if (gated && observed.text !== undefined && sameText(observed.text, gated.reviewedText)) return;
			}
			const restoreTo = ownsAwaiting ? awaiting.restoreTo : this.watch.known;
			const outcome = this.commit(observed, this.closingAction(observed.text, restoreTo));
			if (outcome.kind === "deferred") this.deps.emitWarning(`${CLOSE_LOCK_WARNING} ${this.path}`);
			if (outcome.kind !== "stale") return;
		}
	}

	/** The verdict at close, where no review runs: the screen, then withheld while System One is configured (bound or not). */
	private closingAction(text: string | undefined, restoreTo: string | undefined): () => string | undefined {
		if (text === undefined) return this.deletionAction(restoreTo);
		const screened = checkSoulText(text);
		const standing = this.watch.known;
		if (!screened.ok) {
			return this.verdictAction(text, standing, restoreTo, { kind: "reject", reason: screened.reason });
		}
		if (this.deps.systemOne.configured && screened.soul !== undefined) {
			return () => this.withhold(text, restoreTo);
		}
		return this.verdictAction(text, standing, restoreTo, { kind: "accept", reviewer: "unreviewed" });
	}

	/**
	 * Runs `action` under the soul lock, only if the file still is the revision the verdict was made on, and accounts for
	 * the file as `action` left it: the text, digest and stamp advance together, after the history entry. `stale`: the
	 * file is not the observed revision (nothing was written or advanced). `deferred`: the lock stayed held elsewhere
	 * (nothing was written or advanced either; the caller owns the obligation).
	 */
	private commit(
		observed: SoulRevision,
		action: () => string | undefined,
	): { kind: "done"; notice: string | undefined } | { kind: "stale" } | { kind: "deferred" } {
		const result = this.withLock(() => {
			if (this.watch.current().digest !== observed.digest) return STALE;
			const notice = action();
			this.watch.adopt(this.watch.current());
			return notice;
		});
		if (!result.held) return { kind: "deferred" };
		return result.value === STALE ? { kind: "stale" } : { kind: "done", notice: result.value };
	}

	/**
	 * Holds the cross-process soul lock for `operation`; pending history entries are written first, inside it. Nested use
	 * runs directly. `held: false` means the lock stayed held elsewhere and nothing ran.
	 */
	private withLock<T>(operation: () => T): { held: true; value: T } | { held: false } {
		if (this.holding) return { held: true, value: operation() };
		try {
			return withFileLockSync(
				soulLockFile(this.deps.agentDir),
				() => {
					this.holding = true;
					try {
						while (this.deferredAudit.length > 0) {
							this.historyStore.record(this.deferredAudit[0]!);
							this.deferredAudit.shift();
						}
						return { held: true as const, value: operation() };
					} finally {
						this.holding = false;
					}
				},
				{ retries: LOCK_RETRIES },
			);
		} catch (error) {
			if (!isLockContention(error)) throw error;
			return { held: false };
		}
	}

	/**
	 * Finishes a verdict the lock refused, before anything else is accounted for. Its authority is the exact revision it
	 * was made on and the accounting baseline it was made against: if the file is a newer revision, or an owner save
	 * advanced the accounting, it is dropped (owner priority). Otherwise the commit is tried again; after
	 * {@link MAX_DEFERRED_ATTEMPTS} tries or {@link DEFERRED_TTL_MS} the revision is adopted with a warning and a typed
	 * `unresolved` entry, so no obligation outlives its bound. Returns the notice of a revert that completed.
	 */
	private resolveDeferred(): string | undefined {
		const deferred = this.deferred;
		if (!deferred) return undefined;
		if (this.ownerChanges !== deferred.ownerMark || this.watch.current().digest !== deferred.observed.digest) {
			this.deferred = undefined;
			return undefined;
		}
		const outcome = this.commit(deferred.observed, deferred.action);
		if (outcome.kind === "done") {
			this.deferred = undefined;
			return outcome.notice;
		}
		if (outcome.kind === "stale") {
			this.deferred = undefined;
			return undefined;
		}
		deferred.attempts += 1;
		if (deferred.attempts >= MAX_DEFERRED_ATTEMPTS || Date.now() - deferred.since > DEFERRED_TTL_MS) {
			this.deferred = undefined;
			this.watch.adopt(this.watch.current());
			this.ownerChanges += 1;
			this.recordAudit({
				text: deferred.observed.text ?? "",
				keepText: false,
				standing: undefined,
				author: "agent",
				reviewer: deferred.rejects ? "block" : "unreviewed",
				event: "unresolved",
				now: new Date(),
			});
			this.deps.emitWarning(
				`soul.md could not be settled because the soul lock stayed held elsewhere; the current text was adopted without its verdict. ${this.path}`,
			);
		}
		return undefined;
	}

	/**
	 * A change no running call can have made (found at admission, or after a verdict went stale): the owner's. The
	 * accounting advances at once; the history entry takes the lock or waits for it.
	 */
	private adoptOwner(): void {
		const now = this.watch.current();
		const standing = this.watch.known;
		this.watch.adopt(now);
		this.ownerChanges += 1;
		if (now.digest === undefined) return;
		this.recordAudit({
			text: now.text ?? "",
			keepText: checkSoulText(now.text ?? "").ok,
			standing,
			author: "owner",
			reviewer: "unreviewed",
			now: new Date(),
		});
	}

	/**
	 * The deterministic screen, then the soul review while System One is configured, on a document already on disk. After
	 * close no review starts, and one in flight is aborted: either is `unavailable`. Configured with no engine bound, no
	 * review can run: rejected (reverted), like an engine that cannot run the program.
	 */
	private async verdict(text: string, current: string | undefined): Promise<SoulVerdict> {
		const screened = checkSoulText(text);
		if (!screened.ok) return { kind: "reject", reason: screened.reason };
		const engine = this.deps.systemOne.recordingSemanticEngine();
		if (screened.soul === undefined || (!engine && !this.deps.systemOne.configured))
			return { kind: "accept", reviewer: "unreviewed" };
		if (this.closed) return { kind: "unavailable", error: "the session closed" };
		if (!engine) return { kind: "reject", reason: SYSTEM_ONE_NO_ENGINE_CAUSE };
		const outcome = await reviewSoulText(
			engine,
			{ proposedText: text, currentSoul: current ?? "" },
			this.closing.signal,
		);
		switch (outcome.kind) {
			case "unsupported":
				return { kind: "reject", reason: outcome.error };
			case "allow":
				return { kind: "accept", reviewer: "allow" };
			case "adverse":
				return { kind: "reject", reason: `System One: ${adverseReasons(outcome)}` };
			case "unsettled":
				return { kind: "reject", reason: "System One could not settle the text" };
			case "failed":
				return { kind: "unavailable", error: outcome.error };
		}
	}

	/**
	 * Puts the accounted-for text back (or removes a file that did not exist), records it as `event`, and tells the owner.
	 * Ordered so a crash leaves a usable state: the text to restore is stored as a version first, then the file is
	 * replaced atomically, then the history entry is appended. A crash after the replace leaves the right file and no
	 * entry for it (the next write records it as a baseline); a crash before it leaves the offending file, which the
	 * next load screens and the next session treats as the starting state.
	 */
	private revert(restoreTo: string | undefined, event: "reverted" | "removed", message: string): string {
		if (restoreTo !== undefined) this.historyStore.keep(restoreTo);
		if (restoreTo === undefined) {
			if (existsSync(this.path)) unlinkSync(this.path);
		} else {
			writeFileAtomicSync(this.path, restoreTo);
		}
		this.historyStore.record({
			text: restoreTo ?? "",
			keepText: restoreTo !== undefined,
			standing: undefined,
			author: "agent",
			reviewer: "block",
			event,
		});
		this.deps.emitWarning(`${message}. ${this.path}`);
		return `${message}. Change soul.md with the edit tool instead.`.slice(0, MAX_BLOCK_REASON_CHARS);
	}

	/** An agent write of `text`: kept whole unless the gate blocked it. */
	private record(text: string, reviewer: SoulReviewer): void {
		this.recordAudit({
			text,
			keepText: reviewer !== "block",
			standing: this.read(),
			author: "agent",
			reviewer,
			now: new Date(),
		});
	}

	/**
	 * Every history read-modify-write goes through the soul lock, because the history file is rewritten whole and its
	 * versions pruned: an unlocked writer could drop a concurrent entry and delete its version. Inside a locked
	 * operation it runs directly; outside, it takes the lock, and when the lock stays held elsewhere the entry is kept
	 * (bounded) and written by the next locked operation instead of being lost.
	 */
	private recordAudit(input: HistoryRecord): void {
		if (this.withLock(() => this.historyStore.record(input)).held) return;
		this.deferredAudit.push(input);
		if (this.deferredAudit.length > MAX_DEFERRED_AUDIT) this.deferredAudit.shift();
		this.deps.emitWarning("soul.md history is locked by another session; the entry is written at the next chance.");
	}

	/**
	 * An owner write, or the harness writing a reviewed held agent write. `basedOn` is the revision the writer started
	 * from (the text the panel was opened on, the file a held write was proposed on): the write is refused when the file
	 * is no longer that text, so a competing change is never replaced unseen. `accountedOnly` (a held write) also refuses
	 * a file that is not the accounted revision, so a change no settlement judged yet is never replaced either. The check
	 * and the replace happen under the soul lock; the text is stored, then the file replaced, then the entry appended, and
	 * the accounting advances to the bytes actually written. An owner write counts as an owner change.
	 */
	private write(
		text: string,
		author: SoulAuthor,
		reviewer: SoulReviewer,
		basedOn?: { readonly text: string | undefined; readonly accountedOnly?: boolean },
	): SoulWriteResult {
		const screened = checkSoulText(text);
		if (!screened.ok) return { ok: false, reason: screened.reason };
		if (screened.soul === undefined)
			return { ok: false, reason: "an empty soul is not saved; delete the file to remove it" };
		const content = `${screened.soul}\n`;
		const result = this.withLock((): SoulSaveResult => {
			const now = this.watch.current();
			if (
				basedOn &&
				(now.text !== basedOn.text || (basedOn.accountedOnly === true && now.digest !== this.watch.accountedDigest))
			) {
				return { ok: false, reason: "soul.md changed while you were editing it; reopen /soul to see the new text" };
			}
			this.historyStore.keep(content);
			writeFileAtomicSync(this.path, content);
			const written = this.watch.current();
			this.historyStore.record({
				text: written.text ?? content,
				keepText: true,
				standing: now.text,
				author,
				reviewer,
			});
			this.watch.adopt(written);
			if (author === "owner") this.ownerChanges += 1;
			return { ok: true, bytes: Buffer.byteLength(written.text ?? content, "utf8") };
		});
		return result.held
			? result.value
			: { ok: false, reason: "soul.md is locked by another session; try again", locked: true };
	}

	/**
	 * Whether a tool path is `soul.md`. A path that does not exist yet (the first write creates the file) resolves through
	 * its real existing parent plus the file name (`safeRealpathSync`), so the creating write is gated like any other.
	 * Windows paths compare case-insensitively, and so does macOS, whose default file system ignores case.
	 */
	private isSoulFile(path: string, cwd: string): boolean {
		const identity = (value: string): string => {
			const canonical = canonicalPathScopeIdentity(safeRealpathSync(value));
			return process.platform === "darwin" ? canonical.toLowerCase() : canonical;
		};
		try {
			return identity(resolvePath(path, cwd)) === identity(this.path);
		} catch {
			return false;
		}
	}
}
