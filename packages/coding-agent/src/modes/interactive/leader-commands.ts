/**
 * `/lead`: the owner's view of the goals handed to leaders, and the override to cancel, pause or resume one. Leaders
 * work without it; the orchestrator delegates with `bot lead` and hears back once when a goal ends.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { DelegationCloseReason, DelegationRecord } from "../../core/delegation/leader-delegation-ledger.ts";
import { leaderRow, leaderRows } from "../../core/delegation/leader-view.ts";

export interface LeaderCommandsHost {
	readonly session: Pick<AgentSession, "backgroundLanes">;
	showStatus(message: string): void;
	showError(message: string): void;
}

const USAGE = "Usage: /lead [list|show <leader>|cancel <leader>|pause <leader>|resume <leader>]";

const CLOSE_WORDS: Readonly<Record<DelegationCloseReason, string>> = {
	settled: "the leader finished",
	cancelled: "cancelled",
	deadline: "its time ran out",
	budget: "its budget ran out",
	leader_unavailable: "its leader was not available",
};

function displayName(host: LeaderCommandsHost, alias: string): string {
	return host.session.backgroundLanes.getBotTeamStore().getBot(alias)?.displayName ?? alias;
}

/** The goals, one line each: who leads, which goal, where it stands, and the name `/lead` takes. */
export function formatLeaderList(records: readonly DelegationRecord[], name: (alias: string) => string): string {
	const rows = leaderRows(records, name);
	if (rows.length === 0) return "No goal has been handed to a leader. The orchestrator hands one over with bot lead.";
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
		...(envelope.budgetUsd !== undefined ? [`Budget: $${envelope.budgetUsd.toFixed(2)}`] : []),
		...(envelope.deadlineAt !== undefined ? [`Stops at: ${envelope.deadlineAt}`] : []),
		...(clipped.length ? ["Held back:", ...clipped.map((item) => `  - ${item}`)] : []),
		...(record.updates.length ? [`Updates sent: ${record.updates.length}`] : []),
	].join("\n");
}

export async function handleLeadCommand(host: LeaderCommandsHost, text: string): Promise<void> {
	const [action = "list", target, ...extra] = text.slice("/lead".length).trim().split(/\s+/).filter(Boolean);
	try {
		const leaders = host.session.backgroundLanes.getLeaders();
		const name = (alias: string) => displayName(host, alias);
		if (action === "list" && target === undefined) {
			host.showStatus(formatLeaderList(leaders.snapshot(), name));
			return;
		}
		if (target === undefined || extra.length > 0 || !["show", "cancel", "pause", "resume"].includes(action)) {
			host.showError(USAGE);
			return;
		}
		if (action === "show") {
			const record =
				leaders.currentFor(target) ??
				leaders
					.snapshot()
					.filter((candidate) => candidate.charter.leader === target)
					.at(-1);
			host.showStatus(record ? formatLeaderGoal(record, name) : `${name(target)} has led no goal.`);
			return;
		}
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
