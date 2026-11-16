/**
 * The words and details of a session watch's wakes, built from its ledger record alone (`session-watch-ledger.ts`), so a
 * redelivery after a restart is the same input: the plan the armer saved (read as its own words only when the session
 * armed it under a turn not a third party's), the English sentence its armer reads, the details every reader of a
 * session's transcript already reads as a routine watch's wake, and the id each wake is delivered under.
 */
import { createHash } from "node:crypto";
import { englishText } from "../language/interface-text.ts";
import {
	type WatchWakePlan,
	watchFailingWakeText,
	watchFiredWakeText,
	watchTimedOutWakeText,
} from "../routines/routine-watch-wake.ts";
import { watchFiredLine } from "../routines/watch-contract.ts";
import { describeGithubWatchResult, isGithubWatchSource } from "./github-watch-source.ts";
import { githubWatchWakeText } from "./github-watch-wake.ts";
import type { SessionWatchRecord, SessionWatchWake, SessionWatchWakeKind } from "./session-watch-ledger.ts";

/** The plan a wake carries: the armer's words, read as its own only when the session armed it under a turn not a third party's. */
function wakePlan(record: SessionWatchRecord): WatchWakePlan {
	return {
		watchId: record.watchId,
		text: record.purpose === undefined ? record.onFire : `Purpose: ${record.purpose}\nOn fire: ${record.onFire}`,
		// The host's own plan of a watch it armed is its words; a third party's turn's plan is data.
		trusted:
			record.armedBy.kind === "auto" ||
			(record.armedBy.kind === "session" && record.armedBy.authority !== "third-party"),
	};
}

/** The words of one wake, from the record alone. */
export function sessionWatchWakeText(record: SessionWatchRecord, wake: SessionWatchWake, planChars?: number): string {
	const plan = wakePlan(record);
	const { condition } = record;
	if (isGithubWatchSource(condition)) return githubWatchWakeText(plan, record, condition, wake, planChars);
	if (wake.kind === "fired") {
		if (!record.event) throw new Error(`Watch ${record.watchId} has no recorded firing.`);
		return watchFiredWakeText(
			plan,
			wake.deliveryId,
			{ event: record.event, sequence: record.cursor.fires },
			false,
			planChars,
		);
	}
	if (wake.kind === "timed-out")
		return watchTimedOutWakeText(
			plan,
			wake.deliveryId,
			condition,
			record.expiresAt,
			record.lastSeen,
			false,
			planChars,
		);
	if (!wake.failing) throw new Error(`Watch ${record.watchId} has no recorded failing streak.`);
	return watchFailingWakeText(plan, record.incarnationId, condition, record.expiresAt, wake.failing, planChars);
}

/**
 * The details of one wake: the keys a routine watch's wake carries, which every reader of a session transcript already
 * reads (`routineId` holds the watch's id; `oneShotWatch` keeps it out of the day's wake bound; `thirdParty` marks a firing
 * that carries the watched thing's words).
 */
export function sessionWatchWakeDetails(record: SessionWatchRecord, wake: SessionWatchWake): Record<string, unknown> {
	// The entry the watch was armed from: its wake turns are charged to that entry's spend window.
	const served = record.served === undefined ? {} : { served: record.served };
	// A typed source's firing: its cause in English (what every reader of a wake's row shows when it holds no firing
	// line) and the reading itself, which this build's row words in the interface language.
	if (wake.kind === "fired" && record.result && isGithubWatchSource(record.condition))
		return {
			routineId: record.watchId,
			outcome: "succeeded",
			wake: true,
			cause: describeGithubWatchResult(record.condition, record.result, englishText().chat.watch.github),
			github: { source: record.condition, result: record.result },
			oneShotWatch: true,
			...served,
		};
	if (wake.kind === "fired" && record.event)
		return {
			routineId: record.watchId,
			outcome: "succeeded",
			wake: true,
			watch: watchFiredLine(record.event),
			oneShotWatch: true,
			...(record.event.excerpt === undefined ? {} : { thirdParty: true }),
			...served,
		};
	if (wake.kind === "timed-out")
		return { routineId: record.watchId, expiresAt: record.expiresAt, oneShotWatch: true, ...served };
	return { routineId: record.watchId, failing: true, oneShotWatch: true, ...served };
}

/** The id one wake is delivered under: one per watch incarnation and kind, a failing streak's also by when it was reported. */
export function sessionWatchDeliveryId(
	sessionId: string,
	record: SessionWatchRecord,
	kind: SessionWatchWakeKind,
	at: number,
): string {
	return `watch:${createHash("sha256")
		.update(JSON.stringify([sessionId, record.watchId, record.incarnationId, kind, kind === "failing" ? at : 0]))
		.digest("hex")}`;
}
