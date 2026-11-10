/**
 * `/lead`: the owner's view of the goals handed to leaders, and the override to cancel, pause or resume one. Leaders
 * work without it; the orchestrator delegates with `bot lead` and hears back once when a goal ends. Reading the goals
 * never builds the worker runtime; only an override does. `/bot lead <id>` is the other command: it makes a bot a
 * standing leader, and `/lead` never does.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { DelegationRecord } from "../../core/delegation/leader-delegation-ledger.ts";
import { currentDelegationFor, leaderRow, leaderRows } from "../../core/delegation/leader-view.ts";
import { interfaceText } from "../../core/language/interface-text.ts";

export interface LeaderCommandsHost {
	readonly session: Pick<AgentSession, "backgroundLanes">;
	showStatus(message: string): void;
	showError(message: string): void;
}

const ACTIONS = ["show", "cancel", "pause", "resume"] as const;

function displayName(host: LeaderCommandsHost, alias: string): string {
	return host.session.backgroundLanes.getBotTeamStore().getBot(alias)?.displayName ?? alias;
}

/** The reason `/lead` cannot work on this bot, in plain words; undefined when the bot is a leader. */
function notALeaderText(host: LeaderCommandsHost, alias: string): string | undefined {
	const words = interfaceText().machines.lead;
	const bot = host.session.backgroundLanes.getBotTeamStore().getBot(alias);
	if (!bot) return words.noSuchBot(alias);
	if (bot.leader === true) return undefined;
	return words.notALeader(bot.displayName, alias);
}

/** The goals, one line each: who leads, which goal, where it stands, and the name `/lead` takes. */
export function formatLeaderList(records: readonly DelegationRecord[], name: (alias: string) => string): string {
	const words = interfaceText().machines.lead;
	const rows = leaderRows(records, name);
	if (rows.length === 0) return words.listEmpty;
	return [
		words.listHeader,
		...rows.map((row) => words.listRow({ name: row.name, leader: row.leader, goal: row.goal, state: row.state })),
		words.usage,
	].join("\n");
}

/** One goal in full: what was asked, what was held back, and how it stands or ended. */
export function formatLeaderGoal(record: DelegationRecord, name: (alias: string) => string): string {
	const words = interfaceText().machines.lead;
	const { lead, envelope, clipped } = record.charter;
	const row = leaderRow(record, name);
	return [
		words.leads(row.name, lead.goal),
		words.state(row.state, record.closeReason ? words.closeWords[record.closeReason] : undefined),
		record.charter.appointedBy === "root" ? words.appointed : words.standing,
		...(lead.requirements.length
			? [words.requirements, ...lead.requirements.map((requirement) => `  - ${requirement.text}`)]
			: []),
		...(lead.constraints.length ? [words.rules, ...lead.constraints.map((constraint) => `  - ${constraint}`)] : []),
		envelope.writePaths.length ? words.mayChange(envelope.writePaths.join(", ")) : words.readOnly,
		...(envelope.budgetUsd !== undefined ? [words.budget(envelope.budgetUsd.toFixed(2))] : []),
		...(envelope.deadlineAt !== undefined ? [words.stopsAt(envelope.deadlineAt)] : []),
		...(clipped.length ? [words.heldBack, ...clipped.map((item) => `  - ${item}`)] : []),
		...(record.updates.length ? [words.updatesSent(record.updates.length)] : []),
	].join("\n");
}

export async function handleLeadCommand(host: LeaderCommandsHost, text: string): Promise<void> {
	const words = interfaceText().machines.lead;
	const [action = "list", target, ...extra] = text.slice("/lead".length).trim().split(/\s+/).filter(Boolean);
	try {
		const name = (alias: string) => displayName(host, alias);
		const backgroundLanes = host.session.backgroundLanes;
		if (action === "list" && target === undefined) {
			host.showStatus(formatLeaderList(backgroundLanes.leaderDelegations(), name));
			return;
		}
		if (target === undefined || extra.length > 0 || !(ACTIONS as readonly string[]).includes(action)) {
			host.showError(words.usage);
			return;
		}
		if (action === "show") {
			const records = backgroundLanes.leaderDelegations();
			const record =
				currentDelegationFor(records, target) ??
				records.filter((candidate) => candidate.charter.leader === target).at(-1);
			if (record) {
				host.showStatus(formatLeaderGoal(record, name));
				return;
			}
			const notLeader = notALeaderText(host, target);
			host.showStatus(notLeader ?? words.ledNothing(name(target)));
			return;
		}
		const notLeader = notALeaderText(host, target);
		if (notLeader) {
			host.showError(notLeader);
			return;
		}
		const leaders = backgroundLanes.getLeaders();
		const record =
			action === "cancel"
				? await leaders.cancel(target)
				: action === "pause"
					? leaders.pause(target)
					: await leaders.resume(target);
		host.showStatus(words.actionDone(name(target), leaderRow(record, name).state));
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}
