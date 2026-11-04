import { existsSync, readFileSync } from "node:fs";
import type { AgentToolCall, BeforeToolCallResult } from "../../kernel/index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { checkSoulText, DEFAULT_AGENT_NAME, SOUL_FILE_NAME } from "../agent-identity.ts";
import { configFile } from "../agent-paths.ts";
import { canonicalPathScopeIdentity, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import {
	applyEditMatchPlanToSource,
	type Edit,
	normalizeToLF,
	planEditsToNormalizedContent,
} from "../tools/edit-diff.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { type SoulAuthor, SoulHistory, type SoulHistoryEntry, type SoulReviewer, soulSha256 } from "./soul-history.ts";
import { reviewSoulText, type SoulReviewOutcome } from "./soul-review.ts";

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

	constructor(deps: SoulControllerDeps) {
		this.deps = deps;
		this.historyStore = new SoulHistory(deps.agentDir);
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
	saveFromOwner(text: string): SoulSaveResult {
		return this.write(text, "owner", "unreviewed");
	}

	/** Writes an earlier version back through the same screen; `n` is the number `/soul history` shows. */
	restore(n: number): SoulSaveResult {
		const entry = this.history()[n - 1];
		if (!entry) return { ok: false, reason: `no history entry ${n}` };
		if (entry.reviewer === "block") {
			return {
				ok: false,
				reason: `entry ${n} records a blocked write; its text was not kept`,
			};
		}
		const text = this.historyStore.readVersion(entry.sha256);
		if (text === undefined) return { ok: false, reason: `the text of entry ${n} was not kept` };
		if (text === this.read()) return { ok: false, reason: `entry ${n} is the current text` };
		return this.write(text, "owner", "unreviewed");
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
		const toolName = call.name;
		if ((toolName !== "write" && toolName !== "edit") || !this.deps.isRootSession()) return undefined;
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
	 * The history boundary of an allowed write: called once its tool call has finished. A failed call recorded nothing
	 * restorable; a successful one is recorded from the text actually on disk. When that differs from the reviewed
	 * text (another writer got in between the review and the write; this is detected after the fact, not prevented),
	 * the write is recorded `unreviewed`, the on-disk text goes through the deterministic screen, and the owner is told.
	 */
	settleWrite(call: AgentToolCall, succeeded: boolean): void {
		const pending = this.pending.get(call);
		if (!pending) return;
		this.pending.delete(call);
		const onDisk = this.read();
		if (!succeeded || onDisk === undefined) return;
		const reviewed = onDisk === pending.reviewedText || normalizeToLF(onDisk) === normalizeToLF(pending.reviewedText);
		if (reviewed) {
			this.historyStore.record({
				text: onDisk,
				keepText: true,
				standing: pending.before,
				author: "agent",
				reviewer: pending.reviewer,
			});
			return;
		}
		const screened = checkSoulText(onDisk);
		this.deps.emitWarning(
			screened.ok
				? "soul.md on disk differs from the text that was reviewed (another writer changed it); recorded as unreviewed."
				: `soul.md on disk differs from the text that was reviewed and ${screened.reason}; it is not loaded. Review ${this.path}.`,
		);
		this.historyStore.record({
			text: onDisk,
			keepText: screened.ok,
			standing: pending.before,
			author: "agent",
			reviewer: "unreviewed",
		});
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

	private write(text: string, author: SoulAuthor, reviewer: SoulReviewer): SoulSaveResult {
		const screened = checkSoulText(text);
		if (!screened.ok) return { ok: false, reason: screened.reason };
		if (screened.soul === undefined)
			return { ok: false, reason: "an empty soul is not saved; delete the file to remove it" };
		const content = `${screened.soul}\n`;
		const standing = this.read();
		writeFileAtomicSync(this.path, content);
		// Recorded after the write succeeded, from what the file now holds.
		const written = this.read() ?? content;
		this.historyStore.record({ text: written, keepText: true, standing, author, reviewer });
		return { ok: true, bytes: Buffer.byteLength(written, "utf8") };
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
