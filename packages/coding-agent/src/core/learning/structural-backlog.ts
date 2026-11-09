/**
 * Routes a recurring lesson either to a structural backlog row (an artifact could enforce it) or to memory/skills,
 * from code facts and atomic System One judgments.
 *
 * The three judgments are one System One question each. The exits that decide the route are ordered in code, so a
 * judge error or an unsettled probability is `open` (uncertainty), never a rejection. The backlog state lives in the
 * agent dir, so no session text enters the repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { stateFile } from "../agent-paths.ts";
import { isWorkerSession } from "../session-role.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isNonNegativeSafeInteger, isPlainRecord, isStringArray } from "../util/value-guards.ts";
import { proposalFromReflectionWrite } from "./learning-audit.ts";
import { observationKey } from "./observation-store.ts";
import { parseReflectionWrites, type ReflectionWrite } from "./reflection-engine.ts";

export const STRUCTURAL_BACKLOG_VERSION = 1;
export const MAX_BACKLOG_ROWS = 200;
const MAX_SUMMARY_CHARS = 240;
const MAX_EVIDENCE_IDS = 8;
/** Bounds the text one judgment sees: the summary and its evidence quotes, nothing else. */
const MAX_LESSON_CONTEXT_CHARS = 4_000;
/** Accept threshold for a judgment (`>=`). Reject is `<=` the reject threshold. Probabilities are never rounded. */
export const LESSON_ACCEPT_PROBABILITY = 0.9;
export const LESSON_REJECT_PROBABILITY = 0.1;

export type BacklogRoute = "backlog" | "memory" | "skill" | "open";
export type BacklogEnforcement = "artifact" | "unknown" | "none";

export interface BacklogRow {
	/** observationKey(layer, summary): the same key the reflection controller counts the lesson under. */
	key: string;
	layer: string;
	summary: string;
	observedCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	route: BacklogRoute;
	enforcement: BacklogEnforcement;
	evidenceIds: string[];
	/** Doctrine rule the lesson matches, when the caller supplied one. The route does not depend on it. */
	doctrineRuleId?: string;
}

export interface BacklogState {
	v: typeof STRUCTURAL_BACKLOG_VERSION;
	rows: BacklogRow[];
}

/** One memory or skill lesson: the layer and summary the observation store keys on, plus the evidence the judges read. */
export interface LessonCandidate {
	layer: string;
	summary: string;
	evidenceIds: readonly string[];
	quotes: readonly string[];
}

/** Code facts about a lesson, read by the caller. */
export interface LessonFacts {
	observedCount: number;
	skillLoadedThisSession: boolean;
	doctrineRuleId?: string;
}

export type LessonJudgment = { probability: number } | { error: string };

/** Asks one atomic yes/no question of System One (Noul) and returns its probability, or an error value. */
export interface LessonJudge {
	noul(question: string, context: string, signal?: AbortSignal): Promise<LessonJudgment>;
}

export const LESSON_QUESTIONS = {
	enforceable: "Could a check, type, lint rule or test-free script enforce this lesson mechanically?",
	repeated: "Does the evidence show the same mistake at least twice?",
	sufficient:
		"Is the supplied evidence sufficient to answer whether a check, type, lint rule or test-free script could enforce this lesson mechanically?",
} as const;

export interface LessonRoute {
	route: BacklogRoute;
	enforcement: BacklogEnforcement;
}

type Answer = { ok: true; probability: number } | { ok: false; error: string };

async function ask(judge: LessonJudge, question: string, context: string, signal?: AbortSignal): Promise<Answer> {
	const judgment = await judge.noul(question, context, signal);
	if ("error" in judgment) return { ok: false, error: judgment.error };
	const probability = judgment.probability;
	if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
		return { ok: false, error: "probability is outside [0, 1]" };
	}
	return { ok: true, probability };
}

function lessonContext(candidate: LessonCandidate): string {
	const quotes = candidate.quotes.length > 0 ? candidate.quotes.map((quote) => `- ${quote}`).join("\n") : "- (none)";
	return `Lesson: ${candidate.summary}\nEvidence quotes:\n${quotes}`.slice(0, MAX_LESSON_CONTEXT_CHARS);
}

/**
 * The ordered exits, in code:
 * - E0: sufficiency < accept, or any judge error: `open`.
 * - E1: enforceable >= accept and (repeated >= accept, or observedCount >= 2): `backlog`, enforcement `artifact`.
 *   The repeated question is asked only when the count alone does not settle it.
 * - E2: enforceable <= reject: `skill` when a skill was loaded this session, else `memory`; enforcement `none`.
 * - E3: otherwise `memory`, enforcement `unknown`.
 */
export async function decideLessonRoute(input: {
	candidate: LessonCandidate;
	facts: LessonFacts;
	judge: LessonJudge;
	signal?: AbortSignal;
}): Promise<LessonRoute> {
	const { candidate, facts, judge, signal } = input;
	const context = lessonContext(candidate);
	const open: LessonRoute = { route: "open", enforcement: "unknown" };
	const sufficient = await ask(judge, LESSON_QUESTIONS.sufficient, context, signal);
	if (!sufficient.ok || sufficient.probability < LESSON_ACCEPT_PROBABILITY) return open;
	const enforceable = await ask(judge, LESSON_QUESTIONS.enforceable, context, signal);
	if (!enforceable.ok) return open;
	if (enforceable.probability >= LESSON_ACCEPT_PROBABILITY) {
		if (facts.observedCount >= 2) return { route: "backlog", enforcement: "artifact" };
		const repeated = await ask(judge, LESSON_QUESTIONS.repeated, context, signal);
		if (!repeated.ok) return open;
		if (repeated.probability >= LESSON_ACCEPT_PROBABILITY) return { route: "backlog", enforcement: "artifact" };
		return { route: "memory", enforcement: "unknown" };
	}
	if (enforceable.probability <= LESSON_REJECT_PROBABILITY) {
		return { route: facts.skillLoadedThisSession ? "skill" : "memory", enforcement: "none" };
	}
	return { route: "memory", enforcement: "unknown" };
}

export function backlogFile(agentDir: string): string {
	return stateFile(agentDir, "learning", "structural-backlog.json");
}

const ROUTES: ReadonlySet<string> = new Set<string>(["backlog", "memory", "skill", "open"] satisfies BacklogRoute[]);
const ENFORCEMENTS: ReadonlySet<string> = new Set<string>([
	"artifact",
	"unknown",
	"none",
] satisfies BacklogEnforcement[]);

function isBacklogRow(value: unknown): value is BacklogRow {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.key === "string" &&
		typeof value.layer === "string" &&
		typeof value.summary === "string" &&
		[...value.summary].length <= MAX_SUMMARY_CHARS &&
		isNonNegativeSafeInteger(value.observedCount) &&
		typeof value.firstSeenAt === "string" &&
		typeof value.lastSeenAt === "string" &&
		typeof value.route === "string" &&
		ROUTES.has(value.route) &&
		typeof value.enforcement === "string" &&
		ENFORCEMENTS.has(value.enforcement) &&
		isStringArray(value.evidenceIds) &&
		value.evidenceIds.length <= MAX_EVIDENCE_IDS &&
		(value.doctrineRuleId === undefined || typeof value.doctrineRuleId === "string")
	);
}

function isBacklogState(value: unknown): value is BacklogState {
	return (
		isPlainRecord(value) &&
		value.v === STRUCTURAL_BACKLOG_VERSION &&
		Array.isArray(value.rows) &&
		value.rows.every(isBacklogRow)
	);
}

/** The backlog. A missing file is an empty backlog; unreadable state throws, so no row is silently reset. */
export function readBacklog(agentDir: string): BacklogState {
	const file = backlogFile(agentDir);
	if (!existsSync(file)) return { v: STRUCTURAL_BACKLOG_VERSION, rows: [] };
	const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
	if (!isBacklogState(parsed)) throw new Error("structural backlog state is unreadable");
	return parsed;
}

function recordRow(agentDir: string, row: BacklogRow): void {
	withFileLockSync(backlogFile(agentDir), () => {
		const state = readBacklog(agentDir);
		const previous = state.rows.find((existing) => existing.key === row.key);
		const merged: BacklogRow = previous
			? {
					...row,
					firstSeenAt: previous.firstSeenAt,
					evidenceIds: [...new Set([...previous.evidenceIds, ...row.evidenceIds])].slice(-MAX_EVIDENCE_IDS),
					doctrineRuleId: row.doctrineRuleId ?? previous.doctrineRuleId,
				}
			: row;
		const rows = [...state.rows.filter((existing) => existing.key !== row.key), merged];
		// Oldest lastSeenAt goes first. Timestamps are toISOString() output, which sorts as text.
		const pruned =
			rows.length > MAX_BACKLOG_ROWS
				? [...rows]
						.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : a.lastSeenAt > b.lastSeenAt ? 1 : 0))
						.slice(-MAX_BACKLOG_ROWS)
				: rows;
		writeFileAtomicSync(
			backlogFile(agentDir),
			`${JSON.stringify({ v: STRUCTURAL_BACKLOG_VERSION, rows: pruned }, null, "\t")}\n`,
		);
	});
}

export interface RouteLessonInput {
	agentDir: string;
	candidate: LessonCandidate;
	facts: LessonFacts;
	judge: LessonJudge;
	now: number;
	signal?: AbortSignal;
}

/**
 * Decides where one lesson goes and records the row. A worker session decides but writes nothing. The route is
 * recorded and never gates the memory or skill write: the caller applies that write under its existing gates, so a
 * route cannot drop a lesson.
 */
export async function routeLesson(input: RouteLessonInput): Promise<BacklogRow> {
	const { route, enforcement } = await decideLessonRoute(input);
	const at = new Date(input.now).toISOString();
	const row: BacklogRow = {
		key: observationKey(input.candidate.layer, input.candidate.summary),
		layer: input.candidate.layer,
		summary: [...input.candidate.summary].slice(0, MAX_SUMMARY_CHARS).join(""),
		observedCount: input.facts.observedCount,
		firstSeenAt: at,
		lastSeenAt: at,
		route,
		enforcement,
		evidenceIds: input.candidate.evidenceIds.slice(0, MAX_EVIDENCE_IDS),
		...(input.facts.doctrineRuleId !== undefined ? { doctrineRuleId: input.facts.doctrineRuleId } : {}),
	};
	if (!isWorkerSession()) recordRow(input.agentDir, row);
	return row;
}

function evidenceRefsOf(write: ReflectionWrite): readonly string[] {
	return write.kind === "okf_add" || write.kind === "okf_organize" ? write.evidenceRefs : [];
}

function quotesOf(write: ReflectionWrite): readonly string[] {
	switch (write.kind) {
		case "memory_add":
			return [write.text];
		case "memory_replace":
			return [write.target, write.text];
		case "memory_remove":
			return [write.target];
		case "okf_add":
		case "okf_organize":
			return [write.text];
		case "promote_skill":
			return [write.description, write.body];
	}
}

/**
 * The lesson a learner's memory or skill write carries, under the same layer and summary the reflection controller
 * counts it by (`proposalFromReflectionWrite`). Undefined when the shared parser rejects the entry (applyWrites
 * reports it) or when the kind needs the current memory to validate (`okf_organize`), which this path does not have.
 */
export function lessonCandidateOfWrite(raw: unknown): LessonCandidate | undefined {
	const [write] = parseReflectionWrites([raw], "");
	if (!write) return undefined;
	const proposal = proposalFromReflectionWrite(write, "lesson");
	return {
		layer: proposal.layer,
		summary: proposal.summary,
		evidenceIds: evidenceRefsOf(write),
		quotes: quotesOf(write),
	};
}

/** The lesson a learner's skill update carries. Skill updates are never observation-counted, so their facts count 0. */
export function lessonCandidateOfSkillUpdate(update: {
	name: string;
	description?: string;
	body: string;
}): LessonCandidate {
	return {
		layer: "skill",
		summary: update.description
			? `Update skill "${update.name}": ${update.description}`
			: `Update skill "${update.name}"`,
		evidenceIds: [],
		quotes: [update.body],
	};
}
