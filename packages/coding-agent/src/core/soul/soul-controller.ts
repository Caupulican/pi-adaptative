import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { AgentToolCall, BeforeToolCallResult } from "../../kernel/index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { checkSoulText, DEFAULT_AGENT_NAME, SOUL_FILE_NAME } from "../agent-identity.ts";
import { configFile, soulLockFile } from "../agent-paths.ts";
import { canonicalPathScopeIdentity, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
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

export interface SoulControllerDeps {
	readonly agentDir: string;
	/** Only the root agent's writes are reviewed; a worker cannot write the agent directory. */
	isRootSession(): boolean;
	/** The session's recorded System One engine (every evaluation lands on the semantic evaluation ledger); absent while System One is unavailable. */
	getEngine(): SemanticDecisionEngine | undefined;
	/** Owner-visible notice. */
	emitWarning(message: string): void;
}

/** Evaluations one identical candidate gets: the first, and one retry after an unsettled answer. */
const UNSETTLED_EVALUATIONS_PER_CANDIDATE = 2;
const MAX_TRACKED_CANDIDATES = 64;
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
 * program, and only while System One is available; an owner write is the owner's authority and skips the judgment.
 */
export class SoulController {
	private readonly deps: SoulControllerDeps;
	private readonly historyStore: SoulHistory;
	private readonly evaluations = new Map<string, number>();
	/** Allowed writes whose tool call has not finished, keyed by the call itself. */
	private readonly pending = new WeakMap<
		AgentToolCall,
		{ reviewedText: string; before: string | undefined; reviewer: SoulReviewer }
	>();

	private readonly watch: SoulWatch;
	/** Calls of the root agent admitted and not yet settled, with when: a change found while any run is theirs. */
	private readonly running = new Map<AgentToolCall, number>();
	/** Settling is one at a time: two calls ending together must not judge the same change twice. */
	private settling: Promise<undefined> = Promise.resolve(undefined);

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
		const engine = this.deps.getEngine();
		if (!engine) return { kind: "unavailable" };
		return {
			kind: "reviewed",
			outcome: await reviewSoulText(engine, { proposedText: current, currentSoul: current }, signal),
		};
	}

	/**
	 * Admission of a root tool call: the file is reconciled with the accounted revision before the call can touch it. A
	 * difference with no other call running happened between calls, so it is the owner's (adopted, not judged). While
	 * another call runs, a difference may be its write and is left to settlement. Entries older than the longest plausible
	 * call are dropped, so a call blocked after admission (it never settles) cannot hold the check off.
	 */
	private admit(call: AgentToolCall): void {
		const now = Date.now();
		for (const [other, admittedAt] of this.running) {
			if (now - admittedAt > MAX_CALL_RUN_MS) this.running.delete(other);
		}
		if (this.running.size === 0 && this.watch.reconcile()) this.adoptOwner();
		this.running.set(call, now);
	}

	/**
	 * The tool gate for the root agent's `write` and `edit` calls on `soul.md`: the deterministic screen on every such
	 * write, then the System One judgment while System One is available. Outcomes: all good allows; an adverse answer
	 * blocks with its codes; an unsettled answer blocks with "simplify the text" and the same text gets one retry; an
	 * evaluation that fails or times out while System One is available allows and says so.
	 */
	async checkWrite(
		call: AgentToolCall,
		args: unknown,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<BeforeToolCallResult | undefined> {
		if (!this.deps.isRootSession()) return undefined;
		this.admit(call);
		const toolName = call.name;
		if (toolName !== "write" && toolName !== "edit") return undefined;
		if (typeof args !== "object" || args === null) return undefined;
		const input = args as Record<string, unknown>;
		if (typeof input.path !== "string" || !this.isSoulFile(input.path, cwd)) return undefined;

		const current = this.read();
		const candidate = resultingDocument(toolName, input, current, input.path);
		if ("inapplicable" in candidate) return undefined;
		if ("refusal" in candidate) return block(candidate.refusal);
		const screened = checkSoulText(candidate.text);
		if (!screened.ok) {
			this.record(candidate.text, "block");
			return block(`soul.md write refused: ${screened.reason}.`);
		}

		const engine = this.deps.getEngine();
		if (!engine || screened.soul === undefined) return this.hold(call, candidate.text, current, "unreviewed");

		const identity = soulSha256(candidate.text);
		if ((this.evaluations.get(identity) ?? 0) >= UNSETTLED_EVALUATIONS_PER_CANDIDATE) {
			this.record(candidate.text, "block");
			return block(
				"System One could not settle this soul.md text twice. Rewrite it materially, as a plain self-description.",
			);
		}
		const outcome = await reviewSoulText(
			engine,
			{ proposedText: candidate.text, currentSoul: current ?? "" },
			signal,
		);
		switch (outcome.kind) {
			case "allow":
				this.evaluations.delete(identity);
				return this.hold(call, candidate.text, current, "allow");
			case "adverse": {
				this.record(candidate.text, "block");
				const adverse = outcome.findings.filter((finding) => finding.answer === "adverse");
				return block(
					`System One blocked the soul.md write: ${adverse.map((finding) => `${finding.id} (${finding.adverse})`).join("; ")}. Rewrite it as a plain description of who you are and how you work.`,
				);
			}
			case "unsettled":
				if (this.evaluations.size >= MAX_TRACKED_CANDIDATES) this.evaluations.clear();
				this.evaluations.set(identity, (this.evaluations.get(identity) ?? 0) + 1);
				this.record(candidate.text, "block");
				return block("System One could not settle this soul.md text. Simplify the text and write it again.");
			case "failed":
				this.deps.emitWarning(`soul written without Jev review: ${outcome.error}`);
				return this.hold(call, candidate.text, current, "unreviewed");
		}
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
	): undefined {
		this.pending.set(call, { reviewedText, before, reviewer });
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
	 * - any other change goes through the deterministic screen and, while System One is available, the soul review; if it
	 *   fails either, the accounted-for text (for a gated write whose text another writer replaced: the reviewed text)
	 *   is written back, a typed `reverted` entry is recorded, the owner is told and the model gets a notice;
	 * - a deletion is put back the same way, as a `removed` entry.
	 * A verdict holds for one revision only. It is committed under the soul lock after the file is read again; if the
	 * file moved during the review the verdict is discarded and the new revision is reconciled the same way (a bounded
	 * number of times, then adopted with a warning). Returns the notice for the tool result when something was reverted.
	 * The offending text is on disk from its write until it is reverted.
	 */
	settleWrite(call: AgentToolCall, succeeded: boolean): Promise<string | undefined> {
		const run = this.settling.then(() => this.settle(call, succeeded));
		this.settling = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async settle(call: AgentToolCall, succeeded: boolean): Promise<string | undefined> {
		if (!this.deps.isRootSession()) return undefined;
		const pending = this.pending.get(call);
		this.pending.delete(call);
		this.running.delete(call);
		const observed = this.watch.reconcile();
		if (!observed) return undefined;
		return this.judge(observed, pending && succeeded ? pending : undefined, 0);
	}

	private async judge(
		observed: SoulRevision,
		gated: { reviewedText: string; before: string | undefined; reviewer: SoulReviewer } | undefined,
		round: number,
	): Promise<string | undefined> {
		const known = this.watch.known;
		const restoreTo = gated?.reviewedText ?? known;
		let action: () => string | undefined;
		if (observed.text === undefined) {
			action =
				restoreTo === undefined
					? () => undefined
					: () => this.revert(restoreTo, "removed", "soul.md was deleted outside the soul gate and was put back");
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
			action = verdict.accept
				? () => {
						if (verdict.warning) this.deps.emitWarning(verdict.warning);
						this.historyStore.record({
							text,
							keepText: true,
							standing: known,
							author: "agent",
							reviewer: verdict.reviewer,
						});
						return undefined;
					}
				: () =>
						this.revert(
							restoreTo,
							"reverted",
							`soul.md was changed outside the soul gate (${verdict.reason}) and was reverted`,
						);
		}
		const outcome = this.commit(observed, action);
		if (outcome !== STALE) return outcome;
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

	/**
	 * Runs `action` under the soul lock, only if the file still is the revision the verdict was made on, and accounts for
	 * the file as `action` left it: the text, digest and stamp advance together, after the history entry. Returns the
	 * action's notice, or {@link STALE} when the file is not the observed revision (nothing was written or advanced).
	 */
	private commit(observed: SoulRevision, action: () => string | undefined): string | undefined | typeof STALE {
		return this.locked(() => {
			if (this.watch.current().digest !== observed.digest) return STALE;
			const notice = action();
			this.watch.adopt(this.watch.current());
			return notice;
		});
	}

	/** Holds the cross-process soul lock; when it stays held elsewhere the change is left for the next reconcile. */
	private locked<T>(operation: () => T): T | undefined {
		try {
			return withFileLockSync(soulLockFile(this.deps.agentDir), operation, { retries: LOCK_RETRIES });
		} catch (error) {
			if (!isLockContention(error)) throw error;
			this.deps.emitWarning(`soul.md is locked by another session; its accounting waits for the next tool call.`);
			return undefined;
		}
	}

	/** A change no running call can have made (found at admission, or after a verdict went stale): the owner's. */
	private adoptOwner(): void {
		this.locked(() => {
			const now = this.watch.current();
			if (now.digest === undefined) {
				this.watch.adopt(now);
				return;
			}
			this.historyStore.record({
				text: now.text ?? "",
				keepText: checkSoulText(now.text ?? "").ok,
				standing: this.watch.known,
				author: "owner",
				reviewer: "unreviewed",
			});
			this.watch.adopt(now);
		});
	}

	/** The deterministic screen, then the soul review while System One is available, on a document already on disk. */
	private async verdict(
		text: string,
		current: string | undefined,
	): Promise<{ accept: true; reviewer: SoulReviewer; warning?: string } | { accept: false; reason: string }> {
		const screened = checkSoulText(text);
		if (!screened.ok) return { accept: false, reason: screened.reason };
		const engine = this.deps.getEngine();
		if (!engine || screened.soul === undefined) return { accept: true, reviewer: "unreviewed" };
		const outcome = await reviewSoulText(engine, { proposedText: text, currentSoul: current ?? "" });
		switch (outcome.kind) {
			case "allow":
				return { accept: true, reviewer: "allow" };
			case "adverse":
				return {
					accept: false,
					reason: `System One: ${outcome.findings
						.filter((finding) => finding.answer === "adverse")
						.map((finding) => finding.id)
						.join(", ")}`,
				};
			case "unsettled":
				return { accept: false, reason: "System One could not settle the text" };
			case "failed":
				return {
					accept: true,
					reviewer: "unreviewed",
					warning: `soul written without Jev review: ${outcome.error}`,
				};
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
		this.historyStore.record({
			text,
			keepText: reviewer !== "block",
			standing: this.read(),
			author: "agent",
			reviewer,
		});
	}

	/**
	 * An owner write. `basedOn` is the revision the owner started from (the text the panel was opened on): the write is
	 * refused when the file is no longer that text, so a competing change is never replaced unseen. The check and the
	 * replace happen under the soul lock; the text is stored, then the file replaced, then the entry appended, and the
	 * accounting advances to the bytes actually written.
	 */
	private write(
		text: string,
		author: SoulAuthor,
		reviewer: SoulReviewer,
		basedOn?: { readonly text: string | undefined },
	): SoulSaveResult {
		const screened = checkSoulText(text);
		if (!screened.ok) return { ok: false, reason: screened.reason };
		if (screened.soul === undefined)
			return { ok: false, reason: "an empty soul is not saved; delete the file to remove it" };
		const content = `${screened.soul}\n`;
		const result = this.locked((): SoulSaveResult => {
			const now = this.watch.current();
			if (basedOn && now.text !== basedOn.text) {
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
			return { ok: true, bytes: Buffer.byteLength(written.text ?? content, "utf8") };
		});
		return result ?? { ok: false, reason: "soul.md is locked by another session; try again" };
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
