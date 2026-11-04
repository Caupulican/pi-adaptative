/**
 * Machine records the host sends a model, one canonical record per fact and a tagged line as its model view.
 *
 * A record is built by the code that owns the fact and carried in `details`; the tagged line in the message
 * content is a rendering of it. Nothing in the harness reads a rendering back: a model-facing line is for the
 * model, and a decision reads the record. The meaning of every code is stated once, in the root prompt
 * (`COMMS_GLOSSARY_PROMPT`), so a result carries the code and not the explanation.
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

/** Version of the renderer that turns a brief into the worker's task text; the stored text never changes with it. */
export const TASK_BRIEF_RENDER_VERSION = 1 as const;

/**
 * A task as the root stated it, in fields. The worker's `TASK` text is rendered from this record at admission and
 * stored as the dispatch `instructions`; the record is stored beside it. A dispatch without a brief is a free-text
 * task and stays legacy.
 */
export interface TaskBrief {
	readonly v: CommsRecordVersion;
	/** The task statement, one sentence. */
	readonly goal: string;
	/** Constraints and a stop condition that no id expresses. */
	readonly note?: string;
	readonly evid?: TaskEvidenceKind;
	readonly out?: TaskOutputKind;
	/** Paths and ids to read; references, never pasted content. */
	readonly refs?: readonly string[];
}

/**
 * The worker's task text for a brief: a pure function of the record. The goal opens the text (it is the task's
 * label); the other fields follow as plain words a worker needs no glossary to read.
 */
export function renderTaskBrief(brief: TaskBrief): string {
	return [
		brief.goal,
		...(brief.note ? [`Note: ${brief.note}`] : []),
		...(brief.refs && brief.refs.length > 0 ? [`Refs: ${brief.refs.join(", ")}`] : []),
		...(brief.evid || brief.out
			? [
					[
						brief.evid ? `Evidence: ${TASK_EVIDENCE_KINDS[brief.evid]}.` : undefined,
						brief.out ? `Output: ${TASK_OUTPUT_KINDS[brief.out]}.` : undefined,
					]
						.filter((part): part is string => part !== undefined)
						.join(" "),
				]
			: []),
	].join("\n");
}

/** Reads a stored brief back, rejecting anything outside the record's shape and budgets. */
export function parseTaskBrief(value: unknown): TaskBrief {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("brief must be an object.");
	const record = value as Record<string, unknown>;
	const unknownField = Object.keys(record).find((key) => !["v", "goal", "note", "evid", "out", "refs"].includes(key));
	if (unknownField) throw new Error(`brief.${unknownField} is unsupported.`);
	if (record.v !== COMMS_RECORD_VERSION) throw new Error("brief.v is unsupported.");
	const { goal, note, evid, out, refs } = record;
	if (typeof goal !== "string" || !goal.trim() || goal.length > MAX_TASK_GOAL_CHARS) {
		throw new Error("brief.goal must be a non-empty string within its budget.");
	}
	if (note !== undefined && (typeof note !== "string" || !note.trim() || note.length > MAX_TASK_NOTE_CHARS)) {
		throw new Error("brief.note must be a non-empty string within its budget.");
	}
	if (evid !== undefined && (typeof evid !== "string" || !Object.hasOwn(TASK_EVIDENCE_KINDS, evid))) {
		throw new Error("brief.evid is invalid.");
	}
	if (out !== undefined && (typeof out !== "string" || !Object.hasOwn(TASK_OUTPUT_KINDS, out))) {
		throw new Error("brief.out is invalid.");
	}
	if (
		refs !== undefined &&
		(!Array.isArray(refs) ||
			refs.length > MAX_TASK_REFS ||
			refs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > MAX_TASK_REF_CHARS))
	) {
		throw new Error("brief.refs must be a bounded list of non-empty strings.");
	}
	return {
		v: COMMS_RECORD_VERSION,
		goal,
		...(note !== undefined ? { note: note as string } : {}),
		...(evid !== undefined ? { evid: evid as TaskEvidenceKind } : {}),
		...(out !== undefined ? { out: out as TaskOutputKind } : {}),
		...(refs !== undefined ? { refs: [...(refs as string[])] } : {}),
	};
}
