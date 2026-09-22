import { sanitizeBinaryOutput } from "@caupulican/pi-agent-core/shell-output";
import { type Component, Text, visibleWidth } from "@caupulican/pi-tui";
import {
	evaluationResultText,
	type SemanticEvaluationRecord,
} from "../../../core/system-one/semantic-evaluation-ledger.ts";
import { isRecordObject } from "../../../core/util/value-guards.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { formatGraphDuration } from "./decision-graph-render.ts";
import { renderDiff } from "./diff.ts";
import { shortModelName } from "./operator-pov-bar.ts";
import { metaRow } from "./workbench-pane.ts";

/** Who produced a piece of evidence, captured when the preview is created, never re-derived later. */
export interface PreviewAttribution {
	readonly kind: "root" | "worker" | "system-one";
	readonly label: string;
	readonly modelRef?: string;
}

const SYSTEM_ONE_TONE = "customMessageLabel";

/** `actor · model` as the preview title's right side; System One names its plane instead of a model. */
export function attributionText(by: PreviewAttribution): string {
	return by.kind === "system-one" ? "system one" : `${by.label} · ${shortModelName(by.modelRef)}`;
}

interface PreviewResult {
	isError: boolean;
	content: readonly { type: string; text?: string }[];
	details?: unknown;
}

/**
 * A settled System One evaluation as Execution evidence, on the cyan tone: `◆ System One <label>` with
 * `system one` and `<verdict> · <duration>` on the right, its reasons as the body. A failed
 * evaluation reads as a failure; a cancelled one is dim and says so.
 */
export function createSystemOneEvaluationPreview(record: SemanticEvaluationRecord): Component {
	const failed = record.outcome === "failed";
	const cancelled = record.outcome === "cancelled";
	const tone = failed ? "error" : cancelled ? "dim" : SYSTEM_ONE_TONE;
	const label = sanitizeBinaryOutput(stripAnsi(record.label)).slice(0, 200);
	const titleText = `◆ System One ${label}`;
	const title = theme.fg(tone, titleText);
	const outcome = failed ? "failed" : cancelled ? "cancelled" : (record.verdict ?? "ok");
	const right = theme.fg(
		"muted",
		`${attributionText({ kind: "system-one", label: "System One" })} · ${outcome} · ${formatGraphDuration(record.durationMs)}`,
	);
	const reasons = (record.reasons ?? [])
		.slice(0, 6)
		.map((reason) => sanitizeBinaryOutput(stripAnsi(reason)).slice(0, 240));
	let body: Text | undefined;
	return {
		render(width) {
			body ??= new Text(reasons.map((reason) => theme.fg(failed ? "error" : "toolOutput", reason)).join("\n"), 0, 0);
			return [metaRow(title, right, width, visibleWidth(titleText)), ...(reasons.length ? body.render(width) : [])];
		},
		invalidate() {
			body = undefined;
		},
	};
}

/**
 * Every System One evaluation of the cycle as one row, updated in place: how many, their average time,
 * the last judgment, and how many of each kind. One row per evaluation buried the work under
 * judgments that had nothing to show; the ledger keeps each one, and a failure keeps its own row.
 */
export function createSystemOneSummaryPreview(records: readonly SemanticEvaluationRecord[]): Component {
	const count = records.length;
	const averageMs = count ? records.reduce((sum, record) => sum + record.durationMs, 0) / count : 0;
	const failed = records.filter((record) => record.outcome === "failed").length;
	const last = records.at(-1);
	const lastResult = last && evaluationResultText(last);
	const clean = (text: string) => sanitizeBinaryOutput(stripAnsi(text)).slice(0, 80);
	const titleText = `◆ System One · ${count} evaluation${count === 1 ? "" : "s"} · avg ${formatGraphDuration(averageMs)}${
		failed ? ` · ${failed} failed` : ""
	}`;
	const title = theme.fg(failed ? "error" : SYSTEM_ONE_TONE, titleText);
	const right = last ? theme.fg("muted", `last: ${clean(last.label)}${lastResult ? ` · ${lastResult}` : ""}`) : "";
	const kinds = new Map<string, number>();
	for (const record of records) kinds.set(clean(record.label), (kinds.get(clean(record.label)) ?? 0) + 1);
	const breakdown = theme.fg(
		"dim",
		[...kinds].map(([label, times]) => (times > 1 ? `${label} ×${times}` : label)).join(" · "),
	);
	let body: Text | undefined;
	return {
		render(width) {
			body ??= new Text(breakdown, 0, 0);
			return [metaRow(title, right, width, visibleWidth(titleText)), ...body.render(width)];
		},
		invalidate() {
			body = undefined;
		},
	};
}

/** Text-only effect projection; never expands the canonical action or hydrates routine read payloads. */
export function createWorkbenchToolPreview(
	name: string,
	args: unknown,
	result: PreviewResult,
	by?: PreviewAttribution,
): Component | undefined {
	if (!result.isError && !["edit", "write", "bash", "python", "shell"].includes(name)) return undefined;
	const parameters = isRecordObject(args) ? args : {};
	const details = isRecordObject(result.details) ? result.details : {};
	const path = typeof parameters.path === "string" ? parameters.path : "";
	let body = "";
	let diff = false;
	if (!result.isError && typeof details.diff === "string") {
		body = details.diff;
		diff = true;
	} else if (!result.isError && name === "write" && typeof parameters.content === "string") {
		body = parameters.content
			.slice(0, 16_384)
			.split("\n", 40)
			.map((line, index) => `+${index + 1} ${line}`)
			.join("\n");
		diff = true;
	} else {
		for (const block of result.content) {
			if (body.length >= 16_384) break;
			if (block.type === "text" && block.text) body += `${block.text.slice(0, 16_384 - body.length)}\n`;
		}
	}
	const bounded = sanitizeBinaryOutput(stripAnsi(body.slice(0, 16_384)))
		.replace(/\r/g, "")
		.split("\n", 40)
		.join("\n");
	let counts = "";
	if (diff) {
		let added = 0;
		let removed = 0;
		for (const line of bounded.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added++;
			else if (line.startsWith("-") && !line.startsWith("---")) removed++;
		}
		if (added || removed)
			counts = `  ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`;
	}
	const label = sanitizeBinaryOutput(stripAnsi(`${name}${path ? ` · ${path}` : ""}`)).slice(0, 512);
	const failed = result.isError;
	const truncated = body.length > bounded.length + 1;
	const titleText = `${failed ? "Failed · " : ""}${label}`;
	const title = theme.fg(failed ? "error" : "toolTitle", titleText) + counts;
	const titleWidth = visibleWidth(titleText) + visibleWidth(counts);
	const right = by ? theme.fg("muted", attributionText(by)) : "";
	let component: Text | undefined;
	return {
		render(width) {
			component ??= new Text(
				(bounded.trim() ? `${diff ? renderDiff(bounded) : theme.fg("toolOutput", bounded.trimEnd())}` : "") +
					(truncated ? theme.fg("dim", `${bounded.trim() ? "\n" : ""}… full result in transcript`) : ""),
				0,
				0,
			);
			const rows = bounded.trim() || truncated ? component.render(width) : [];
			return [metaRow(title, right, width, titleWidth), ...rows];
		},
		invalidate() {
			component = undefined;
		},
	};
}
