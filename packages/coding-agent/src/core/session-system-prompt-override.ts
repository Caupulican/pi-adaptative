import type { SessionManager } from "../kernel/node.ts";
import {
	appendSessionSnapshot,
	getLatestSessionSnapshotOnBranch,
	type SessionSnapshotCodec,
} from "./session-snapshot.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/**
 * Owner-authored replacement of the session's whole system prompt, scoped to the session branch.
 *
 * The record is a snapshot on the active branch: resuming the session restores it, navigating to a
 * branch that predates it drops it, and no other session sees it. A cleared override is recorded as
 * `text: null` so an older entry on the same branch can never resurface.
 */
export const SESSION_SYSTEM_PROMPT_CUSTOM_TYPE = "session_system_prompt";

/** Bounds the session file growth one edit can cause; model capability budgets apply on top. */
export const MAX_SESSION_SYSTEM_PROMPT_CHARS = 262_144;

export interface SessionSystemPromptOverride {
	/** The replacement prompt, or `null` when the owner reset the session to the generated prompt. */
	text: string | null;
	updatedAt: string;
}

function isSessionSystemPromptOverride(value: unknown): value is SessionSystemPromptOverride {
	if (!isPlainRecord(value)) return false;
	if (typeof value.updatedAt !== "string") return false;
	if (value.text === null) return true;
	return (
		typeof value.text === "string" &&
		value.text.trim().length > 0 &&
		value.text.length <= MAX_SESSION_SYSTEM_PROMPT_CHARS
	);
}

const SESSION_SYSTEM_PROMPT_CODEC: SessionSnapshotCodec<SessionSystemPromptOverride, "override"> = {
	customType: SESSION_SYSTEM_PROMPT_CUSTOM_TYPE,
	valueKey: "override",
	isValue: isSessionSystemPromptOverride,
	clone: (value) => ({ text: value.text, updatedAt: value.updatedAt }),
};

/** The active branch's override text, or undefined when the generated prompt is in force. */
export function readSessionSystemPromptOverride(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): string | undefined {
	return getLatestSessionSnapshotOnBranch(sessionManager, SESSION_SYSTEM_PROMPT_CODEC)?.text ?? undefined;
}

/** Records the override (or its reset when `text` is undefined) on the active branch. */
export function appendSessionSystemPromptOverride(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	text: string | undefined,
): void {
	if (text !== undefined) {
		if (text.trim().length === 0) throw new Error("A session system prompt cannot be empty; use a reset instead.");
		if (text.length > MAX_SESSION_SYSTEM_PROMPT_CHARS) {
			throw new Error(
				`Session system prompt is ${text.length} characters; the limit is ${MAX_SESSION_SYSTEM_PROMPT_CHARS}.`,
			);
		}
	}
	appendSessionSnapshot(sessionManager, SESSION_SYSTEM_PROMPT_CODEC, {
		text: text ?? null,
		updatedAt: new Date().toISOString(),
	});
}
