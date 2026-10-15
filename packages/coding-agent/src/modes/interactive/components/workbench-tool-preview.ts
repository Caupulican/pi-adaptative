import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@caupulican/pi-tui";
import { shortModelName } from "../../../core/route-text.ts";
import type { SemanticEvaluationRecord } from "../../../core/system-one/semantic-evaluation-ledger.ts";
import { formatCompactDuration } from "../../../core/util/format-duration.ts";
import { isRecordObject } from "../../../core/util/value-guards.ts";
import { sanitizeBinaryOutput } from "../../../kernel/utils/shell-output.ts";
import { renderDiff } from "../../../presentation/diff.ts";
import { getLanguageFromPath, highlightCode, theme } from "../../../presentation/theme-model.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { SYSTEM_ONE_TONE } from "./decision-graph-render.ts";
import { metaRow, toneRow } from "./workbench-pane.ts";

/** Who produced a piece of evidence, captured when the preview is created, never re-derived later. */
export interface PreviewAttribution {
	readonly kind: "root" | "worker" | "system-one";
	readonly label: string;
	readonly modelRef?: string;
	/** The model's display name (`Grok 4.7`), as the status line shows it; the id is the fallback. */
	readonly modelName?: string;
}

/**
 * Who produced it, only when it is not the session's own model: the status line already names that one, so
 * repeating it on every entry is noise. A routed turn or another actor is named, by its display name.
 */
export function attributionText(by: PreviewAttribution): string | undefined {
	if (by.kind === "system-one") return "System One";
	if (by.label === "root") return undefined;
	return `${by.label} · ${by.modelName ?? shortModelName(by.modelRef)}`;
}

/** The state of an entry's call: its bar's tone and mark. */
export type EntryState = "done" | "failed" | "running";

/** The call's bar tone by state; the output's box has its own distinct surface (`OUTPUT_BACKGROUND`). */
const BAR_BACKGROUND = { done: "toolSuccessBg", failed: "toolErrorBg", running: "toolPendingBg" } as const;
const BAR_MARK = { done: ["✓", "success"], failed: ["✗", "error"], running: ["●", "accent"] } as const;

/** What an Execution entry says: the call (a bar) and, apart from it, what came out (a gutter block). */
export interface ExecutionEntry {
	readonly state: EntryState;
	/** The tool or source, in bold: `bash`, `edit`, `System One`. */
	readonly name: string;
	/** What it ran or touched: the command, the file, the evaluation. */
	readonly subject?: string;
	/** Who produced it, at the right of the bar. */
	readonly by?: string;
	/** The label of the output box (`output · 3 lines`, `diff +2 −1`); the box is absent without a body. */
	readonly outputLabel?: string;
	/** The output, one styled string per source line. */
	readonly body?: readonly string[];
	/** Number the source lines (plain command output); a diff carries its own numbers. */
	readonly numbered?: boolean;
	/** What a collapsed entry shows at the right of its bar in place of the output (`3 lines`, `+2 −1`, `error`). */
	readonly summary?: string;
}

/** How much of an entry shows: just its call, the call with a bounded output, or the whole output. */
export type EntryView = "collapsed" | "expanded" | "full";

/** What a row of a rendered entry is, so a click can be answered: the call bar, the show-all row, or output. */
export type RowRole = "bar" | "more" | "body";

/** An output past this many source lines is trimmed to it in the `expanded` view, with a row to show all. */
const PREVIEW_LINES = 12;

const OUTPUT_BACKGROUND = "codeBlockBg";

/**
 * One Execution entry as rows, and what each row is. The CALL is a full-width bar on its tool surface (a chevron
 * when it has output, the status mark, the tool, what it ran, and at the right a non-default producer or, when
 * collapsed, the output's summary). The OUTPUT is its own bordered box beneath it, on a distinct surface, titled
 * in its border, in the main text color with its source lines numbered: one object that cannot be mistaken for the
 * call or for a column of calls. `collapsed` draws only the bar; `expanded` trims a long output to a preview with a
 * row to show all; `full` draws every line.
 */
export function renderExecutionEntry(
	entry: ExecutionEntry,
	width: number,
	view: EntryView = "expanded",
): { readonly rows: string[]; readonly roles: RowRole[] } {
	const [mark, markTone] = BAR_MARK[entry.state];
	const hasOutput = Boolean(entry.body?.length);
	const collapsed = hasOutput && view === "collapsed";
	const chevron = hasOutput ? `${theme.fg("muted", collapsed ? "▸" : "▾")} ` : "";
	const left = `${chevron}${theme.fg(markTone, mark)} ${theme.bold(theme.fg(entry.state === "failed" ? "error" : "toolTitle", entry.name))}${
		entry.subject ? `  ${theme.fg("text", entry.subject)}` : ""
	}`;
	const leftWidth =
		(hasOutput ? 2 : 0) +
		visibleWidth(mark) +
		1 +
		visibleWidth(entry.name) +
		(entry.subject ? 2 + visibleWidth(entry.subject) : 0);
	const right = [
		collapsed && entry.summary ? theme.fg("muted", entry.summary) : "",
		entry.by ? theme.fg("text", entry.by) : "",
	]
		.filter(Boolean)
		.join("  ");
	const bar = toneRow(
		BAR_BACKGROUND[entry.state],
		` ${metaRow(left, right, Math.max(1, width - 2), leftWidth)} `,
		width,
	);
	if (!hasOutput || collapsed || !entry.body) return { rows: [bar], roles: ["bar"] };

	const edge = (text: string) => theme.fg(entry.state === "failed" ? "error" : "border", text);
	const inner = Math.max(6, width - 4);
	const shown = view === "full" ? entry.body : entry.body.slice(0, PREVIEW_LINES);
	const hidden = entry.body.length - shown.length;
	const numberWidth = entry.numbered ? String(entry.body.length).length : 0;
	const textWidth = Math.max(1, inner - 2 - (numberWidth ? numberWidth + 2 : 0));
	const rows: string[] = [];
	shown.forEach((line, index) => {
		wrapTextWithAnsi(line, textWidth).forEach((part, piece) => {
			const number = numberWidth
				? `${piece === 0 ? theme.fg("dim", String(index + 1).padStart(numberWidth)) : " ".repeat(numberWidth)}  `
				: "";
			rows.push(`${number}${part}`);
		});
	});
	const label = entry.outputLabel ? ` ${entry.outputLabel} ` : "";
	const top = `${edge("╭─")}${label ? theme.fg("muted", label) : ""}${edge(`${"─".repeat(Math.max(0, inner - 1 - visibleWidth(label)))}╮`)}`;
	const bottom = edge(`╰${"─".repeat(inner)}╯`);
	const boxed = (row: string) => ` ${edge("│")}${toneRow(OUTPUT_BACKGROUND, ` ${row}`, inner)}${edge("│")}`;
	const more =
		hidden > 0
			? [boxed(theme.fg("mdLink", `▾ ${hidden} more ${hidden === 1 ? "line" : "lines"} · click to show all`))]
			: [];
	return {
		rows: [bar, ` ${top}`, ...rows.map(boxed), ...more, ` ${bottom}`],
		roles: ["bar", "body", ...rows.map((): RowRole => "body"), ...more.map((): RowRole => "more"), "body"],
	};
}

/**
 * A preview the Execution pane manages: it can be shown collapsed, expanded or in full, and says what each of its
 * rows is so a click lands on the right thing. The pane (not the entry) decides the view.
 */
export interface ExecutionPreview extends Component {
	readonly entryId: string;
	/** Needs attention: kept open unless the operator closes it. */
	readonly failed: boolean;
	/** Has an output that can fold. */
	readonly collapsible: boolean;
	setView(view: EntryView): void;
	/** The role of every row of the last render. */
	rowRoles(): readonly RowRole[];
}

export function isExecutionPreview(preview: Component): preview is ExecutionPreview {
	return "entryId" in preview && "setView" in preview;
}

let previewSequence = 0;

/** A preview that renders an entry at whatever width it is given; the entry is fixed when the receipt is made. */
export function createExecutionPreview(entry: ExecutionEntry): ExecutionPreview {
	let view: EntryView = "expanded";
	let roles: RowRole[] = [];
	return {
		entryId: `exec-${++previewSequence}`,
		failed: entry.state === "failed",
		collapsible: Boolean(entry.body?.length),
		setView(next) {
			view = next;
		},
		rowRoles: () => roles,
		render(width) {
			const rendered = renderExecutionEntry(entry, width, view);
			roles = rendered.roles;
			return rendered.rows;
		},
		invalidate() {},
	};
}

interface PreviewResult {
	isError: boolean;
	content: readonly { type: string; text?: string }[];
	details?: unknown;
}

/**
 * A FAILED System One evaluation as Execution evidence: a call bar on the error surface naming the evaluation,
 * its reasons as the output block. (A routine judgment is not evidence here; the Decision graph shows it.)
 */
export function createSystemOneEvaluationPreview(record: SemanticEvaluationRecord): ExecutionPreview {
	const failed = record.outcome === "failed";
	const cancelled = record.outcome === "cancelled";
	const label = sanitizeBinaryOutput(stripAnsi(record.label)).slice(0, 200);
	const outcome = failed ? "failed" : cancelled ? "cancelled" : (record.verdict ?? "ok");
	const reasons = (record.reasons ?? [])
		.slice(0, 6)
		.map((reason) => sanitizeBinaryOutput(stripAnsi(reason)).slice(0, 240));
	return createExecutionPreview({
		state: failed ? "failed" : "done",
		name: "System One",
		subject: `${label} · ${outcome} · ${formatCompactDuration(record.durationMs)}`,
		...(reasons.length
			? {
					outputLabel: "reasons",
					summary: `${reasons.length} ${reasons.length === 1 ? "reason" : "reasons"}`,
					body: reasons.map((reason) => theme.fg(failed ? "error" : SYSTEM_ONE_TONE, reason)),
				}
			: {}),
	});
}

/** Most tokens of one output that are looked up on disk: a path is recognised by existing, never by its shape. */
const MAX_PATH_LOOKUPS = 400;

interface OutputPaths {
	readonly cwd: string;
	/** Where a bare name in the output may live: the folder itself, then each existing folder the command named. */
	readonly bases: readonly string[];
	lookups: number;
}

/** The folders an output's names may be relative to: the working folder and the directories the command named. */
function outputPaths(cwd: string, command: string): OutputPaths {
	const bases = [cwd];
	for (const word of command.split(/[\s;|&()<>]+/)) {
		const candidate = word.replace(/^['"]|['"]$/g, "");
		if (!candidate || candidate.startsWith("-")) continue;
		const folder = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		try {
			if (statSync(folder).isDirectory() && !bases.includes(folder)) bases.push(folder);
		} catch {
			// Not a folder the command named: it only means no extra base.
		}
	}
	return { cwd, bases: bases.slice(0, 4), lookups: 0 };
}

/** A path inside the working folder as `./path`, a path outside it absolute; folders end with `/`. */
function displayPath(paths: OutputPaths, absolute: string, isFolder: boolean): string {
	const rel = relative(paths.cwd, absolute);
	const shown = rel === "" ? "./" : rel.startsWith("..") || isAbsolute(rel) ? absolute : `./${rel}`;
	return isFolder && !shown.endsWith("/") ? `${shown}/` : shown;
}

/**
 * One output line in the main text color, with every word that names something that EXISTS on disk shown as a path
 * (`./src/app.ts`, `./packages/ai/`, with its `:line` kept) in the path tone, so a file stands out from plain text.
 */
function styleOutputLine(line: string, paths: OutputPaths | undefined): string {
	if (!paths) return theme.fg("text", line);
	return line
		.split(/(\s+)/)
		.map((token) => {
			if (!token.trim() || paths.lookups >= MAX_PATH_LOOKUPS) return theme.fg("text", token);
			const match = /^(.*?)((?::\d+){1,2})?$/.exec(token);
			const name = match?.[1] ?? token;
			const suffix = match?.[2] ?? "";
			if (!name || name.length > 512 || /^https?:\/\//.test(name)) return theme.fg("text", token);
			for (const base of paths.bases) {
				paths.lookups++;
				const absolute = isAbsolute(name) ? name : resolve(base, name);
				if (!existsSync(absolute)) {
					if (isAbsolute(name)) break;
					continue;
				}
				let isFolder = false;
				try {
					isFolder = statSync(absolute).isDirectory();
				} catch {
					// Vanished between the two calls: show it as a file.
				}
				return theme.fg("mdLink", `${displayPath(paths, absolute, isFolder)}${suffix}`);
			}
			return theme.fg("text", token);
		})
		.join("");
}

/** Text-only effect projection; never expands the canonical action or hydrates routine read payloads. */
export function createWorkbenchToolPreview(
	name: string,
	args: unknown,
	result: PreviewResult,
	by?: PreviewAttribution,
	cwd?: string,
): ExecutionPreview | undefined {
	if (!result.isError && !["edit", "write", "bash", "python", "shell"].includes(name)) return undefined;
	const parameters = isRecordObject(args) ? args : {};
	const details = isRecordObject(result.details) ? result.details : {};
	const path = typeof parameters.path === "string" ? parameters.path : "";
	let body = "";
	let diff = false;
	if (!result.isError && ["edit", "write"].includes(name) && typeof details.diff === "string") {
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
	let added = 0;
	let removed = 0;
	if (diff) {
		for (const line of bounded.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added++;
			else if (line.startsWith("-") && !line.startsWith("---")) removed++;
		}
	}
	// What the receipt is about: the file for an edit, the command for a shell, so the bar says what ran.
	const command = typeof parameters.command === "string" ? (parameters.command.split("\n", 1)[0] ?? "").trim() : "";
	const subject = sanitizeBinaryOutput(stripAnsi(path || command)).slice(0, 512);
	const truncated = body.length > bounded.length + 1;
	const lines = bounded.trim() ? bounded.trimEnd().split("\n").length : 0;
	const sourceLines = bounded.trim() ? bounded.trimEnd().split("\n") : [];
	const paths = diff || !cwd ? undefined : outputPaths(cwd, command);
	const styledLines = diff
		? renderDiff(bounded, {
				highlightContent: (content) =>
					highlightCode(content, getLanguageFromPath(path), { plainColor: "text" }).join("\n"),
			}).split("\n")
		: sourceLines.map((line) => styleOutputLine(line, paths));
	const styled = [
		...(sourceLines.length ? styledLines : []),
		...(truncated ? [theme.fg("dim", "… full result in transcript")] : []),
	];
	const failed = result.isError;
	const summary = failed
		? `error · ${lines} ${lines === 1 ? "line" : "lines"}`
		: diff
			? `+${added} −${removed}`
			: `${lines} ${lines === 1 ? "line" : "lines"}`;
	const outputLabel = failed
		? "error"
		: diff
			? `diff${added || removed ? `  +${added} −${removed}` : ""}`
			: `output · ${lines} ${lines === 1 ? "line" : "lines"}`;
	return createExecutionPreview({
		state: failed ? "failed" : "done",
		name,
		...(subject ? { subject } : {}),
		...(by && attributionText(by) ? { by: attributionText(by) as string } : {}),
		...(styled.length ? { outputLabel, body: styled, numbered: !diff, summary } : {}),
	});
}
