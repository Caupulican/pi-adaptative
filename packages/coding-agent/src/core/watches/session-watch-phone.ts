/**
 * A session watch's result as the owner's phone hears it (`OwnerPush.tell`) when its armer asked for that (`tellOwner`):
 * one sentence in the interface language, `Watch "<purpose>": <outcome>.`, keyed by the wake it tells of, so each firing,
 * end or failing streak is told once however often its delivery is tried.
 */
import type { InterfaceText } from "../language/interface-text.ts";
import { describeWatchFired, watchFiredLine } from "../routines/watch-contract.ts";
import {
	describeGithubWatchResultForOwner,
	describeSessionWatchSource,
	isGithubWatchSource,
} from "./github-watch-source.ts";
import type { SessionWatchRecord, SessionWatchWake } from "./session-watch-ledger.ts";

/** How much of a watch's purpose a phone sentence carries. */
const PHONE_PURPOSE_CHARS = 160;

/** The one sentence a watch's result is told in: the words of the interface language passed in. */
export function watchResultPhoneText(words: InterfaceText["chat"]["watch"], purpose: string, outcome: string): string {
	const said = purpose.length > PHONE_PURPOSE_CHARS ? `${purpose.slice(0, PHONE_PURPOSE_CHARS - 1)}…` : purpose;
	return `${words.phone.lead} "${said}": ${outcome}.`;
}

/** The key one wake is told under: the watch and the wake's own delivery id, so a retried delivery tells nothing new. */
export function sessionWatchPhoneKey(record: SessionWatchRecord, wake: SessionWatchWake): string {
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
	let outcome: string;
	if (wake.kind === "timed-out") outcome = words.phone.timedOut;
	else if (wake.kind === "failing") outcome = words.phone.failing(wake.failing?.failures ?? 0);
	else if (isGithubWatchSource(condition)) {
		if (!record.result) throw new Error(`Watch ${record.watchId} has no recorded result.`);
		outcome = describeGithubWatchResultForOwner(condition, record.result, words.github);
	} else {
		if (!record.event) throw new Error(`Watch ${record.watchId} has no recorded firing.`);
		outcome = describeWatchFired(watchFiredLine(record.event), words.fired);
	}
	return watchResultPhoneText(words, subject, outcome);
}
