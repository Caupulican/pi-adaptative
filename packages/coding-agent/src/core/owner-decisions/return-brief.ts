/**
 * Renders the brief an owner gets on returning after an idle gap, from code facts only. The brief quotes worker and agent
 * words, so the whole text is returned inside an untrusted fence, and it never exceeds `RETURN_BRIEF_MAX_CHARS`.
 */

import { oneLine, truncateWithEllipsis } from "../provider-tool-text.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { OwnerDecisionItem } from "./owner-decision-queue.ts";

export const RETURN_BRIEF_MAX_CHARS = 2000;

/**
 * The transient record kind a brief is carried under. Host-reserved (turn-origin lists it), so no extension can write it.
 * Defined here because this module is a leaf: turn-origin imports it, and the controller that builds briefs does not.
 */
export const OWNER_RETURN_BRIEF_CUSTOM_TYPE = "owner_return_brief";
/** What replaces a brief once the turn it was made for is past; the earlier record stays in a classic history. */
export const RETURN_BRIEF_CLEARED_TEXT = "The return brief above is past; /status has the current state.";

/**
 * The brief a request carries for the owner turn it was made for. `content` is undefined while no brief is current.
 * `commit` runs when the request that carries the brief is committed: only then has the owner been shown its items.
 */
export interface ReturnBriefPlan {
	readonly content: string | undefined;
	isCurrent(): boolean;
	commit?(): void;
}

/** The commits read since the away span, newest first. `capped`: the read stopped at its limit, so the count is at least `shown`. */
export interface ReturnBriefCommits {
	readonly shown: readonly { readonly sha: string; readonly subject: string }[];
	readonly capped: boolean;
}

const RETURN_BRIEF_SOURCE = "owner-return-brief";
const QUEUE_SHOWN = 10;
const COMMITS_SHOWN = 5;
/** Each section has its own budget, so a long activity list never pushes the waiting decisions out of the brief. */
const ACTIVITY_MAX_CHARS = 500;
const QUEUE_MAX_CHARS = 1_000;
const LINE_MAX_CHARS = 200;
const COMMIT_LINE_MAX_CHARS = 120;
const MINUTE_MS = 60_000;
const CUT_NOTICE = "- More is in /status: this brief was cut to its size limit.";

/** What happened while the owner was away, and what waits on them now. Each fact is already scoped to the away span. */
export interface ReturnBriefFacts {
	/** Epoch milliseconds of the owner's previous typed message: the start of the away span. */
	readonly awaySince: number;
	readonly now: number;
	readonly plansSettled: readonly { readonly planId: string; readonly title: string; readonly outcome: string }[];
	/** Worker outcome status to count, for example `succeeded`. */
	readonly workerOutcomes: Readonly<Record<string, number>>;
	/** Undefined when the commit log could not be read: the brief says so and never reports zero commits. */
	readonly commits: ReturnBriefCommits | undefined;
	readonly ci?: { readonly conclusion: string; readonly at: number };
	readonly queue: readonly OwnerDecisionItem[];
	/** Queue keys the owner has not been shown before. */
	readonly newKeys: ReadonlySet<string>;
}

/** The brief's text, or undefined when nothing finished while the owner was away and nothing waits on them. */
export function renderReturnBrief(facts: ReturnBriefFacts): string | undefined {
	const activity = activityLines(facts);
	if (!activity.happened && facts.queue.length === 0) return undefined;
	const lines = [`While you were away (${awayText(facts)}):`, ...activity.lines];
	if (facts.queue.length > 0) lines.push("", `Waiting on you (${facts.queue.length}):`, ...queueLines(facts));
	return fitBrief(lines);
}

function awayText(facts: ReturnBriefFacts): string {
	const since = isoOf(facts.awaySince);
	const minutes = Math.floor((facts.now - facts.awaySince) / MINUTE_MS);
	return Number.isFinite(minutes) ? `${Math.max(0, minutes)} min, since ${since}` : `since ${since}`;
}

function activityLines(facts: ReturnBriefFacts): { readonly lines: string[]; readonly happened: boolean } {
	const lines = facts.plansSettled.map((plan) => plain(`- Plan "${plan.title}": ${plan.outcome}`));
	const workers = Object.entries(facts.workerOutcomes).filter(([, count]) => count > 0);
	if (workers.length > 0)
		lines.push(plain(`- Workers: ${workers.map(([status, count]) => `${count} ${status}`).join(", ")}`));
	if (facts.commits === undefined) lines.push("- Commits: not read");
	else if (facts.commits.shown.length === 0) lines.push("- Commits: none");
	else {
		const { shown, capped } = facts.commits;
		const qualifier = capped ? "at least " : "";
		lines.push(`- Commits: ${qualifier}${shown.length}`);
		lines.push(
			...shown
				.slice(0, COMMITS_SHOWN)
				.map((commit) => plain(`- ${commit.sha} ${commit.subject}`, COMMIT_LINE_MAX_CHARS)),
		);
		if (shown.length > COMMITS_SHOWN) lines.push(`- and ${qualifier}${shown.length - COMMITS_SHOWN} more commits`);
	}
	if (facts.ci !== undefined) lines.push(plain(`- CI: ${facts.ci.conclusion}, ${isoOf(facts.ci.at)}`));
	const happened =
		facts.plansSettled.length > 0 ||
		workers.length > 0 ||
		(facts.commits?.shown.length ?? 0) > 0 ||
		facts.ci !== undefined;
	if (!happened) lines.unshift("- Nothing finished.");
	const fitted = fitLines(lines, ACTIVITY_MAX_CHARS);
	if (fitted.hidden > 0) fitted.kept.push(`- and ${fitted.hidden} more lines in /status`);
	return { lines: fitted.kept, happened };
}

function queueLines(facts: ReturnBriefFacts): string[] {
	const lines = facts.queue
		.slice(0, QUEUE_SHOWN)
		.map((item) => plain(`- ${facts.newKeys.has(item.key) ? "[new] " : ""}${item.what}`));
	const fitted = fitLines(lines, QUEUE_MAX_CHARS);
	const hidden = facts.queue.length - fitted.kept.length;
	if (hidden > 0) fitted.kept.push(`- and ${hidden} more in /status`);
	return fitted.kept;
}

/** The leading lines that fit `maxChars` together (one newline between lines), and how many lines were left out. */
function fitLines(lines: readonly string[], maxChars: number): { readonly kept: string[]; readonly hidden: number } {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const cost = line.length + (kept.length > 0 ? 1 : 0);
		if (used + cost > maxChars) break;
		kept.push(line);
		used += cost;
	}
	return { kept, hidden: lines.length - kept.length };
}

/** The whole brief when it fits; otherwise the longest prefix of whole lines that fits, then a notice that it was cut. */
function fitBrief(lines: readonly string[]): string {
	const whole = fenced(lines);
	if (whole.length <= RETURN_BRIEF_MAX_CHARS) return whole;
	for (let kept = lines.length - 1; kept > 0; kept--) {
		const cut = fenced([...lines.slice(0, kept), CUT_NOTICE]);
		if (cut.length <= RETURN_BRIEF_MAX_CHARS) return cut;
	}
	return fenced([CUT_NOTICE]);
}

function fenced(lines: readonly string[]): string {
	return wrapUntrustedText(lines.join("\n"), RETURN_BRIEF_SOURCE);
}

function plain(text: string, maxChars = LINE_MAX_CHARS): string {
	return truncateWithEllipsis(oneLine(text), maxChars);
}

function isoOf(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "an unknown time" : date.toISOString();
}
