/**
 * The record a session's bundle keeps of an unfinished cleanup of it that the owner's open of the session cancelled over
 * what is left of the bundle (`session-bundle-lifecycle.ts`, admission mode `open`). Such a cleanup may
 * already have removed some or all of the session's worker and plan state, so the owner is told once per cancellation:
 * the record is written under the tombstone's lock before the tombstone goes (`session-bundle-lifecycle.ts`), each
 * cancellation names itself by a new id, and the open tells it as a harness notice whose reason carries that id
 * (`session-open-lease.ts`), so a session opened again finds the notice already saved. The record is
 * `<bundle>/cleanup-released.json` and goes, and moves, with the bundle.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../storage/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../storage/bounded-file.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import { type OrchestrationHome, orchestrationSessionDir } from "./session-bundle-paths.ts";

/** What cancelled the cleanup: the session's open. */
export type SessionCleanupCanceller = "open";

export interface SessionCleanupRelease {
	/** The cancellation's own id, new at each one. */
	readonly releaseId: string;
	readonly by: SessionCleanupCanceller;
}

const MAX_RECORD_BYTES = 1024;
const RELEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordFile(home: OrchestrationHome, parentSessionId: string): string {
	return join(orchestrationSessionDir(home, parentSessionId), "cleanup-released.json");
}

/** Records a cancellation of the session's cleanup; called under the session's tombstone lock, before it goes. */
export function recordSessionCleanupRelease(
	home: OrchestrationHome,
	parentSessionId: string,
	by: SessionCleanupCanceller,
): void {
	mkdirSync(orchestrationSessionDir(home, parentSessionId), { recursive: true });
	const release: SessionCleanupRelease = { releaseId: randomUUID(), by };
	writeFileAtomicSync(recordFile(home, parentSessionId), `${JSON.stringify(release)}\n`);
}

/** The session's latest recorded cancellation, if any; a record that does not read as one throws. */
export function readSessionCleanupRelease(
	home: OrchestrationHome,
	parentSessionId: string,
): SessionCleanupRelease | undefined {
	const text = readOptionalBoundedTextFileSync(
		recordFile(home, parentSessionId),
		MAX_RECORD_BYTES,
		"Session cleanup release record",
	);
	if (text === undefined) return undefined;
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		Object.keys(value).length !== 2 ||
		typeof value.releaseId !== "string" ||
		!RELEASE_ID_PATTERN.test(value.releaseId) ||
		value.by !== "open"
	)
		throw new Error("Session cleanup release record is not a release record.");
	return { releaseId: value.releaseId, by: value.by };
}
