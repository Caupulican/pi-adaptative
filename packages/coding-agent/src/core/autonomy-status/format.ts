/** The `/status` text of a {@link SessionAutonomyStatus}: one block per section, an unavailable one with its reason. */

import { describeDaemonBuild } from "../delegation/bot-team-routine-helpers.ts";
import { describeGoalAutoContinue } from "../goals/goal-auto-continue-state.ts";
import { interfaceText } from "../language/interface-text.ts";
import { planStatusLine } from "../plan/plan-panel.ts";
import { reviewGaugeStatusLine } from "../proof/review-gauge.ts";
import { describeAwayServiceInspection } from "../routines/away-service.ts";
import { describeRoutineFailureReason } from "../routines/routine-progress.ts";
import { describeWatchCondition } from "../routines/watch-contract.ts";
import { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../system-one/semantic-plane-health.ts";
import type {
	BoundedList,
	DayCount,
	MachineStatusView,
	SessionAutonomyStatus,
	StatusSection,
} from "./autonomy-status.ts";
import type { ToolDecision } from "./tool-manifest.ts";

/** What the owner is told while the session file refuses new writes: why, what is safe, and the way out. */
export function sessionSavePausedWords(): string {
	return interfaceText().notices.sessionSavePaused;
}

/** An amount of money on the owner's screen, in the decimal separator and the fraction digits of the interface language. */
function money(value: number): string {
	return interfaceText().reports.formats.amount(value, 2);
}

function decisionLine(decision: ToolDecision): string {
	return `${decision.tool}: ${decision.code} (${decision.owner}${decision.detail ? `: ${decision.detail}` : ""})`;
}

/**
 * One machine: its name, its state in plain words, and its undeclared count. A multi-entity observer's state is the last
 * recorded entity's, so it reads so, and reads as no transition at all until the first one is recorded.
 */
function machineLine(machine: MachineStatusView): string {
	const words = interfaceText().autonomyStatus.machines;
	const state =
		machine.entities && !machine.last
			? words.noTransition
			: machine.entities
				? words.lastRecorded(machine.plain)
				: machine.plain;
	const last = machine.last ? words.last(machine.last.from, machine.last.to, machine.last.reason) : "";
	return words.line(machine.name, state, machine.illegalCount, last);
}

function block<T>(title: string, section: StatusSection<T>, lines: (value: T) => string[]): string[] {
	const words = interfaceText().autonomyStatus;
	if (section.status === "unavailable") return [`${title}: ${words.unavailable(section.reason)}`];
	const body = lines(section.value);
	return body.length === 0 ? [`${title}: ${words.none}`] : [`${title}:`, ...body.map((line) => `  ${line}`)];
}

function list<T>(items: BoundedList<T>, line: (item: T) => string): string[] {
	return [...items.items.map(line), ...(items.omitted ? [interfaceText().autonomyStatus.more(items.omitted)] : [])];
}

/** An amount the report counts: a plain pair of numbers, or the money a bounded list spent. */
function count(value: DayCount, usd = false): string {
	const words = interfaceText().autonomyStatus.count;
	return usd ? words.money(money(value.used), money(value.max)) : words.plain(`${value.used}`, `${value.max}`);
}

function at(ms: number | undefined): string {
	return ms === undefined ? "-" : new Date(ms).toISOString();
}

/** A routine the host paused after failed runs: how many, and the last failure's reason when one is known. */
function pausedAfterFailures(pause: { readonly after: number; readonly lastError?: string }): string {
	const reason = pause.lastError === undefined ? undefined : describeRoutineFailureReason(pause.lastError);
	return interfaceText().autonomyStatus.routines.pausedAfterFailures(pause.after, reason);
}

export function formatSessionAutonomyStatus(status: SessionAutonomyStatus): string {
	const words = interfaceText().autonomyStatus;
	const titles = words.blocks;
	return [
		words.head(status.at),
		...block(titles.goal, status.goalContinuation, (value) => [
			...(value.goal
				? [words.goal.line(value.goal.text, value.goal.met, value.goal.total, words.goal.status(value.goal.status))]
				: []),
			...(value.state === "no_goal" ? [] : [describeGoalAutoContinue(value.state)]),
		]),
		...block(titles.plans, status.plans, (value) => list(value.plans, planStatusLine)),
		...(status.ownerDecisions === undefined
			? []
			: block(titles.ownerDecisions, status.ownerDecisions, (value) =>
					value.waiting === 0
						? []
						: [
								words.ownerDecisions.waiting(value.waiting),
								...list(value.items, (item) =>
									words.ownerDecisions.item(item.what, item.since === undefined ? undefined : at(item.since)),
								),
							],
				)),
		...block(titles.review, status.review, (value) => [
			reviewGaugeStatusLine(value.waiting) ?? words.review.none,
			value.noticeAt > 0 ? words.review.noticeOn(value.noticeAt) : words.review.noticeOff,
		]),
		...block(titles.sessionFile, status.sessionSave, (value) => [
			value.fenced ? sessionSavePausedWords() : words.sessionFile.saving,
		]),
		...block(titles.routines, status.routines, (value) => [
			words.routines.wakes(count(value.resultWakes)),
			...(value.intake ? [words.routines.intake(value.intake.state, value.intake.reason)] : []),
			...list(value.routines, (routine) =>
				words.routines.line({
					routineId: routine.routineId,
					state: words.routines.state[routine.state],
					ended: routine.ended,
					schedule:
						routine.condition === undefined
							? routine.schedule
							: describeWatchCondition(routine.condition, interfaceText().chat.watch),
					next: at(routine.nextRunAt),
					startsFrom: routine.startsFrom === undefined ? undefined : at(routine.startsFrom),
					lastStatus: routine.lastStatus ?? "-",
					awayRefusal: routine.awayRefusal?.reason,
					pause: routine.failurePause ? pausedAfterFailures(routine.failurePause) : undefined,
					progress: routine.progress,
				}),
			),
		]),
		...block(titles.awayDaemon, status.awayDaemon, (value) => [
			words.awayDaemon.state({
				running: value.running,
				pid: value.pid,
				build: describeDaemonBuild(value.build, value.sessionBuild, interfaceText().chat),
				heartbeat: at(value.lastHeartbeatAt),
				activeRoutines: value.activeRoutines,
				dueRoutines: value.dueRoutines,
			}),
			words.awayDaemon.settings({
				enabled: value.settings.enabled,
				spent: money(value.spentUsd),
				maxPerDay: money(value.settings.maxUsdPerDay),
				maxPerRun: money(value.settings.maxUsdPerRun),
				maxParentHosts: value.settings.maxParentHosts,
			}),
			words.awayDaemon.parentsHosted(
				value.hostedParents.status === "available"
					? String(value.hostedParents.value)
					: words.unavailable(value.hostedParents.reason),
			),
			value.service.status === "available"
				? describeAwayServiceInspection(value.service.value)
				: words.awayDaemon.service(undefined, value.service.reason),
			...(value.lastEnd ? [words.awayDaemon.lastEnd(value.lastEnd.reason, value.lastEnd.detail)] : []),
			...list(value.awayRefusals, (refusal) => words.awayDaemon.refusedAway(refusal.routineId, refusal.reason)),
			...list(value.channels, (channel) => words.awayDaemon.channel(channel)),
		]),
		...block(titles.hostEvents, status.hostEvents, (value) => [
			...list(value.connections, (connection) =>
				words.hostEvents.source(connection.source, connection.state, connection.reason),
			),
			value.ledger.status === "available"
				? words.hostEvents.ledger(
						value.ledger.value.sources.items.length,
						value.ledger.value.subscriptions,
						value.ledger.value.deliveries.pending,
						value.ledger.value.deliveries.reserved,
					)
				: words.hostEvents.ledgerUnavailable(value.ledger.reason),
			words.hostEvents.githubInterests(
				value.githubInterests.status === "available"
					? String(value.githubInterests.value)
					: words.unavailable(value.githubInterests.reason),
			),
		]),
		...block(titles.actingAhead, status.actAhead, (value) => [
			words.actingAhead.state(value.enabled, count(value.attempts), count(value.spend, true)),
			...list(value.episodes, (episode) => words.actingAhead.episode(episode.episode, episode.phase)),
			...list(value.readyPatches, (patch) =>
				words.actingAhead.patch(patch.episode, patch.present, Math.round(patch.ageMs / 60_000)),
			),
		]),
		...block(titles.proactiveReview, status.proactiveReview, (value) => [
			words.proactiveReview.state({
				enabled: value.enabled,
				delivery: value.delivery,
				turnWakes: count(value.turnWakes),
				reviewSpend: count(value.reviewSpend, true),
				lastSkip: value.lastSkipReason,
			}),
			...list(value.setAside, (topic) => words.proactiveReview.setAside(at(topic.until), topic.label)),
		]),
		...block(titles.channels, status.channels, (value) => [
			...list(value.channels, (channel) => words.channels.channel(channel.name, channel.state, channel.detail)),
			...(value.journal.status === "unavailable"
				? [words.channels.journalUnavailable(value.journal.reason)]
				: list(value.journal.value, (channel) =>
						words.channels.journal({
							name: channel.name,
							servedBy: channel.servedBy,
							wakes: count(channel.wakes),
							spend: count(channel.spendUsd, true),
							ownerSpend: channel.ownerSpendUsd ? count(channel.ownerSpendUsd, true) : undefined,
							ownerFullAuthority: channel.ownerFullAuthority,
							ownerQuotaUsedPercent: channel.ownerQuotaUsedPercent,
							pendingMessages: channel.pendingMessages,
							pendingDrafts: channel.pendingDrafts,
							awayDrafts: channel.awayDrafts,
							heldTotal: channel.heldTotal,
							gaps: channel.gaps,
						}),
					)),
		]),
		...block(titles.outwardDrafts, status.outwardDrafts, (value) => [
			words.outwardDrafts.counts(
				value.pending.items.length + (value.pending.omitted ?? 0),
				value.approved,
				value.released,
				value.dismissed,
			),
			...list(value.pending, (draft) =>
				words.outwardDrafts.draft(draft.toolName, draft.classes.join(", "), draft.origin, draft.preparedAt),
			),
		]),
		...block(titles.harnessNotices, status.harnessNotices, (value) => [
			words.harnessNotices.counts(value.pending.items.length + (value.pending.omitted ?? 0), value.unsaved),
			...list(value.pending, (notice) => words.harnessNotices.notice(notice.kind, notice.reason)),
		]),
		...block(titles.knowledgeCollection, status.knowledgeCollection, (value) => [
			words.knowledgeCollection.line({
				state: value.state,
				reason: value.reason,
				spent: value.spentUsd === undefined ? undefined : money(value.spentUsd),
				max: value.sessionMaxUsd === undefined ? undefined : money(value.sessionMaxUsd),
			}),
		]),
		...block(titles.authority, status.authority, (value) => [
			words.authority.line({
				run:
					value.run.state === "idle"
						? words.idle
						: `${value.run.authority}${value.run.origin ? ` (${value.run.origin})` : ""}`,
				edgeMode: value.edgeMode,
				thirdParty: value.thirdPartyAllow.join(", "),
			}),
			...list(value.standingGrants, (grant) => words.authority.grant(grant.class, grant.source)),
		]),
		...block(titles.systemOne, status.systemOne, (value) => [
			value.state === "no-engine" ? words.systemOne.noEngine(SYSTEM_ONE_NO_ENGINE_CAUSE) : value.state,
		]),
		...block(titles.machines, status.machines, (machines) => list(machines, machineLine)),
		...block(titles.recentRuns, status.runs, (runs) =>
			runs.flatMap((run) => [
				words.recentRuns.line({
					runId: run.runId,
					authority: run.authority,
					authorityChanged: run.authorityChanged,
					running: run.endedAt === undefined,
					offered: run.offered.length + (run.offeredOmitted ?? 0),
					omitted: run.omitted.length,
					refused: run.refused.length + (run.refusedOmitted ?? 0),
				}),
				...run.omitted.map((decision) => words.recentRuns.leftOut(decisionLine(decision))),
				...run.refused.map((decision) => words.recentRuns.refused(decisionLine(decision))),
			]),
		),
	].join("\n");
}
