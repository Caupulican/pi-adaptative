/**
 * `/lead`: the owner's view of the goals handed to leaders, and the override to cancel, pause or resume one. Leaders
 * work without it; the orchestrator delegates with `bot lead` and hears back once when a goal ends. Reading the goals
 * never builds the worker runtime; only an override does. `/bot lead <id>` is the other command: it makes a bot a
 * standing leader, and `/lead` never does.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { DelegationCloseReason, DelegationRecord } from "../../core/delegation/leader-delegation-ledger.ts";
import { currentDelegationFor, leaderRow, leaderRows } from "../../core/delegation/leader-view.ts";

export interface LeaderCommandsHost {
	readonly session: Pick<AgentSession, "backgroundLanes">;
	showStatus(message: string): void;
	showError(message: string): void;
}

const ACTIONS = ["show", "cancel", "pause", "resume"] as const;
const USAGE =
	"Usage: /lead [list|show <leader>|cancel <leader>|pause <leader>|resume <leader>]. This works on goals handed to leaders; to make a bot a leader, use /bot lead <id>.";

const CLOSE_WORDS: Readonly<Record<DelegationCloseReason, string>> = {
	settled: "the leader finished",
	cancelled: "cancelled",
	deadline: "its time ran out",
	budget: "its budget ran out",
	allowance: "a subscription in use had no allowance left",
	leader_unavailable: "its leader was not available",
};

function displayName(host: LeaderCommandsHost, alias: string): string {
	return host.session.backgroundLanes.getBotTeamStore().getBot(alias)?.displayName ?? alias;
}

/** The reason `/lead` cannot work on this bot, in plain words; undefined when the bot is a leader. */
function notALeaderText(host: LeaderCommandsHost, alias: string): string | undefined {
	const bot = host.session.backgroundLanes.getBotTeamStore().getBot(alias);
	if (!bot) return `There is no bot named ${alias}. Bot names are in /bot list.`;
	if (bot.leader === true) return undefined;
	return `${bot.displayName} is not a leader, so it has no goals to show or override. To make it a leader, use /bot lead ${alias}.`;
}

/** The goals, one line each: who leads, which goal, where it stands, and the name `/lead` takes. */
export function formatLeaderList(records: readonly DelegationRecord[], name: (alias: string) => string): string {
	const rows = leaderRows(records, name);
	if (rows.length === 0)
		return "No goal has been handed to a leader. The orchestrator hands one over with bot lead; /bot lead <id> makes a bot a standing leader.";
	return [
		"Goals handed to leaders:",
		...rows.map((row) => `  ${row.name} (${row.leader}) · ${row.goal} · ${row.state}`),
		USAGE,
	].join("\n");
}

/** One goal in full: what was asked, what was held back, and how it stands or ended. */
export function formatLeaderGoal(record: DelegationRecord, name: (alias: string) => string): string {
	const { lead, envelope, clipped } = record.charter;
	const row = leaderRow(record, name);
	return [
		`${row.name} leads: ${lead.goal}`,
		`State: ${row.state}${record.closeReason ? ` (${CLOSE_WORDS[record.closeReason]})` : ""}`,
		record.charter.appointedBy === "root"
			? "Appointed by the orchestrator for this goal; retired once it ends."
			: "A standing leader the owner made.",
		...(lead.requirements.length
			? ["Must be true at the end:", ...lead.requirements.map((requirement) => `  - ${requirement.text}`)]
			: []),
		...(lead.constraints.length ? ["Rules:", ...lead.constraints.map((constraint) => `  - ${constraint}`)] : []),
		envelope.writePaths.length ? `May change: ${envelope.writePaths.join(", ")}` : "Read-only: no file is changed.",
		...(envelope.budgetUsd !== undefined
			? [
					`Budget: $${envelope.budgetUsd.toFixed(2)} of metered spending. Subscription turns cost nothing in metered terms, so they are not counted in it.`,
				]
			: []),
		...(envelope.deadlineAt !== undefined ? [`Stops at: ${envelope.deadlineAt}`] : []),
		...(clipped.length ? ["Held back:", ...clipped.map((item) => `  - ${item}`)] : []),
		...(record.updates.length ? [`Updates sent: ${record.updates.length}`] : []),
	].join("\n");
}

export async function handleLeadCommand(host: LeaderCommandsHost, text: string): Promise<void> {
	const [action = "list", target, ...extra] = text.slice("/lead".length).trim().split(/\s+/).filter(Boolean);
	try {
		const name = (alias: string) => displayName(host, alias);
		const backgroundLanes = host.session.backgroundLanes;
		if (action === "list" && target === undefined) {
			host.showStatus(formatLeaderList(backgroundLanes.leaderDelegations(), name));
			return;
		}
		if (target === undefined || extra.length > 0 || !(ACTIONS as readonly string[]).includes(action)) {
			host.showError(USAGE);
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
			host.showStatus(notLeader ?? `${name(target)} is a leader and has led no goal yet.`);
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
		host.showStatus(`${name(target)}: ${leaderRow(record, name).state}.`);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}
