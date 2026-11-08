/**
 * What a completion judgment read, as one digest, so an unchanged resubmission replays its last judgment instead of
 * asking System One again.
 *
 * The digest covers everything the judged part of the completion transaction reads: the cold completion projection
 * (both completion stages read it), the account claims System One decides (each statement with the text of the
 * evidence it cites, from the model's effective account), the whole work diff, whether the goal is a bug fix and the
 * decision thresholds.
 *
 * Evidence is keyed by what it says, not by its id. The harness reruns every requirement check on each completion
 * request and records each run as new evidence under a new id; a rerun that reports the same thing is the same
 * evidence to the judgment, so each observation id in the projection is replaced by a digest of its text, trust and
 * freshness wherever it appears, and the evidence table is reduced to its distinct entries in a fixed order. Account
 * claims already carry the evidence text, never its id.
 *
 * A requirement check's run is keyed by its requirement alone. Both completion callers refuse a failing check before
 * the transaction is reached, so at the judgment every check's latest run passed, and its pass or fail is the
 * verification row (`VR-check-<id>`) the projection already carries. The run's text is the exit reason plus the tail
 * of its output, which carries durations and counts that change on every run without changing the verdict; keyed by
 * that text, no goal with a check would ever replay. The cost: a failed run between two judged requests (a flaky
 * check, refused before the judgment) does not change the digest when the work and the latest run are unchanged.
 */

import { createHash } from "node:crypto";
import { isPlainRecord } from "../util/value-guards.ts";
import type { AccountClaim } from "./completion-account.ts";
import type { WorkDiff } from "./work-diff.ts";

const OBSERVATION_PREFIX = "OBS-";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Observation id (with and without its `OBS-` prefix) to the digest of what the observation says; a requirement
 * check's run (`checkRuns`: observation id to requirement id) to its requirement.
 */
function evidenceContentIds(
	projection: Record<string, unknown>,
	checkRuns: ReadonlyMap<string, string>,
): Map<string, string> {
	const ids = new Map<string, string>();
	const table = Array.isArray(projection.evidence) ? projection.evidence : [];
	for (const entry of table) {
		if (!isPlainRecord(entry) || typeof entry.id !== "string") continue;
		const requirementId = checkRuns.get(entry.id);
		const contentId =
			requirementId !== undefined
				? `C${sha256(JSON.stringify([requirementId, entry.trust, entry.freshness])).slice(0, 16)}`
				: `E${sha256(JSON.stringify([entry.text, entry.trust, entry.freshness])).slice(0, 16)}`;
		ids.set(entry.id, contentId);
		if (entry.id.startsWith(OBSERVATION_PREFIX)) ids.set(entry.id.slice(OBSERVATION_PREFIX.length), contentId);
	}
	return ids;
}

function renamed(value: unknown, ids: ReadonlyMap<string, string>): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((member) => renamed(member, ids));
	if (isPlainRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, renamed(member, ids)]));
	return value;
}

function distinctSorted(values: readonly unknown[]): string[] {
	return [...new Set(values.map((value) => JSON.stringify(value)))].sort();
}

export function completionJudgmentDigest(input: {
	readonly projection: Record<string, unknown>;
	/** Observation id of each requirement check run, to its requirement id. */
	readonly checkRuns: ReadonlyMap<string, string>;
	readonly claims: readonly AccountClaim[];
	readonly work: WorkDiff | undefined;
	readonly isBugFix: boolean;
	readonly thresholds: unknown;
}): string {
	const ids = evidenceContentIds(input.projection, input.checkRuns);
	const projection = renamed(input.projection, ids) as Record<string, unknown>;
	const evidence = Array.isArray(projection.evidence) ? distinctSorted(projection.evidence) : [];
	return sha256(
		JSON.stringify({
			projection: { ...projection, evidence },
			claims: distinctSorted(input.claims.map((claim) => [claim.topic, claim.label, claim.fingerprint])),
			work: input.work ? sha256(JSON.stringify(input.work)) : null,
			isBugFix: input.isBugFix,
			thresholds: input.thresholds,
		}),
	).slice(0, 16);
}
