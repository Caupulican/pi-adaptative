/**
 * `decision_ledger_read`: the bounded read surface over the decision ledger, for the root and
 * System One only. It answers where decisions went wrong and what to improve from the recorded
 * facts — stage transitions with their times and loops, and every Jev evaluation with its verdict —
 * and can replay a past session's graph from the same rows. Never exposed to workers.
 */

import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { DecisionLedgerStore, SemanticEvaluationLedgerRow } from "../operator-projection/decision-ledger-store.ts";
import type { DecisionStageStoredEntry } from "../operator-projection/decision-stage-log.ts";
import { formatCompactDuration } from "../util/format-duration.ts";
import { renderBoundedTextResult, renderTextComponent } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const DECISION_LEDGER_READ_TOOL_NAME = "decision_ledger_read";
const MAX_EVALUATIONS = 50;
const DEFAULT_EVALUATIONS = 20;
const MAX_SESSIONS = 20;

const decisionLedgerReadSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("sessions"), Type.Literal("stages"), Type.Literal("evaluations"), Type.Literal("replay")],
		{
			description:
				"'sessions': recorded sessions in this working directory, newest first. 'stages': the stage transitions of a session (this one by default). 'evaluations': recent Jev evaluations of a session with verdicts and reasons. 'replay': stages and evaluations of a session together, the graph as recorded.",
		},
	),
	sessionId: Type.Optional(
		Type.String({ description: "Session to read; defaults to the current session. Ids come from 'sessions'." }),
	),
	limit: Type.Optional(
		Type.Number({
			description: `Evaluations to return for 'evaluations'/'replay' (default ${DEFAULT_EVALUATIONS}, max ${MAX_EVALUATIONS}).`,
		}),
	),
});

export type DecisionLedgerReadToolInput = Static<typeof decisionLedgerReadSchema>;

export interface DecisionLedgerReadToolDetails {
	action: DecisionLedgerReadToolInput["action"];
	sessionId?: string;
	rows: number;
	available: boolean;
}

export interface DecisionLedgerReadToolOptions {
	/** The session's ledger, opened lazily; absent (or throwing) the tool reports unavailable. */
	getLedger?: () => DecisionLedgerStore | undefined;
	getSessionId?: () => string;
	getCwd?: () => string;
}

function formatTime(ms: number): string {
	return new Date(ms).toISOString();
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : formatCompactDuration(ms);
}

export function formatStageRows(entries: readonly DecisionStageStoredEntry[], nowMs: number): string {
	if (!entries.length) return "no stage transitions recorded";
	return entries
		.map((entry) => {
			const ended = entry.endedAt ?? nowMs;
			const open = entry.endedAt === undefined ? " (open)" : "";
			const reason = entry.reasonCode ? ` reason=${entry.reasonCode}` : "";
			const note = entry.note ? ` note=${entry.note}` : "";
			return `${formatTime(entry.enteredAt)} ${entry.stage} ${formatDuration(Math.max(0, ended - entry.enteredAt))} loop=${entry.loop} objective=${entry.objectiveId}${reason}${note}${open}`;
		})
		.join("\n");
}

export function formatEvaluationRows(rows: readonly SemanticEvaluationLedgerRow[]): string {
	if (!rows.length) return "no evaluations recorded";
	return rows
		.map((row) => {
			const outcome = row.outcome ?? "in flight";
			const verdict = row.verdict ? ` verdict=${row.verdict}` : "";
			const duration =
				row.endedAt !== undefined ? ` ${formatDuration(Math.max(0, row.endedAt - row.startedAt))}` : "";
			const model = row.model ? ` model=${row.model}` : "";
			const consequence = row.consequence ? ` consequence=${row.consequence}` : "";
			const reasons = row.reasons?.length ? `\n  ${row.reasons.join("\n  ")}` : "";
			return `${formatTime(row.startedAt)} ${row.label} [${row.programId}] ${outcome}${verdict}${duration}${model}${consequence}${reasons}`;
		})
		.join("\n");
}

function formatCall(args: { action?: string; sessionId?: string } | undefined, theme: Theme): string {
	const action = args?.action ?? "?";
	const session = args?.sessionId ? theme.fg("muted", ` ${args.sessionId}`) : "";
	return `${theme.fg("toolTitle", theme.bold(DECISION_LEDGER_READ_TOOL_NAME))} ${theme.fg("accent", action)}${session}`;
}

export function createDecisionLedgerReadToolDefinition(
	_cwd: string,
	options?: DecisionLedgerReadToolOptions,
): ToolDefinition<typeof decisionLedgerReadSchema, DecisionLedgerReadToolDetails | undefined> {
	return {
		name: DECISION_LEDGER_READ_TOOL_NAME,
		label: DECISION_LEDGER_READ_TOOL_NAME,
		readOnly: true,
		description:
			"Read the decision ledger: the stage transitions (understand, plan, build, dispatch, observe, verify, clarify, repair, deliver, done) with their times and loops, and the Jev evaluations with their verdicts and reasons, for this session or a recorded one. Use it to find where a run went wrong, what looped, and which judgments were made; 'replay' returns a past session's graph as recorded.",
		promptSnippet: "Read the decision ledger: stage transitions and Jev verdicts of this or a recorded session",
		parameters: decisionLedgerReadSchema,
		async execute(_toolCallId, { action, sessionId, limit }: DecisionLedgerReadToolInput) {
			let ledger: DecisionLedgerStore | undefined;
			try {
				ledger = options?.getLedger?.();
			} catch {
				ledger = undefined;
			}
			if (!ledger) {
				return {
					content: [{ type: "text", text: "The decision ledger is unavailable in this session." }],
					details: { action, rows: 0, available: false },
				};
			}
			const target = sessionId ?? options?.getSessionId?.() ?? "";
			const bounded = Math.max(1, Math.min(MAX_EVALUATIONS, Math.floor(limit ?? DEFAULT_EVALUATIONS)));
			const nowMs = Date.now();
			if (action === "sessions") {
				const cwd = options?.getCwd?.() ?? _cwd;
				const sessions = ledger.listSessions(cwd, MAX_SESSIONS);
				const text = sessions.length
					? sessions
							.map(
								(session) =>
									`${session.sessionId} first=${formatTime(session.firstAt)} last=${formatTime(session.lastAt)} stages=${session.stageEntries} evaluations=${session.evaluations}`,
							)
							.join("\n")
					: `no sessions recorded for ${cwd}`;
				return { content: [{ type: "text", text }], details: { action, rows: sessions.length, available: true } };
			}
			if (!target) {
				return {
					content: [{ type: "text", text: "No session id: pass sessionId or run inside a session." }],
					details: { action, rows: 0, available: true },
				};
			}
			const stages = action === "evaluations" ? [] : ledger.loadStages(target);
			const evaluations = action === "stages" ? [] : ledger.recentSemanticEvaluations(target, bounded).reverse();
			const sections: string[] = [];
			if (action !== "evaluations") sections.push(`stages (${stages.length})\n${formatStageRows(stages, nowMs)}`);
			if (action !== "stages")
				sections.push(`evaluations (${evaluations.length})\n${formatEvaluationRows(evaluations)}`);
			return {
				content: [{ type: "text", text: `session ${target}\n${sections.join("\n\n")}` }],
				details: { action, sessionId: target, rows: stages.length + evaluations.length, available: true },
			};
		},
		renderCall(args, theme, context) {
			return renderTextComponent(context.lastComponent, formatCall(args, theme));
		},
		renderResult(result, renderOptions, theme, context) {
			return renderBoundedTextResult(result, renderOptions.expanded, theme, context.lastComponent, 24);
		},
	};
}

export function createDecisionLedgerReadTool(
	cwd: string,
	options?: DecisionLedgerReadToolOptions,
): AgentTool<typeof decisionLedgerReadSchema> {
	return wrapToolDefinition(createDecisionLedgerReadToolDefinition(cwd, options));
}
