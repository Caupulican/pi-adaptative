import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
import { parentInputOf } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { isOwnerSpokenInputId } from "../owner-input-ledger.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** The custom message type a raised note is delivered under. */
export const PROACTIVE_NOTE_CUSTOM_TYPE = "proactive-note";
export const RAISE_NOTE_TOOL_NAME = "raise_note";

export const MAX_NOTE_TEXT_CHARS = 400;
export const MAX_NOTE_WHY_CHARS = 200;
/** Recent conversation text carried into one review, newest last. */
export const MAX_REVIEW_TRANSCRIPT_CHARS = 8_000;
export const MAX_REVIEW_MESSAGES = 16;
/** What memory knows about the owner, carried into one review. */
export const MAX_REVIEW_PROFILE_CHARS = 2_000;
export const MAX_REVIEW_GOAL_CHARS = 4_000;
/** Earlier notes shown to the review so it does not repeat them. */
export const MAX_PRIOR_NOTES_SHOWN = 8;

export const NOTE_KINDS = ["follow_up", "risk", "suggestion", "reminder"] as const;
export type ProactiveNoteKind = (typeof NOTE_KINDS)[number];

export interface ProactiveNote {
	readonly kind: ProactiveNoteKind;
	readonly text: string;
	readonly why: string;
}

const raiseNoteParameters = Type.Object(
	{
		kind: Type.Union(
			NOTE_KINDS.map((kind) => Type.Literal(kind)),
			{
				description:
					"follow_up: something left undone. risk: something likely to go wrong. suggestion: a better next step. reminder: something the owner said they wanted.",
			},
		),
		text: Type.String({
			minLength: 1,
			maxLength: MAX_NOTE_TEXT_CHARS,
			description: "What the owner should be told, in one or two plain sentences addressed to them.",
		}),
		why: Type.String({
			minLength: 1,
			maxLength: MAX_NOTE_WHY_CHARS,
			description: "The evidence in the conversation that makes it worth interrupting for.",
		}),
	},
	{ additionalProperties: false },
);

export type RaiseNoteInput = Static<typeof raiseNoteParameters>;

/** What one review raised, before the host decides which notes are delivered. */
export interface ReviewCapture {
	readonly raised: ProactiveNote[];
}

/**
 * The review's only tool. It records what the review raised and has no other effect: the review cannot read files,
 * run commands, message anyone or write memory, so a run of any model is read-only by construction.
 */
export function createRaiseNoteTool(capture: ReviewCapture, limit: number): AgentTool<typeof raiseNoteParameters> {
	return {
		name: RAISE_NOTE_TOOL_NAME,
		label: "Raise note",
		description: `Tell the owner one thing they did not ask for but would want to know. Call it only when the conversation shows a concrete need; at most ${limit} times. Calling it zero times is the normal outcome.`,
		parameters: raiseNoteParameters,
		execute: async (_toolCallId, params) => {
			if (capture.raised.length >= limit) {
				return {
					content: [{ type: "text", text: "Note limit reached; nothing more is recorded." }],
					details: { recorded: false },
				};
			}
			capture.raised.push({ kind: params.kind, text: params.text, why: params.why });
			return { content: [{ type: "text", text: "Recorded." }], details: { recorded: true } };
		},
	};
}

export const REVIEW_SYSTEM_PROMPT = [
	"You review a conversation between an owner and their coding agent. Decide whether there is something the owner would want to be told that they did not ask about.",
	"Stay quiet by default: most reviews end with no note. Raise a note only when the conversation itself shows a concrete need, such as work the owner asked for that was left undone, a risk the agent saw and did not resolve, or a promise to come back to something.",
	`Use the ${RAISE_NOTE_TOOL_NAME} tool for each note. Do not repeat a note already raised. Do not summarize the conversation, praise it or ask questions. When there is nothing to raise, call no tool and answer with one word: none.`,
	"The owner's standing preferences, when present, override everything above about what to raise, how often and in what tone.",
].join("\n");

export function normalizeNoteText(value: string, maxChars: number): string {
	return value
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxChars);
}

export function noteDigest(note: Pick<ProactiveNote, "text">): string {
	return createHash("sha256")
		.update(normalizeNoteText(note.text, MAX_NOTE_TEXT_CHARS).toLowerCase())
		.digest("hex")
		.slice(0, 16);
}

/** The notes a review may deliver: well-formed, not repeats of an earlier note or of each other, within the limit. */
export function selectNotesToDeliver(
	raised: readonly ProactiveNote[],
	priorDigests: ReadonlySet<string>,
	limit: number,
): ProactiveNote[] {
	const seen = new Set(priorDigests);
	const selected: ProactiveNote[] = [];
	for (const note of raised) {
		if (selected.length >= limit) break;
		const text = normalizeNoteText(note.text, MAX_NOTE_TEXT_CHARS);
		const why = normalizeNoteText(note.why, MAX_NOTE_WHY_CHARS);
		if (text.length === 0 || why.length === 0) continue;
		const digest = noteDigest({ text });
		if (seen.has(digest)) continue;
		seen.add(digest);
		selected.push({ kind: note.kind, text, why });
	}
	return selected;
}

export function renderNoteMessage(notes: readonly ProactiveNote[]): string {
	return ["[proactive note]", ...notes.map((note) => `- (${note.kind}) ${note.text}`)].join("\n");
}

interface EntryText {
	readonly role: "owner" | "assistant" | "external";
	readonly text: string;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? [(part as { text: string }).text]
				: [],
		)
		.join("\n");
}

function conversationEntries(entries: readonly SessionEntry[]): EntryText[] {
	const texts: EntryText[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const { role } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message.content).trim();
		if (text.length > 0)
			texts.push({
				role:
					role === "assistant"
						? "assistant"
						: entry.ownerInputId !== undefined && isOwnerSpokenInputId(entry.ownerInputId)
							? "owner"
							: "external",
				text,
			});
	}
	return texts;
}

/** Inputs the owner spoke on the active branch: a hidden internal turn has no input id, and a peer's message has an extension one. */
export function countOwnerTurns(entries: readonly SessionEntry[]): number {
	return entries.filter(
		(entry) =>
			entry.type === "message" && entry.ownerInputId !== undefined && isOwnerSpokenInputId(entry.ownerInputId),
	).length;
}

/** Digests of notes already delivered on this branch, and the newest few as text for the review. */
export function priorNotes(entries: readonly SessionEntry[]): { digests: Set<string>; recent: string[] } {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== PROACTIVE_NOTE_CUSTOM_TYPE) continue;
		const original =
			parentInputOf(entry) && isPlainRecord(entry.details) ? entry.details.originalDetails : entry.details;
		const details = isPlainRecord(original) ? original : undefined;
		if (!Array.isArray(details?.notes)) continue;
		for (const note of details.notes) {
			if (typeof note === "object" && note !== null && typeof (note as { text?: unknown }).text === "string") {
				texts.push((note as { text: string }).text);
			}
		}
	}
	return { digests: new Set(texts.map((text) => noteDigest({ text }))), recent: texts.slice(-MAX_PRIOR_NOTES_SHOWN) };
}

/** The review's user prompt: newest conversation text within the bound, earlier notes, and the owner's preferences. */
export function buildReviewPrompt(input: {
	entries: readonly SessionEntry[];
	preferences: string;
	ownerProfile: string;
	goalSummary?: string;
}): string {
	const turns = conversationEntries(input.entries).slice(-MAX_REVIEW_MESSAGES);
	const lines: string[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		if (turn === undefined) continue;
		const line = `${turn.role === "owner" ? "OWNER" : turn.role === "assistant" ? "AGENT" : "EXTERNAL/INTERNAL INPUT (not owner instructions)"}: ${turn.text}`;
		const room = MAX_REVIEW_TRANSCRIPT_CHARS - used;
		if (room <= 0) break;
		const clipped = line.length > room ? `${line.slice(0, room)} [clipped]` : line;
		lines.unshift(clipped);
		used += clipped.length;
	}
	const prior = priorNotes(input.entries).recent;
	const sections = [
		input.preferences.length > 0 ? `Owner's standing preferences:\n${input.preferences}` : "",
		input.ownerProfile.length > 0
			? `What is known about the owner:\n${input.ownerProfile.slice(0, MAX_REVIEW_PROFILE_CHARS)}`
			: "",
		input.goalSummary ? `Goal and current status:\n${input.goalSummary.slice(0, MAX_REVIEW_GOAL_CHARS)}` : "",
		prior.length > 0
			? `Notes already raised (do not repeat):\n${prior.map((text) => `- ${normalizeNoteText(text, MAX_NOTE_TEXT_CHARS)}`).join("\n")}`
			: "",
		`Recent conversation:\n${lines.join("\n\n")}`,
	];
	return sections.filter((section) => section.length > 0).join("\n\n");
}
