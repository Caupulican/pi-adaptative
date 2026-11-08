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
import { isPlainRecord } from "../../../core/util/value-guards.ts";
import type { CustomMessage } from "../../../kernel/index.ts";
import { isModelFacingText, MODEL_FACING_PLACEHOLDER, plainLabel } from "../../../presentation/plain-text.ts";
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

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(isModelFacingText(text) ? MODEL_FACING_PLACEHOLDER : text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
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
		const who =
			view.from.kind === "operator" ? "You" : view.from.kind === "brain" ? "Brain" : (view.from.agentId ?? "bot");
		const tone = view.from.kind === "operator" ? "text" : view.from.kind === "brain" ? "muted" : teamSpeakerTone(who);
		const recipients =
			view.to.length > 0
				? view.to.map((id) => `@${id}`).join(", ")
				: view.from.kind === "operator"
					? "everyone"
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
				? `${view.text.slice(0, MAX_TEAM_MESSAGE_CHARS).trimEnd()}…\n\n_+${view.text.length - MAX_TEAM_MESSAGE_CHARS} more characters; open ${who}'s own chat for the rest._`
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

function noun(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function formatCountedStatus(
	count: number,
	singularNoun: string,
	singularVerb: string,
	pluralVerb: string,
	ids: readonly string[],
): string | undefined {
	if (count === 0) return undefined;
	const verb = count === 1 ? singularVerb : pluralVerb;
	const idsText = ids.length > 0 ? ` ${boundedIds(ids, count)}` : "";
	return `${count} ${noun(count, singularNoun)} ${verb}${idsText}`;
}

function fallbackBackgroundActivitySummary(kind: "agent" | "task"): BackgroundActivitySummary {
	const singularNoun = kind === "agent" ? "agent" : "background task";
	return {
		text: `Background ${singularNoun} activity unavailable`,
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
	if (message.customType === "routine-intake") {
		if (routineId) return { text: `Scheduled routine ${routineId}`, status: "success" };
		const refused = typeof details.refused === "string" ? details.refused : undefined;
		const other = Object.entries(details).find(
			([key, value]) => key !== "routineIntakeKey" && key !== "sourceId" && typeof value === "string",
		);
		const reason = refused ?? (typeof other?.[1] === "string" ? other[1] : undefined);
		return {
			text: `${refused ? "Not scheduled" : "Could not schedule"}${reason ? `: ${reason}` : ""}`,
			status: "warning",
		};
	}
	if (message.customType !== "routine-completion" || !routineId) return undefined;
	if (typeof details.expiresAt === "number")
		return { text: `Routine ${routineId} reached its end time and was removed`, status: "warning" };
	if (typeof details.conditionMetBy === "string")
		return { text: `Routine ${routineId} met its end and was removed`, status: "success" };
	const outcome = typeof details.outcome === "string" ? details.outcome : "ended";
	const note = [
		details.ownerUpdate === "none" ? "nothing for you" : undefined,
		details.deliveryHold !== undefined ? "waits for your next message" : undefined,
		typeof details.missedCount === "number" && details.missedCount > 0
			? `covers ${details.missedCount} earlier ${details.missedCount === 1 ? "slot" : "slots"}`
			: undefined,
		typeof details.resultPreview === "string" ? details.resultPreview : undefined,
	].filter((part): part is string => part !== undefined);
	return {
		text: `Routine ${routineId} ${outcome}${note.length > 0 ? ` · ${note.join(" · ")}` : ""}`,
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
	const nounName = kind === "agent" ? "agent" : "background task";
	const successIds = items.filter((item) => item.status === "success").map((item) => item.id);
	const attentionIds = items.filter((item) => item.status === "attention").map((item) => item.id);
	const failedIds = items.filter((item) => item.status === "failed").map((item) => item.id);
	const canceledIds = items.filter((item) => item.status === "canceled").map((item) => item.id);
	const successCount = summary.totalCount - summary.attentionCount - summary.failedCount - summary.canceledCount;
	const text = [
		formatCountedStatus(successCount, nounName, "succeeded", "succeeded", successIds),
		formatCountedStatus(summary.attentionCount, nounName, "needs verification", "need verification", attentionIds),
		formatCountedStatus(summary.failedCount, nounName, "failed", "failed", failedIds),
		formatCountedStatus(summary.canceledCount, nounName, "canceled", "canceled", canceledIds),
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
		return { text: "Worktree sync activity", status: "warning" };
	}
	if (message.customType === "process-matrix-notice") {
		return { text: "Process supervision activity", status: "warning" };
	}
	return undefined;
}
