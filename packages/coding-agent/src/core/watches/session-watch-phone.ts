/**
 * A session watch's result as the owner's phone hears it (`OwnerPush.tell`) when its armer asked for that (`tellOwner`):
 * one sentence in the interface language, `Watch "<purpose, or what it waits on>": <outcome>.`, or `Watch: <outcome>.` when
 * the outcome already names what it waited on (a GitHub source's result, armed with no purpose), keyed by the wake it
 * tells of, so each firing, end or failing streak is told once however often its delivery is tried; a GitHub source's
 * result is keyed by its subject and the result it tells, so two watches on one subject tell that result once: a firing's,
 * and a timeout's holding a result done or read only after its end time, which tells that result as such.
 */
import { createHash } from "node:crypto";
import type { InterfaceText } from "../language/interface-text.ts";
import { describeWatchFired, watchFiredLine } from "../routines/watch-contract.ts";
import {
	describeGithubWatchResult,
	describeSessionWatchSource,
	githubWatchSubject,
	isGithubWatchSource,
} from "./github-watch-source.ts";
import type { SessionWatchRecord, SessionWatchWake } from "./session-watch-ledger.ts";

/** How much of a watch's purpose a phone sentence carries. */
const PHONE_PURPOSE_CHARS = 160;

/**
 * The one sentence a watch's result is told in: the words of the interface language passed in, and what the watch is
 * about unless the outcome names it already.
 */
export function watchResultPhoneText(
	words: InterfaceText["chat"]["watch"],
	subject: string | undefined,
	outcome: string,
): string {
	if (subject === undefined) return `${words.phone.lead}: ${outcome}.`;
	const said = subject.length > PHONE_PURPOSE_CHARS ? `${subject.slice(0, PHONE_PURPOSE_CHARS - 1)}…` : subject;
	return `${words.phone.lead} "${said}": ${outcome}.`;
}

/**
 * The key one wake is told under: the watch and the wake's own delivery id (one per watch incarnation and kind, a failing
 * streak's also by when it was reported), so a retried delivery tells nothing new and a watch armed again tells its own
 * end. A GitHub source's wake that tells a done result (its firing, or its timeout holding one) is keyed by its subject
 * instead, so the session's and a worker's watch on one subject tell the owner that result once: by what it is a result
 * of (the run attempt it ended, or the release's status), so a rerun's is told.
 */
export function sessionWatchPhoneKey(record: SessionWatchRecord, wake: SessionWatchWake): string {
	const { condition, result } = record;
	// A firing, or a timeout holding a result done or read only after the end time, tells that result.
	if (isGithubWatchSource(condition) && wake.kind !== "failing" && result?.state === "done") {
		const told = `${githubWatchSubject(condition)}\n${result.runId === undefined ? result.status : `${result.runId}:${result.runAttempt ?? 1}`}`;
		return `watch:github:${createHash("sha256").update(told).digest("hex").slice(0, 16)}`;
	}
	return `watch:${record.watchId}:${wake.deliveryId.replace(/^watch:/u, "").slice(0, 16)}`;
}

/** What one wake tells the owner: the watch's purpose (or what it waits on) and how it ended or stands. */
export function sessionWatchPhoneText(
	record: SessionWatchRecord,
	wake: SessionWatchWake,
	words: InterfaceText["chat"]["watch"],
): string {
	const { condition } = record;
	const subject = record.purpose ?? describeSessionWatchSource(condition, words);
	if (wake.kind === "timed-out") {
		// A result done only after the end time, or read only then, is told as such: only a purpose is said beside it.
		if (isGithubWatchSource(condition) && record.result?.state === "done")
			return watchResultPhoneText(
				words,
				record.purpose,
				words.phone.doneAfterDeadline(describeGithubWatchResult(condition, record.result, words.github)),
			);
		return watchResultPhoneText(words, subject, words.phone.timedOut);
	}
	if (wake.kind === "failing")
		return watchResultPhoneText(words, subject, words.phone.failing(wake.failing?.failures ?? 0));
	if (isGithubWatchSource(condition)) {
		if (!record.result) throw new Error(`Watch ${record.watchId} has no recorded result.`);
		// The result names what the watch waited on: only a purpose is said beside it, never the subject twice.
		return watchResultPhoneText(
			words,
			record.purpose,
			describeGithubWatchResult(condition, record.result, words.github),
		);
	}
	if (!record.event) throw new Error(`Watch ${record.watchId} has no recorded firing.`);
	return watchResultPhoneText(words, subject, describeWatchFired(watchFiredLine(record.event), words.fired));
}
