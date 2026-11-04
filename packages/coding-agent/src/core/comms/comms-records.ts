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
