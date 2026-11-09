/** The `/status` text of a {@link SessionAutonomyStatus}: one block per section, an unavailable one with its reason. */

import { describeDaemonBuild } from "../delegation/bot-team-routine-helpers.ts";
import { describeGoalAutoContinue } from "../goals/goal-auto-continue-state.ts";
import { planStatusLine } from "../plan/plan-panel.ts";
import { reviewGaugeStatusLine } from "../proof/review-gauge.ts";
import { describeAwayServiceInspection } from "../routines/away-service.ts";
import { describeRoutineFailureReason } from "../routines/routine-progress.ts";
import { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../system-one/semantic-plane-health.ts";
import type {
	BoundedList,
	DayCount,
	MachineStatusView,
	RoutineStatusItem,
	SessionAutonomyStatus,
	StatusSection,
} from "./autonomy-status.ts";
import type { ToolDecision } from "./tool-manifest.ts";

/** What the owner is told while the session file refuses new writes: why, what is safe, and the way out. */
export const SESSION_SAVE_PAUSED_WORDS =
	"Saving is paused: the last write to this session's file did not finish cleanly, so nothing more is saved until the file is reopened. What is on screen stays. Use /resume and choose this session to reopen it, or /new to start a new one.";

function decisionLine(decision: ToolDecision): string {
	return `${decision.tool}: ${decision.code} (${decision.owner}${decision.detail ? `: ${decision.detail}` : ""})`;
}

/**
 * One machine: its name, its state in plain words, and its undeclared count. A multi-entity observer's state is the last
 * recorded entity's, so it reads so, and reads as no transition at all until the first one is recorded.
 */
function machineLine(machine: MachineStatusView): string {
	const state =
		machine.entities && !machine.last
			? "no transition recorded yet"
			: `${machine.entities ? "last recorded " : ""}${machine.plain}`;
	const last = machine.last ? `, last ${machine.last.from}->${machine.last.to} ${machine.last.reason}` : "";
	return `${machine.name}: ${state}, ${machine.illegalCount} undeclared transition(s)${last}`;
}

function block<T>(title: string, section: StatusSection<T>, lines: (value: T) => string[]): string[] {
	if (section.status === "unavailable") return [`${title}: unavailable: ${section.reason}`];
	const body = lines(section.value);
	return body.length === 0 ? [`${title}: none`] : [`${title}:`, ...body.map((line) => `  ${line}`)];
}

function list<T>(items: BoundedList<T>, line: (item: T) => string): string[] {
	return [...items.items.map(line), ...(items.omitted ? [`(${items.omitted} more)`] : [])];
}

function count(value: DayCount, usd = false): string {
	return usd ? `$${value.used.toFixed(2)} of $${value.max.toFixed(2)}` : `${value.used} of ${value.max}`;
}

function at(ms: number | undefined): string {
	return ms === undefined ? "-" : new Date(ms).toISOString();
}

/** A routine's state in the owner's words; the data value keeps its identifier. */
const ROUTINE_STATE_WORDS: Readonly<Record<RoutineStatusItem["state"], string>> = {
	enabled: "enabled",
	paused: "paused",
	"paused-after-failures": "paused after repeated failures",
	ended: "ended",
};

/** A routine the host paused after failed runs: how many, and the last failure's reason when one is known. */
function pausedAfterFailures(pause: { readonly after: number; readonly lastError?: string }): string {
	const reason = pause.lastError === undefined ? undefined : describeRoutineFailureReason(pause.lastError);
	return `; paused after ${pause.after} failed runs${reason ? `: ${reason}` : ""}`;
}

export function formatSessionAutonomyStatus(status: SessionAutonomyStatus): string {
	return [
		`Autonomy status at ${status.at}`,
		...block("Goal", status.goalContinuation, (value) => [
			...(value.goal
				? [
						`Goal "${value.goal.text}": ${value.goal.met} of ${value.goal.total} requirements met, ${value.goal.status.replace(/_/g, " ")}.`,
					]
				: []),
			...(value.state === "no_goal" ? [] : [describeGoalAutoContinue(value.state)]),
		]),
		...block("Plans", status.plans, (value) => list(value.plans, planStatusLine)),
		...(status.ownerDecisions === undefined
			? []
			: block("Owner decisions", status.ownerDecisions, (value) =>
					value.waiting === 0
						? []
						: [
								`${value.waiting} waiting on you`,
								...list(
									value.items,
									(item) => `${item.what}${item.since === undefined ? "" : `, since ${at(item.since)}`}`,
								),
							],
				)),
		...block("Review", status.review, (value) => [
			reviewGaugeStatusLine(value.waiting) ?? "No finished result is waiting for your review.",
			value.noticeAt > 0
				? `One notice at ${value.noticeAt} waiting; nothing is ever held.`
				: "The waiting-results notice is off; nothing is ever held.",
		]),
		...block("Session file", status.sessionSave, (value) => [
			value.fenced ? SESSION_SAVE_PAUSED_WORDS : "Saving normally.",
		]),
		...block("Routines", status.routines, (value) => [
			`result wakes (24 h): ${count(value.resultWakes)}`,
			...(value.intake
				? [`intake: ${value.intake.state}${value.intake.reason ? ` (${value.intake.reason})` : ""}`]
				: []),
			...list(
				value.routines,
				(routine) =>
					`${routine.routineId}: ${ROUTINE_STATE_WORDS[routine.state]}${routine.ended ? ` (${routine.ended})` : ""}, ${routine.watching ?? routine.schedule}, next ${at(routine.nextRunAt)}${routine.startsFrom !== undefined ? ` (starts from ${at(routine.startsFrom)})` : ""}, last ${routine.lastStatus ?? "-"}${routine.awayRefusal ? `, away refused: ${routine.awayRefusal.reason}` : ""}${routine.failurePause ? pausedAfterFailures(routine.failurePause) : ""}${routine.progress ? `; where it stood: ${routine.progress}` : ""}`,
			),
		]),
		...block("Away daemon", status.awayDaemon, (value) => [
			`${value.running ? "running" : "not running"}${value.pid !== undefined ? ` (pid ${value.pid})` : ""}${value.running ? `, ${describeDaemonBuild(value.build, value.sessionBuild)}` : ""}, heartbeat ${at(value.lastHeartbeatAt)}, ${value.activeRoutines} active, ${value.dueRoutines} due`,
			`away ${value.settings.enabled ? "on" : "off"}: spent $${value.spentUsd.toFixed(2)} of $${value.settings.maxUsdPerDay.toFixed(2)} (24 h), $${value.settings.maxUsdPerRun.toFixed(2)} per run, ${value.settings.maxParentHosts} parent hosts (this session's settings; the daemon reads global settings)`,
			`parents hosted: ${value.hostedParents.status === "available" ? value.hostedParents.value : `unavailable: ${value.hostedParents.reason}`}`,
			value.service.status === "available"
				? describeAwayServiceInspection(value.service.value)
				: `always-on service: unavailable: ${value.service.reason}`,
			...(value.lastEnd
				? [`last end: ${value.lastEnd.reason}${value.lastEnd.detail ? `: ${value.lastEnd.detail}` : ""}`]
				: []),
			...list(value.awayRefusals, (refusal) => `${refusal.routineId} refused away: ${refusal.reason}`),
			...list(
				value.channels,
				(channel) =>
					`channel ${channel.name} away in ${channel.cwd}: served by ${channel.servedBy}, ${channel.awayDrafts} draft(s) written while no session was open wait for the next session (channel_reply)`,
			),
		]),
		...block("Host events", status.hostEvents, (value) => [
			...list(
				value.connections,
				(connection) =>
					`source ${connection.source}: ${connection.state}${connection.reason ? ` (${connection.reason})` : ""}`,
			),
			value.ledger.status === "available"
				? `ledger: ${value.ledger.value.sources.items.length} sources, ${value.ledger.value.subscriptions} subscriptions, ${value.ledger.value.deliveries.pending} pending and ${value.ledger.value.deliveries.reserved} reserved deliveries`
				: `ledger: unavailable: ${value.ledger.reason}`,
			`GitHub interests: ${value.githubInterests.status === "available" ? value.githubInterests.value : `unavailable: ${value.githubInterests.reason}`}`,
		]),
		...block("Acting ahead", status.actAhead, (value) => [
			`${value.enabled ? "on" : "off"}: attempts ${count(value.attempts)}, spend ${count(value.spend, true)} (24 h)`,
			...list(value.episodes, (episode) => `${episode.episode}: ${episode.phase}`),
			...list(
				value.readyPatches,
				(patch) =>
					`patch ${patch.episode}: ${patch.present ? "saved" : "gone"}, ${Math.round(patch.ageMs / 60_000)} min old`,
			),
		]),
		...block("Proactive review", status.proactiveReview, (value) => [
			`${value.enabled ? "on" : "off"} (${value.delivery}): turn wakes ${count(value.turnWakes)}, review spend ${count(value.reviewSpend, true)} (24 h)${value.lastSkipReason ? `, last skip: ${value.lastSkipReason}` : ""}`,
			...list(value.setAside, (topic) => `set aside until ${at(topic.until)}: ${topic.label}`),
		]),
		...block("Channels", status.channels, (value) => [
			...list(
				value.channels,
				(channel) => `${channel.name}: ${channel.state}${channel.detail ? ` (${channel.detail})` : ""}`,
			),
			...(value.journal.status === "unavailable"
				? [`wakes, spend, drafts: unavailable: ${value.journal.reason}`]
				: list(
						value.journal.value,
						(channel) =>
							`${channel.name}: served by ${channel.servedBy}, wakes ${count(channel.wakes)}, spend ${count(channel.spendUsd, true)} (24 h), ${channel.ownerSpendUsd ? `owner spend ${count(channel.ownerSpendUsd, true)} (24 h), ` : ""}${channel.ownerFullAuthority ? "full owner authority, " : ""}${channel.ownerQuotaUsedPercent !== undefined ? `subscription at ${Math.round(channel.ownerQuotaUsedPercent)}% (dollar bounds lifted), ` : ""}${channel.pendingMessages} waiting, ${channel.pendingDrafts} draft(s) (${channel.awayDrafts} written while no session was open), ${channel.heldTotal} held, ${channel.gaps} gap(s)`,
					)),
		]),
		...block("Outward drafts", status.outwardDrafts, (value) => [
			`${value.pending.items.length + (value.pending.omitted ?? 0)} pending, ${value.approved > 0 ? `${value.approved} approved, ` : ""}${value.released} released, ${value.dismissed} dismissed`,
			...list(
				value.pending,
				(draft) =>
					`${draft.toolName} (${draft.classes.join(", ")}) from ${draft.origin}, prepared ${draft.preparedAt}`,
			),
		]),
		...block("Harness notices", status.harnessNotices, (value) => [
			`${value.pending.items.length + (value.pending.omitted ?? 0)} wait for the next owner turn, ${value.unsaved} unsaved`,
			...list(value.pending, (notice) => `${notice.kind}: ${notice.reason}`),
		]),
		...block("Knowledge collection", status.knowledgeCollection, (value) => [
			`${value.state}${value.reason ? ` (${value.reason})` : ""}${value.spentUsd !== undefined ? `, spent $${value.spentUsd.toFixed(2)}${value.sessionMaxUsd !== undefined ? ` of $${value.sessionMaxUsd.toFixed(2)}` : ""}` : ""}`,
		]),
		...block("Authority", status.authority, (value) => [
			`run: ${value.run.state === "idle" ? "idle" : `${value.run.authority}${value.run.origin ? ` (${value.run.origin})` : ""}`}, edge ${value.edgeMode}, third-party classes: ${value.thirdPartyAllow.join(", ") || "none"}`,
			...list(value.standingGrants, (grant) => `standing grant ${grant.class} (${grant.source})`),
		]),
		...block("System One", status.systemOne, (value) => [
			value.state === "no-engine" ? `no engine: ${SYSTEM_ONE_NO_ENGINE_CAUSE}` : value.state,
		]),
		...block("Machines", status.machines, (machines) => list(machines, machineLine)),
		...block("Recent runs", status.runs, (runs) =>
			runs.flatMap((run) => [
				`${run.runId} ${run.authority}${run.authorityChanged ? " (changed)" : ""}${run.endedAt === undefined ? " running" : ""}: ${run.offered.length + (run.offeredOmitted ?? 0)} tools offered, ${run.omitted.length} omitted, ${run.refused.length + (run.refusedOmitted ?? 0)} refused`,
				...run.omitted.map((decision) => `  left out ${decisionLine(decision)}`),
				...run.refused.map((decision) => `  refused ${decisionLine(decision)}`),
			]),
		),
	].join("\n");
}
