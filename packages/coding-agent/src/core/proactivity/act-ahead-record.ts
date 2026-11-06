/**
 * The durable records of acting ahead on a failing CI run: one custom entry per state change of an episode, in the root
 * session's transcript. They are its dedupe, its recovery after restart, and its rolling-day accounting.
 */

import type { CiAttemptTerminalEvent } from "../events/host-event-contract.ts";

export const ACT_AHEAD_CUSTOM_TYPE = "act-ahead";

/** Read-only evidence of a failed CI attempt, gathered by the host's CI adapter. Third-party-authorable text. */
export interface CiFailureEvidence {
	readonly jobs: readonly { readonly name: string; readonly failedSteps: readonly string[] }[];
	/** The failed job whose log end is carried. */
	readonly logJob?: string;
	/** The last lines of that job's log, secret-redacted and bounded. */
	readonly logTail?: string;
}

/** The host's read of one failed attempt's evidence; undefined when the attempt is not its source's to read. */
export type CiFailureEvidenceReader = (
	event: CiAttemptTerminalEvent,
	signal: AbortSignal,
) => Promise<CiFailureEvidence | undefined>;

/** What made the harness start a worker: the check failed in the lane, or the CI log named the failing step. */
export type ActAheadBasis = "reproduced" | "ci-log";

export type ActAheadPhase = "armed" | "admitted" | "working" | "ready" | "abandoned" | "capped" | "settled";

export interface ActAheadRecord {
	readonly v: 1;
	readonly episode: string;
	readonly phase: ActAheadPhase;
	readonly eventId: string;
	readonly headSha: string;
	/** The failure's identity: the same failure on the same revision never starts a second episode. */
	readonly failureKey?: string;
	/** `admitted`: the spend bound charged before the worker starts. */
	readonly chargeUsd?: number;
	/** `settled`: what the worker spent; the day's account moves from the charge to it. */
	readonly spentUsd?: number;
	readonly laneKey?: string;
	readonly lanePath?: string;
	/** `working`: the worker's task. */
	readonly taskId?: string;
	readonly basis?: ActAheadBasis;
	/** `abandoned` and `capped`: a stable reason. */
	readonly reason?: string;
	/** `ready`: the saved patch, the check that passed, the changed files. */
	readonly patchPath?: string;
	readonly check?: string;
	readonly files?: readonly string[];
}

const PHASES: ReadonlySet<string> = new Set([
	"armed",
	"admitted",
	"working",
	"ready",
	"abandoned",
	"capped",
	"settled",
]);

/** The record an entry carries, or undefined for any other entry or a malformed record. */
export function actAheadRecordOf(entry: {
	type: string;
	customType?: string;
	data?: unknown;
}): ActAheadRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== ACT_AHEAD_CUSTOM_TYPE) return undefined;
	const data = entry.data as Partial<ActAheadRecord> | undefined;
	if (
		data?.v !== 1 ||
		typeof data.episode !== "string" ||
		typeof data.phase !== "string" ||
		!PHASES.has(data.phase) ||
		typeof data.eventId !== "string" ||
		typeof data.headSha !== "string"
	)
		return undefined;
	return data as ActAheadRecord;
}

/** The record's share of the rolling-day bounds: an admission is one attempt and its charge; a settlement corrects it. */
export function actAheadAccount(record: ActAheadRecord): { attempts: number; usd: number } | undefined {
	if (record.phase === "admitted" && typeof record.chargeUsd === "number" && Number.isFinite(record.chargeUsd))
		return { attempts: 1, usd: record.chargeUsd };
	if (
		record.phase === "settled" &&
		typeof record.chargeUsd === "number" &&
		typeof record.spentUsd === "number" &&
		Number.isFinite(record.chargeUsd) &&
		Number.isFinite(record.spentUsd)
	)
		return { attempts: 0, usd: record.spentUsd - record.chargeUsd };
	return undefined;
}
