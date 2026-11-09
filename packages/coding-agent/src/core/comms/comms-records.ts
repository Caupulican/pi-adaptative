/**
 * Machine records the host sends a model, one canonical record per fact and a tagged line as its model view.
 *
 * A record is built by the code that owns the fact and carried in `details`; the tagged line in the message
 * content is a rendering of it. Nothing in the harness reads a rendering back: a model-facing line is for the
 * model, and a decision reads the record. The meaning of every code is stated once, in the root prompt
 * (`rootDirectorRolePrompt`), so a result carries the code and not the explanation.
 */

import type { CommsErrCode, CommsHintCode, CommsStateCode } from "../provider-prompt-contracts.ts";

/** Version of the machine records in `details` (`details.v`, `err.v`); a reader that meets a greater one rejects it. */
export const COMMS_RECORD_VERSION = 1 as const;

export type CommsRecordVersion = typeof COMMS_RECORD_VERSION;

/** Longest `m` a refusal carries; a typical refusal stays within one memory leaf (512 bytes). */
export const MAX_COMMS_ERR_MESSAGE_CHARS = 640;
const MAX_COMMS_ERR_FIELD_CHARS = 64;
const MAX_COMMS_ERR_CONTEXT_CHARS = 240;

/** A refused call: `{v:1,k:"err",c,f,m,h,x}`. Nothing ran and nothing was queued. */
export interface CommsErrRecord {
	readonly v: CommsRecordVersion;
	readonly k: "err";
	/** Error class. */
	readonly c: CommsErrCode;
	/** The input field the refusal concerns. */
	readonly f?: string;
	/** The reason, one short sentence. */
	readonly m: string;
	/** What the sender does next. */
	readonly h?: CommsHintCode;
	/** The value the hint needs (for example the field a value moves to). */
	readonly x?: string;
}

/** The result envelope every `delegate` result carries in `details` beside its action-specific fields. */
export interface CommsResultEnvelope {
	readonly v?: CommsRecordVersion;
	/** Host state codes that apply to this result. */
	readonly h?: readonly CommsStateCode[];
	readonly err?: CommsErrRecord;
}

function oneLine(value: string, maxChars: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

export function commsErr(input: {
	c: CommsErrCode;
	m: string;
	f?: string;
	h?: CommsHintCode;
	x?: string;
}): CommsErrRecord {
	return {
		v: COMMS_RECORD_VERSION,
		k: "err",
		c: input.c,
		...(input.f ? { f: oneLine(input.f, MAX_COMMS_ERR_FIELD_CHARS) } : {}),
		m: oneLine(input.m, MAX_COMMS_ERR_MESSAGE_CHARS),
		...(input.h ? { h: input.h } : {}),
		...(input.x ? { x: oneLine(input.x, MAX_COMMS_ERR_CONTEXT_CHARS) } : {}),
	};
}

/** The tagged model view of a refusal: one header line of `key=value` tags, then the reason. */
export function renderCommsErrView(err: CommsErrRecord): string {
	const tags = [`c=${err.c}`, ...(err.f ? [`f=${err.f}`] : []), ...(err.h ? [`h=${err.h}`] : [])];
	return [`err ${tags.join(" ")}${err.x ? ` x=${err.x}` : ""}`, `m ${err.m}`].join("\n");
}

/** The tagged model view of host state codes, or nothing when no code applies. */
export function renderCommsStateLine(codes: readonly CommsStateCode[]): string | undefined {
	return codes.length > 0 ? `h ${[...new Set(codes)].join(",")}` : undefined;
}

/** Evidence a task asks the worker to bring back, with the phrase the worker's task view uses for it. */
export const TASK_EVIDENCE_KINDS = {
	cite: "cite file:line",
	cmd: "command output",
	diff: "diff",
	none: "none",
} as const;

export type TaskEvidenceKind = keyof typeof TASK_EVIDENCE_KINDS;

/** The shape of the answer a task asks for, with the phrase the worker's task view uses for it. */
export const TASK_OUTPUT_KINDS = {
	find: "findings",
	edit: "edit",
	ans: "answer",
	rev: "verdict",
} as const;

export type TaskOutputKind = keyof typeof TASK_OUTPUT_KINDS;

/** Budgets of the structured task fields; they are also the memory-leaf budgets of a typical start call. */
export const MAX_TASK_GOAL_CHARS = 400;
export const MAX_TASK_NOTE_CHARS = 1_500;
export const MAX_TASK_REFS = 16;
export const MAX_TASK_REF_CHARS = 256;
/** Budgets of the brief's acceptance fields: one "done when" line and a short out-of-scope list. */
export const MAX_TASK_DONE_CHARS = 400;
export const MAX_TASK_OUT_OF_SCOPE = 8;
export const MAX_TASK_OUT_OF_SCOPE_CHARS = 256;

/**
 * Version of a stored brief, and the selector of the renderer that turned it into the worker's task text. A renderer
 * is frozen once a record carries its version, so a later layout never changes how an older record reads or
 * verifies. Version 1 is the first layout (not injective: a goal with a line break could pass for a note); version 3
 * adds the acceptance lines. A new brief is written at the lowest version that holds its fields
 * ({@link taskBriefVersionFor}), so a brief without acceptance lines stays readable by a build that knows only version 2.
 */
export type TaskBriefVersion = 1 | 2 | 3;

/** The version a new brief is written at: 3 when it states acceptance lines, 2 otherwise. */
export function taskBriefVersionFor(fields: {
	readonly done?: string;
	readonly outOfScope?: readonly string[];
}): 2 | 3 {
	return fields.done !== undefined || (fields.outOfScope?.length ?? 0) > 0 ? 3 : 2;
}

/**
 * A task as the root stated it, in fields. The worker's `TASK` text is rendered from this record at admission and
 * stored as the dispatch `instructions`; the record is stored beside it, and the dispatch decoder rejects a pair
 * whose renderer does not reproduce the text. A dispatch without a brief is a free-text task and stays legacy.
 */
export interface TaskBrief {
	readonly v: TaskBriefVersion;
	/** The task statement, one line. */
	readonly goal: string;
	/** Constraints and a stop condition that no id expresses; may span lines. */
	readonly note?: string;
	readonly evid?: TaskEvidenceKind;
	readonly out?: TaskOutputKind;
	/** Paths and ids to read, one line each; references, never pasted content. */
	readonly refs?: readonly string[];
	/** What makes the task done, one line (version 3). The proof sheet of the result repeats it. */
	readonly done?: string;
	/** What the task must not touch or decide, one line each (version 3). The proof sheet of the result repeats it. */
	readonly outOfScope?: readonly string[];
}

/** The one `Evidence:`/`Output:` line both layouts share, or none when the brief states neither. */
function taskBriefExpectationLines(brief: TaskBrief): string[] {
	const parts = [
		brief.evid ? `Evidence: ${TASK_EVIDENCE_KINDS[brief.evid]}.` : undefined,
		brief.out ? `Output: ${TASK_OUTPUT_KINDS[brief.out]}.` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? [parts.join(" ")] : [];
}

/** Layout of version 1: kept exactly as first written, so records stored with it still verify. */
function renderTaskBriefV1(brief: TaskBrief): string {
	return [
		brief.goal,
		...(brief.note ? [`Note: ${brief.note}`] : []),
		...(brief.refs && brief.refs.length > 0 ? [`Refs: ${brief.refs.join(", ")}`] : []),
		...taskBriefExpectationLines(brief),
	].join("\n");
}

/**
 * Layout of version 2, injective for records that pass {@link taskBriefProblem}: the goal is the single first line, each
 * ref is its own `Ref:` line, one `Evidence:`/`Output:` line follows, and the note comes last behind its label, so no
 * field can imitate the start of another.
 */
function renderTaskBriefV2(brief: TaskBrief): string {
	return [
		brief.goal,
		...(brief.refs ?? []).map((ref) => `Ref: ${ref}`),
		...taskBriefExpectationLines(brief),
		...(brief.note ? [`Note: ${brief.note}`] : []),
	].join("\n");
}

/**
 * Layout of version 3: version 2 with the acceptance lines after the refs, one `Done when:` line and one `Out of scope:`
 * line per item. Every line still opens with its own label in a fixed order and the note stays last, so the layout stays
 * injective; a version 3 brief without the new fields renders exactly as version 2.
 */
function renderTaskBriefV3(brief: TaskBrief): string {
	return [
		brief.goal,
		...(brief.refs ?? []).map((ref) => `Ref: ${ref}`),
		...(brief.done ? [`Done when: ${brief.done}`] : []),
		...(brief.outOfScope ?? []).map((item) => `Out of scope: ${item}`),
		...taskBriefExpectationLines(brief),
		...(brief.note ? [`Note: ${brief.note}`] : []),
	].join("\n");
}

const TASK_BRIEF_RENDERERS: Readonly<Record<TaskBriefVersion, (brief: TaskBrief) => string>> = {
	1: renderTaskBriefV1,
	2: renderTaskBriefV2,
	3: renderTaskBriefV3,
};

/** The worker's task text for a brief: a pure function of the record, selected by its version. */
export function renderTaskBrief(brief: TaskBrief): string {
	return TASK_BRIEF_RENDERERS[brief.v](brief);
}

/** Why a brief cannot be stored: the field, and whether a bound or the shape is at fault. */
export interface TaskBriefProblem {
	readonly field: "goal" | "note" | "refs" | "done" | "outOfScope";
	readonly kind: "limit" | "invalid";
}

function isOneCanonicalLine(value: string): boolean {
	return value.length > 0 && value === value.trim() && !/\p{Cc}/u.test(value);
}

/**
 * The shape a version 2 or 3 brief must have for its rendering to be unambiguous: a canonical one-line goal, canonical
 * one-line refs, a trimmed note, and (version 3 only, since the version 2 renderer drops them) a canonical done line and
 * out-of-scope items, each inside its budget. Version 1 records are read as they were written.
 */
export function taskBriefProblem(brief: TaskBrief): TaskBriefProblem | undefined {
	if (brief.goal.length > MAX_TASK_GOAL_CHARS) return { field: "goal", kind: "limit" };
	if (brief.note !== undefined && brief.note.length > MAX_TASK_NOTE_CHARS) return { field: "note", kind: "limit" };
	if ((brief.refs ?? []).some((ref) => ref.length > MAX_TASK_REF_CHARS)) return { field: "refs", kind: "limit" };
	if ((brief.refs?.length ?? 0) > MAX_TASK_REFS) return { field: "refs", kind: "limit" };
	if (!isOneCanonicalLine(brief.goal)) return { field: "goal", kind: "invalid" };
	if (brief.note !== undefined && (brief.note.length === 0 || brief.note !== brief.note.trim())) {
		return { field: "note", kind: "invalid" };
	}
	if ((brief.refs ?? []).some((ref) => !isOneCanonicalLine(ref))) return { field: "refs", kind: "invalid" };
	if (brief.done !== undefined) {
		if (brief.v < 3) return { field: "done", kind: "invalid" };
		if (brief.done.length > MAX_TASK_DONE_CHARS) return { field: "done", kind: "limit" };
		if (!isOneCanonicalLine(brief.done)) return { field: "done", kind: "invalid" };
	}
	if (brief.outOfScope !== undefined) {
		if (brief.v < 3) return { field: "outOfScope", kind: "invalid" };
		if (brief.outOfScope.length > MAX_TASK_OUT_OF_SCOPE) return { field: "outOfScope", kind: "limit" };
		if (brief.outOfScope.some((item) => item.length > MAX_TASK_OUT_OF_SCOPE_CHARS))
			return { field: "outOfScope", kind: "limit" };
		if (brief.outOfScope.length === 0 || brief.outOfScope.some((item) => !isOneCanonicalLine(item)))
			return { field: "outOfScope", kind: "invalid" };
	}
	return undefined;
}

/** Whether two briefs state the same task field for field; two absent briefs are the same (both free text). */
export function sameTaskBrief(left: TaskBrief | undefined, right: TaskBrief | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.v === right.v &&
		left.goal === right.goal &&
		left.note === right.note &&
		left.evid === right.evid &&
		left.out === right.out &&
		left.done === right.done &&
		sameList(left.refs, right.refs) &&
		sameList(left.outOfScope, right.outOfScope)
	);
}

function sameList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	return (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((item, index) => item === right?.[index]);
}

/** Reads a stored brief back, rejecting anything outside the record's shape and budgets. */
export function parseTaskBrief(value: unknown): TaskBrief {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("brief must be an object.");
	const record = value as Record<string, unknown>;
	const unknownField = Object.keys(record).find(
		(key) => !["v", "goal", "note", "evid", "out", "refs", "done", "outOfScope"].includes(key),
	);
	if (unknownField) throw new Error(`brief.${unknownField} is unsupported.`);
	const { v, goal, note, evid, out, refs, done, outOfScope } = record;
	if (v !== 1 && v !== 2 && v !== 3) throw new Error("brief.v is unsupported.");
	if (typeof goal !== "string" || !goal.trim()) throw new Error("brief.goal must be a non-empty string.");
	if (note !== undefined && (typeof note !== "string" || !note.trim())) {
		throw new Error("brief.note must be a non-empty string.");
	}
	if (evid !== undefined && (typeof evid !== "string" || !Object.hasOwn(TASK_EVIDENCE_KINDS, evid))) {
		throw new Error("brief.evid is invalid.");
	}
	if (out !== undefined && (typeof out !== "string" || !Object.hasOwn(TASK_OUTPUT_KINDS, out))) {
		throw new Error("brief.out is invalid.");
	}
	if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !ref.trim()))) {
		throw new Error("brief.refs must be a list of non-empty strings.");
	}
	if (done !== undefined && typeof done !== "string") throw new Error("brief.done must be a string.");
	if (
		outOfScope !== undefined &&
		(!Array.isArray(outOfScope) || outOfScope.some((item) => typeof item !== "string"))
	) {
		throw new Error("brief.outOfScope must be a list of strings.");
	}
	const brief: TaskBrief = {
		v,
		goal,
		...(note !== undefined ? { note: note as string } : {}),
		...(evid !== undefined ? { evid: evid as TaskEvidenceKind } : {}),
		...(out !== undefined ? { out: out as TaskOutputKind } : {}),
		...(refs !== undefined ? { refs: [...(refs as string[])] } : {}),
		...(done !== undefined ? { done: done as string } : {}),
		...(outOfScope !== undefined ? { outOfScope: [...(outOfScope as string[])] } : {}),
	};
	// Version 1 was stored with its own bounds only; later versions must also be canonical so their text is unambiguous.
	const problem: TaskBriefProblem | undefined =
		v !== 1
			? taskBriefProblem(brief)
			: done !== undefined || outOfScope !== undefined
				? { field: done !== undefined ? "done" : "outOfScope", kind: "invalid" }
				: undefined;
	if (problem)
		throw new Error(`brief.${problem.field} is ${problem.kind === "limit" ? "over its budget" : "not canonical"}.`);
	return brief;
}
