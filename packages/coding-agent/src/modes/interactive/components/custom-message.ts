import type { TextContent } from "@caupulican/pi-ai";
import {
	Box,
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
} from "@caupulican/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import {
	type BackgroundActivitySummaryContract,
	type BackgroundActivitySummaryItem,
	createBackgroundActivitySummaryContract,
	isBackgroundActivitySummaryContract,
} from "../../../core/foreground-terminal-handoff-controller.ts";
import { harnessNoticeHeadline } from "../../../core/harness-notice.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { isPlainRecord } from "../../../core/util/value-guards.ts";
import type { CustomMessage } from "../../../kernel/index.ts";
import { isModelFacingText, plainLabel } from "../../../presentation/plain-text.ts";
import { getMarkdownTheme, theme } from "../../../presentation/theme-model.ts";
import { renderTitleBadge } from "../../../presentation/tool-title.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private revision = 0;
	/** True only while the content is a component an extension's renderer returned, whose revision we cannot trust. */
	private usesExtensionRenderer = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 0,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	/**
	 * Folded child revision for extension-rendered content, whose own text can change without this
	 * container seeing an invalidate; undefined there, so no cached row is reused for it.
	 */
	get renderRevision(): number | undefined {
		if (!this.usesExtensionRenderer || !this.customComponent) return this.revision;
		const child = this.customComponent as Component & { renderRevision?: number };
		// A plain `Container` reports its own counter, which is 0 until it changes: its extension child's
		// rows could still be rewritten without us seeing it, so it is never cacheable here.
		if (child instanceof Container) {
			const prototype = Object.getPrototypeOf(child);
			if (prototype === Container.prototype || !Object.hasOwn(prototype, "renderRevision")) return undefined;
		}
		const childRevision = child.renderRevision;
		if (childRevision !== undefined) return (this.revision * 31 + childRevision) | 0;
		// An extension component without a revision of its own is a black box: never cache its rows.
		return undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.revision++;
		this.usesExtensionRenderer = false;
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		const teamView = readTeamMessageView(this.message);
		if (teamView) {
			this.customComponent = new TeamMessageComponent(teamView, this.markdownTheme);
			this.addChild(this.customComponent);
			return;
		}

		const backgroundSummary = formatBackgroundActivitySummary(this.message);
		if (backgroundSummary) {
			this.customComponent = new BackgroundActivitySummaryComponent(backgroundSummary);
			this.addChild(this.customComponent);
			return;
		}

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.usesExtensionRenderer = true;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		this.box.addChild(new Text(renderTitleBadge(theme, { label: plainLabel(this.message.customType) }), 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content. A harness notice shows its headline; its model text (any fenced evidence) stays in the transcript.
		let text: string;
		const headline = harnessNoticeHeadline(this.message);
		if (headline !== undefined) {
			text = headline;
		} else if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(
				isModelFacingText(text) ? interfaceText().conversation.modelFacingDetails : text,
				0,
				0,
				this.markdownTheme,
				{
					color: (text: string) => theme.fg("customMessageText", text),
				},
			),
		);
	}
}

interface TeamMessageView {
	readonly from: { readonly kind: "operator" | "brain" | "bot"; readonly agentId?: string };
	readonly to: readonly string[];
	readonly text: string;
	readonly timestamp?: number;
}

/** A group chat entry, read from the fields the transcript wrote (never from its text). */
function readTeamMessageView(message: CustomMessage<unknown>): TeamMessageView | undefined {
	if (message.customType !== "team-message" || !isPlainRecord(message.details)) return undefined;
	const { from, to } = message.details;
	if (!isPlainRecord(from) || (from.kind !== "operator" && from.kind !== "brain" && from.kind !== "bot"))
		return undefined;
	return {
		from: { kind: from.kind, ...(typeof from.agentId === "string" ? { agentId: from.agentId } : {}) },
		to: Array.isArray(to) ? to.filter((id): id is string => typeof id === "string") : [],
		text: typeof message.content === "string" ? message.content : "",
		...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
	};
}

/** Longest bot entry the group view shows whole; a longer one (a transport error, a pasted log) is cut with its size. Your own words are never cut. */
const MAX_TEAM_MESSAGE_CHARS = 700;

// Five distinct hues in every built-in theme (matrix: green, cyan, amber, peach, sky); success and accent share a green there.
const TEAM_SPEAKER_TONES = ["accent", "mdLink", "warning", "syntaxNumber", "syntaxType"] as const;

/** A bot's steady colour in a group chat, the same in its messages and in the live line of what it is doing. */
export function teamSpeakerTone(name: string): (typeof TEAM_SPEAKER_TONES)[number] {
	return TEAM_SPEAKER_TONES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TEAM_SPEAKER_TONES.length]!;
}

/** One speaker of a group chat: a name in its own steady color, who it spoke to, the time, then the words. */
class TeamMessageComponent extends Container {
	constructor(view: TeamMessageView, markdownTheme: MarkdownTheme) {
		super();
		const words = interfaceText().conversation;
		const who =
			view.from.kind === "operator"
				? words.you
				: view.from.kind === "brain"
					? words.brain
					: (view.from.agentId ?? "bot");
		const tone = view.from.kind === "operator" ? "text" : view.from.kind === "brain" ? "muted" : teamSpeakerTone(who);
		const recipients =
			view.to.length > 0
				? view.to.map((id) => `@${id}`).join(", ")
				: view.from.kind === "operator"
					? words.everyone
					: "";
		const time = view.timestamp
			? new Date(view.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: "";
		const header =
			`${theme.fg(tone, "●")} ${theme.bold(theme.fg(tone, who))}` +
			(recipients ? theme.fg("dim", ` → ${recipients}`) : "") +
			(time ? theme.fg("dim", `  ${time}`) : "");
		this.addChild(new Text(header, 1, 0));
		const text =
			view.from.kind !== "operator" && view.text.length > MAX_TEAM_MESSAGE_CHARS
				? `${view.text.slice(0, MAX_TEAM_MESSAGE_CHARS).trimEnd()}…\n\n${words.teamMessageTruncated(view.text.length - MAX_TEAM_MESSAGE_CHARS, who)}`
				: view.text;
		this.addChild(new Markdown(text, 3, 0, markdownTheme, { color: (text: string) => theme.fg("text", text) }));
	}
}

function boundedIds(ids: readonly string[], totalCount: number): string {
	const shown = ids.slice(0, 4);
	const omitted = Math.max(0, totalCount - shown.length);
	return `[${shown.join(", ")}${omitted > 0 ? `, +${omitted}` : ""}]`;
}

interface BackgroundActivitySummary {
	text: string;
	status: "success" | "warning" | "error";
}

class BackgroundActivitySummaryComponent implements Component {
	private readonly summary: BackgroundActivitySummary;

	constructor(summary: BackgroundActivitySummary) {
		this.summary = summary;
	}

	render(width: number): string[] {
		const line = `${theme.fg(this.summary.status, "•")} ${theme.fg("muted", this.summary.text)}`;
		return [truncateToWidth(line, Math.max(1, width), "…")];
	}

	invalidate(): void {}
}

function formatCountedStatus(
	count: number,
	noun: (count: number) => string,
	status: (count: number, noun: string) => string,
	ids: readonly string[],
): string | undefined {
	if (count === 0) return undefined;
	const idsText = ids.length > 0 ? ` ${boundedIds(ids, count)}` : "";
	return `${status(count, noun(count))}${idsText}`;
}

function fallbackBackgroundActivitySummary(kind: "agent" | "task"): BackgroundActivitySummary {
	return {
		text: interfaceText().conversation.backgroundActivityUnavailable(kind),
		status: "warning",
	};
}

function recordSummaryItems(
	kind: "agent" | "task",
	records: readonly Record<string, unknown>[],
): BackgroundActivitySummaryItem[] | undefined {
	const items: BackgroundActivitySummaryItem[] = [];
	for (const record of records) {
		const id = kind === "agent" ? record.laneId : record.taskId;
		if (typeof id !== "string" || id.length === 0 || typeof record.status !== "string") return undefined;
		if (kind === "agent") {
			const claimNeedsReview =
				isPlainRecord(record.claim) &&
				(record.claim.parentReviewRequired === true ||
					(isPlainRecord(record.claim.verification) && record.claim.verification.verdict === "rejected"));
			const status =
				record.status === "failed" || record.status === "timeout" || record.status === "budget_exhausted"
					? "failed"
					: record.status === "canceled"
						? "canceled"
						: claimNeedsReview || record.status === "partial" || record.status === "blocked"
							? "attention"
							: record.status === "succeeded"
								? "success"
								: undefined;
			if (!status) return undefined;
			items.push({ id, status });
			continue;
		}
		if (record.status !== "completed" && record.status !== "failed" && record.status !== "canceled") return undefined;
		items.push({
			id,
			status: record.status === "failed" ? "failed" : record.status === "canceled" ? "canceled" : "success",
		});
	}
	return items;
}

function readSummaryContract(
	message: CustomMessage<unknown>,
	kind: "agent" | "task",
	items: readonly BackgroundActivitySummaryItem[] | undefined,
): BackgroundActivitySummaryContract | undefined {
	if (isPlainRecord(message.details) && isBackgroundActivitySummaryContract(message.details.summary)) {
		const summary = message.details.summary;
		if (summary.kind !== kind || !items || summary.totalCount < items.length) return undefined;
		const includedCounts = {
			success: items.filter((item) => item.status === "success").length,
			attention: items.filter((item) => item.status === "attention").length,
			failed: items.filter((item) => item.status === "failed").length,
			canceled: items.filter((item) => item.status === "canceled").length,
		};
		const successCount = summary.totalCount - summary.attentionCount - summary.failedCount - summary.canceledCount;
		if (
			successCount < includedCounts.success ||
			summary.attentionCount < includedCounts.attention ||
			summary.failedCount < includedCounts.failed ||
			summary.canceledCount < includedCounts.canceled
		) {
			return undefined;
		}
		return summary;
	}
	return items && items.length > 0 ? createBackgroundActivitySummaryContract(kind, items) : undefined;
}

/**
 * Which model ran and what it did, in a few words, so a subagent completion says more than a count. Both
 * facts come from the record's own fields (`modelRef`, `claim.summary`); the rendered message text is never read.
 */
function agentDetailSuffix(records: readonly Record<string, unknown>[]): string | undefined {
	const models: string[] = [];
	for (const record of records.slice(0, 2)) {
		if (typeof record.modelRef !== "string") continue;
		const model = record.modelRef.split("/").pop();
		if (model && !models.includes(model)) models.push(model);
	}
	const firstClaim = records[0]?.claim;
	const claimSummary = isPlainRecord(firstClaim) && typeof firstClaim.summary === "string" ? firstClaim.summary : "";
	const snippet = claimSummary.replace(/[\p{Cc}\s]+/gu, " ").trim();
	const capped = snippet.length > 90 ? `${snippet.slice(0, 89)}…` : snippet;
	const parts = [models.length > 0 ? models.join(" · ") : undefined, capped || undefined].filter(
		(part): part is string => part !== undefined,
	);
	return parts.length > 0 ? parts.join(" — ") : undefined;
}

/**
 * A routine's result, expiry or end, and the host's intake notice, are durable model input: their content is the fenced
 * report and instructions for the model. The owner's history reads one line built from the message's own fields; the
 * rendered content is never shown or parsed.
 */
function formatRoutineActivitySummary(message: CustomMessage<unknown>): BackgroundActivitySummary | undefined {
	// A message the host delivered as parent input keeps the fields it was built with beside the ledger's own.
	const raw = isPlainRecord(message.details) ? message.details : {};
	const details = "parentInput" in raw && isPlainRecord(raw.originalDetails) ? raw.originalDetails : raw;
	const routineId = typeof details.routineId === "string" ? details.routineId : undefined;
	const text = interfaceText().conversation;
	if (message.customType === "routine-intake") {
		if (routineId) return { text: text.scheduledRoutine(routineId), status: "success" };
		const refused = typeof details.refused === "string" ? details.refused : undefined;
		const other = Object.entries(details).find(
			([key, value]) => key !== "routineIntakeKey" && key !== "sourceId" && typeof value === "string",
		);
		const reason = refused ?? (typeof other?.[1] === "string" ? other[1] : undefined);
		return {
			text: text.scheduleOutcome(Boolean(refused), reason),
			status: "warning",
		};
	}
	if (message.customType !== "routine-completion" || !routineId) return undefined;
	if (typeof details.expiresAt === "number") return { text: text.routineExpired(routineId), status: "warning" };
	if (typeof details.conditionMetBy === "string") return { text: text.routineEnded(routineId), status: "success" };
	const outcome = typeof details.outcome === "string" ? details.outcome : text.routineEndedOutcome;
	const note = [
		details.ownerUpdate === "none" ? text.routineNothingForYou : undefined,
		details.deliveryHold !== undefined ? text.routineWaitsForMessage : undefined,
		typeof details.missedCount === "number" && details.missedCount > 0
			? text.routineEarlierSlots(details.missedCount)
			: undefined,
		typeof details.resultPreview === "string" ? details.resultPreview : undefined,
	].filter((part): part is string => part !== undefined);
	// A watch run leads with what the host saw in plain words ('A watched file changed: notes.txt'), not the routine's id.
	const cause = typeof details.cause === "string" ? details.cause : undefined;
	const suffix = note.length > 0 ? ` · ${note.join(" · ")}` : "";
	return {
		text: `${cause ? text.routineOutcomeWithCause(cause, outcome) : text.routineOutcome(routineId, outcome)}${suffix}`,
		status: outcome === "succeeded" ? "success" : outcome === "failed" ? "error" : "warning",
	};
}

function formatBackgroundActivitySummary(message: CustomMessage<unknown>): BackgroundActivitySummary | undefined {
	const supervisionSummary = formatSupervisionActivitySummary(message);
	if (supervisionSummary) return supervisionSummary;
	const routineSummary = formatRoutineActivitySummary(message);
	if (routineSummary) return routineSummary;
	const kind =
		message.customType === "background-worker-completion"
			? "agent"
			: message.customType === "background-tool-completion"
				? "task"
				: undefined;
	if (!kind) return undefined;
	if (!isPlainRecord(message.details) || !Array.isArray(message.details.records))
		return fallbackBackgroundActivitySummary(kind);
	if (message.details.records.some((record) => !isPlainRecord(record))) return fallbackBackgroundActivitySummary(kind);
	const records = message.details.records as Record<string, unknown>[];
	const items = recordSummaryItems(kind, records);
	const summary = readSummaryContract(message, kind, items);
	if (!summary || !items) return fallbackBackgroundActivitySummary(kind);
	const words = interfaceText().conversation;
	const noun = kind === "agent" ? words.agentNoun : words.taskNoun;
	const successIds = items.filter((item) => item.status === "success").map((item) => item.id);
	const attentionIds = items.filter((item) => item.status === "attention").map((item) => item.id);
	const failedIds = items.filter((item) => item.status === "failed").map((item) => item.id);
	const canceledIds = items.filter((item) => item.status === "canceled").map((item) => item.id);
	const successCount = summary.totalCount - summary.attentionCount - summary.failedCount - summary.canceledCount;
	const text = [
		formatCountedStatus(successCount, noun, words.activitySucceeded, successIds),
		formatCountedStatus(summary.attentionCount, noun, words.activityNeedsVerification, attentionIds),
		formatCountedStatus(summary.failedCount, noun, words.activityFailed, failedIds),
		formatCountedStatus(summary.canceledCount, noun, words.activityCanceled, canceledIds),
	]
		.filter((part): part is string => part !== undefined)
		.join(" | ");
	const detail = kind === "agent" ? agentDetailSuffix(records) : undefined;
	return {
		text: detail ? `${text} · ${detail}` : text,
		status:
			summary.failedCount > 0 ? "error" : summary.attentionCount + summary.canceledCount > 0 ? "warning" : "success",
	};
}

/**
 * Supervision is durable model input, but its raw lifecycle prose is not a second TUI renderer.
 * Keep it in the session/custom-message stream for the model and transcript overlay while the
 * foreground history uses the same one-line activity projection as background completions.
 */
function formatSupervisionActivitySummary(message: CustomMessage<unknown>): BackgroundActivitySummary | undefined {
	if (message.customType === "worktree-sync-notice") {
		return { text: interfaceText().conversation.worktreeSyncActivity, status: "warning" };
	}
	if (message.customType === "process-matrix-notice") {
		return { text: interfaceText().conversation.processSupervisionActivity, status: "warning" };
	}
	return undefined;
}
