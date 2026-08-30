import type { CustomMessage } from "@caupulican/pi-agent-core";
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
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { renderTitleBadge } from "./tool-title.ts";

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
		this.box.addChild(new Text(renderTitleBadge(theme, { label: this.message.customType }), 0, 0));
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
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
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
			const claimNeedsReview = isPlainRecord(record.claim) && record.claim.parentReviewRequired === true;
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

function formatBackgroundActivitySummary(message: CustomMessage<unknown>): BackgroundActivitySummary | undefined {
	const supervisionSummary = formatSupervisionActivitySummary(message);
	if (supervisionSummary) return supervisionSummary;
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
	return {
		text,
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
