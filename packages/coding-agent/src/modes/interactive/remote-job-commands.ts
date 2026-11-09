/**
 * `/remote` job commands: inspection and owner overrides of remote work placement. Placement itself is automatic; these
 * show what was placed, pin a read-only job on a named machine, stop jobs, and set what a linked machine may do here.
 * Machines are named by their link names only, never by an id.
 */

import { randomUUID } from "node:crypto";
import type { FleetMachine } from "../../core/remote/fleet-machines.ts";
import type { RemoteHubController } from "../../core/remote/hub-controller.ts";
import type { PlacerJobRecord } from "../../core/remote/job-store.ts";
import { placedJobTerminal } from "../../core/remote/outcome-adapter.ts";
import { LINK_PEER_TRUSTS, type LinkPeerSettings, updateLinkPeerSettings } from "../../core/remote/registry.ts";
import type { RemoteJobs } from "../../core/remote/remote-jobs.ts";

export const JOB_USAGE =
	"/remote jobs | /remote run <name> <task> | /remote cancel <name> | /remote hold <name> | /remote release <name> | /remote trust <name> answers|reads|changes | /remote accept <name> on|off | /remote rotate <name>";

const JOB_COMMANDS = new Set(["jobs", "run", "cancel", "hold", "release", "trust", "accept", "rotate"]);
const SHOWN_JOBS = 10;

export function isJobCommand(sub: string): boolean {
	return JOB_COMMANDS.has(sub);
}

interface JobCommandHost {
	showStatus(text: string): void;
	showWarning(text: string): void;
}

function jobWords(record: PlacerJobRecord): string {
	const terminal = placedJobTerminal(record);
	if (terminal) return `${terminal.status}${record.appliedAt === undefined ? ", reporting" : ""}`;
	if (record.state === "pending") return `waiting for ${record.executorName} to take it`;
	return record.progress?.line
		? `${record.progress.phase}: ${record.progress.line}`
		: (record.progress?.phase ?? "taken");
}

/**
 * The placed records this build cannot read, per machine, in plain words. They are kept as they are and count as open jobs; a
 * `/remote cancel <name>` records a stop for each of that machine's. Undefined when there are none.
 */
function unreadableLine(jobs: RemoteJobs): string | undefined {
	const { byMachine, unnamed } = jobs.client.unreadablePlaced();
	const parts = [...byMachine].map(
		([machineId, jobIds]) =>
			`${jobs.machines.get(machineId)?.name ?? "a machine no longer linked"}: ${jobIds.length}`,
	);
	if (unnamed > 0) parts.push(`${unnamed} with no machine named`);
	if (parts.length === 0) return undefined;
	return `Job records this build cannot read, kept as they are and counted as open: ${parts.join(", ")}.`;
}

function jobsText(jobs: RemoteJobs): string {
	const placed = jobs.client.list();
	const lines = placed
		.slice(0, SHOWN_JOBS)
		.map((record) => `- ${record.offer.label} on ${record.executorName}: ${jobWords(record)}`);
	const here = jobs.runningHere();
	const unreadable = unreadableLine(jobs);
	return [
		placed.length > 0 ? `Jobs placed from here (${placed.length}):` : "No jobs placed from here.",
		...lines,
		...(placed.length > SHOWN_JOBS ? [`and ${placed.length - SHOWN_JOBS} older.`] : []),
		...(unreadable ? [unreadable] : []),
		here > 0 ? `Running here for other machines: ${here}.` : "Nothing running here for other machines.",
	].join("\n");
}

async function runJob(jobs: RemoteJobs, machine: FleetMachine, task: string, host: JobCommandHost): Promise<void> {
	const cwd = await jobs.projectOn(machine.machineId);
	const result = await jobs.place(
		machine.machineId,
		{ idempotencyKey: `owner-run:${randomUUID()}`, instructions: task },
		cwd ? { cwd } : {},
	);
	if (result.kind === "refused") return host.showWarning(`${machine.name} was not given the job: ${result.reason}.`);
	host.showStatus(
		`${machine.name} has the job, read-only, ${cwd ? "in its checkout of this project" : "as a question without a checkout (it does not offer this project)"}. Its end reaches this session as a worker report.`,
	);
}

/** Runs one job command; `rest` is the words after the subcommand. */
export async function runJobCommand(
	sub: string,
	rest: readonly string[],
	hub: RemoteHubController,
	host: JobCommandHost,
): Promise<void> {
	const jobs = hub.jobs;
	if (!jobs) return host.showWarning("Remote jobs are not available in this session.");
	if (sub === "jobs") return host.showStatus(jobsText(jobs));
	const name = rest[0] ?? "";
	if (sub === "rotate") {
		const rotated = hub.rotate(name);
		if (!rotated) return host.showWarning(`No machine named ${name} joined this hub.`);
		return host.showStatus(
			`${name} has a new secret and was disconnected; its jobs are kept. On that machine run /remote leave, then:\n/remote join <this-hub-address> ${rotated.token}\nThe token is shown once; keep it private.`,
		);
	}
	const machine = jobs.machines.byName(name);
	if (!machine) return host.showWarning(`No linked machine named ${name} has connected yet. Usage: ${JOB_USAGE}`);
	const setPeer = (change: LinkPeerSettings) => updateLinkPeerSettings(hub.agentDir, machine.machineId, change);
	switch (sub) {
		case "run": {
			const task = rest.slice(1).join(" ").trim();
			if (!task) return host.showWarning("Usage: /remote run <name> <task>");
			return runJob(jobs, machine, task, host);
		}
		case "cancel": {
			const open = jobs.client.list().filter((record) => record.executorId === machine.machineId);
			const stopped = open.filter((record) => jobs.client.cancel(record.jobId)).length;
			// A record this build cannot read is named by its file alone: its stop is kept beside it as a marker, never written into it.
			const unreadable = jobs.client.unreadablePlaced().byMachine.get(machine.machineId) ?? [];
			const recorded = unreadable.filter((jobId) => jobs.client.cancelOn(machine.machineId, jobId, "owner")).length;
			if (stopped === 0 && recorded === 0) return host.showStatus(`No open job on ${machine.name}.`);
			const words = [
				stopped > 0 ? `Stopped ${stopped} job(s) on ${machine.name}.` : undefined,
				recorded > 0
					? `Recorded a stop for ${recorded} job record(s) on ${machine.name} that this build cannot read. The records stay as they are; the placing session ends each job's lane when it next reconciles, and the stop is sent to ${machine.name} when it is connected.`
					: undefined,
			];
			return host.showStatus(words.filter((word) => word !== undefined).join(" "));
		}
		case "hold":
		case "release":
			setPeer({ hold: sub === "hold" });
			return host.showStatus(
				sub === "hold"
					? `No new job goes to ${machine.name}; jobs already there continue.`
					: `${machine.name} can be given jobs again.`,
			);
		case "trust": {
			const trust = LINK_PEER_TRUSTS.find((word) => word === rest[1]);
			if (!trust) return host.showWarning("Usage: /remote trust <name> answers|reads|changes");
			setPeer({ trust });
			return host.showStatus(
				`${machine.name} may ask this machine for ${trust === "answers" ? "answers only" : trust === "reads" ? "answers and reads of its checkouts" : "answers, reads and changes"}.`,
			);
		}
		case "accept": {
			if (rest[1] !== "on" && rest[1] !== "off") return host.showWarning("Usage: /remote accept <name> on|off");
			setPeer({ acceptsJobs: rest[1] === "on" });
			if (rest[1] === "on") jobs.start();
			return host.showStatus(
				rest[1] === "on"
					? `This machine runs jobs ${machine.name} places here.`
					: `This machine takes no new jobs from ${machine.name}; jobs already here finish.`,
			);
		}
	}
}
