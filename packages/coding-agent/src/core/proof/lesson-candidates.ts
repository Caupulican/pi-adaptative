/**
 * Lesson candidates: the owner's rejections and corrections of finished work, kept as candidate lessons for a later
 * standards step to read. Private, bounded and machine-managed under `<agentDir>/state/lesson-candidates.jsonl`.
 *
 * A candidate records what happened in host terms (which signal, which goal, the owner's own words when the signal
 * carries any), never a model's reading of it. Nothing consumes the store yet: it is a hook with a reader, so the
 * evidence starts accumulating before any rule is derived from it. A failed write is reported to the caller and never
 * holds the owner's action that produced it.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { lessonCandidatesFile } from "../agent-paths.ts";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

/** Candidates kept; the oldest are dropped past the bound. */
export const LESSON_CANDIDATE_LIMIT = 200;
const MAX_TEXT_CHARS = 1_000;

/**
 * The owner signal a candidate came from: a completion the owner sent back to work, a completed goal the owner rewrote,
 * a requirement the work had marked blocked that the owner reopened.
 */
export type LessonCandidateSignal = "completion-continued" | "completed-goal-edited" | "blocked-requirement-reopened";

export interface OwnerLessonCandidate {
	readonly at: string;
	readonly signal: LessonCandidateSignal;
	readonly sessionId: string;
	readonly goalId: string;
	/** The goal as it stood when the owner sent it back. */
	readonly goal: string;
	/** The owner's own words with the signal (the edited goal, a typed answer); absent when the signal carries none. */
	readonly ownerWords?: string;
	/** What the host held as unproven at that moment (the reasons it gave, the proof sheet's gap line). */
	readonly hostGaps?: readonly string[];
}

const SIGNALS: ReadonlySet<string> = new Set<LessonCandidateSignal>([
	"completion-continued",
	"completed-goal-edited",
	"blocked-requirement-reopened",
]);

function bounded(text: string): string {
	const clean = redactTokenShapes(redactKnownSecrets(text.trim()));
	return clean.length <= MAX_TEXT_CHARS ? clean : `${clean.slice(0, MAX_TEXT_CHARS - 3)}...`;
}

function isCandidate(value: unknown): value is OwnerLessonCandidate {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.at === "string" &&
		typeof entry.signal === "string" &&
		SIGNALS.has(entry.signal) &&
		typeof entry.sessionId === "string" &&
		typeof entry.goalId === "string" &&
		typeof entry.goal === "string" &&
		(entry.ownerWords === undefined || typeof entry.ownerWords === "string") &&
		(entry.hostGaps === undefined ||
			(Array.isArray(entry.hostGaps) && entry.hostGaps.every((gap) => typeof gap === "string")))
	);
}

/** The reader interface a standards step uses; it never writes. */
export interface LessonCandidateReader {
	/** Every kept candidate, oldest first. */
	list(): OwnerLessonCandidate[];
}

/** The bounded candidate store of one agent directory. */
export class LessonCandidateStore implements LessonCandidateReader {
	private readonly file: string;

	constructor(agentDir: string) {
		this.file = lessonCandidatesFile(agentDir);
	}

	list(): OwnerLessonCandidate[] {
		if (!existsSync(this.file)) return [];
		const entries: OwnerLessonCandidate[] = [];
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isCandidate(parsed)) entries.push(parsed);
			} catch {
				// A torn or foreign line is not a candidate.
			}
		}
		return entries;
	}

	/** Appends one candidate (redacted and bounded) and keeps the last {@link LESSON_CANDIDATE_LIMIT}. Throws on a failed write. */
	append(input: Omit<OwnerLessonCandidate, "at"> & { readonly at?: string }): void {
		const ownerWords = input.ownerWords ? bounded(input.ownerWords) : "";
		const hostGaps = (input.hostGaps ?? [])
			.map(bounded)
			.filter((gap) => gap.length > 0)
			.slice(0, 8);
		const entry: OwnerLessonCandidate = {
			at: input.at ?? new Date().toISOString(),
			signal: input.signal,
			sessionId: input.sessionId,
			goalId: input.goalId,
			goal: bounded(input.goal),
			...(ownerWords ? { ownerWords } : {}),
			...(hostGaps.length > 0 ? { hostGaps } : {}),
		};
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		// Read-modify-write under the file's lock, so two sessions appending at once keep both candidates.
		withFileLockSync(
			this.file,
			() => {
				const kept = [...this.list(), entry].slice(-LESSON_CANDIDATE_LIMIT);
				writeFileAtomicSync(this.file, `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`);
			},
			{ retries: 5 },
		);
	}
}

/**
 * Appends one candidate for an owner action, reporting a failed write through `warn` instead of throwing: the owner's
 * action that produced the candidate always proceeds.
 */
export function recordLessonCandidate(
	agentDir: string,
	input: Omit<OwnerLessonCandidate, "at">,
	warn: (message: string) => void,
): void {
	try {
		new LessonCandidateStore(agentDir).append(input);
	} catch (error) {
		warn(`A candidate lesson could not be saved: ${error instanceof Error ? error.message : String(error)}`);
	}
}
