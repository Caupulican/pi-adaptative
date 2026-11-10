/**
 * `/remote` job commands: inspection and owner overrides of remote work placement. Placement itself is automatic; these
 * show what was placed, pin a read-only job on a named machine, stop jobs, and set what a linked machine may do here.
 * Machines are named by their link names only, never by an id.
 */

import { randomUUID } from "node:crypto";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { FleetMachine } from "../../core/remote/fleet-machines.ts";
import type { RemoteHubController } from "../../core/remote/hub-controller.ts";
import type { PlacerJobRecord } from "../../core/remote/job-store.ts";
import { placedJobTerminal } from "../../core/remote/outcome-adapter.ts";
import { LINK_PEER_TRUSTS, type LinkPeerSettings, updateLinkPeerSettings } from "../../core/remote/registry.ts";
import type { RemoteJobs } from "../../core/remote/remote-jobs.ts";

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
	const words = interfaceText().machines.jobs;
	const terminal = placedJobTerminal(record);
	if (terminal) return record.appliedAt === undefined ? words.reporting(terminal.status) : terminal.status;
	if (record.state === "pending") return words.waitingFor(record.executorName);
	return record.progress?.line
		? words.progress(record.progress.phase, record.progress.line)
		: (record.progress?.phase ?? words.taken);
}

/**
 * The placed records this build cannot read, per machine, in plain words. They are kept as they are and count as open jobs; a
 * `/remote cancel <name>` records a stop for each of that machine's. Undefined when there are none.
 */
function unreadableLine(jobs: RemoteJobs): string | undefined {
	const words = interfaceText().machines.jobs;
	const { byMachine, unnamed } = jobs.client.unreadablePlaced();
	const parts = [...byMachine].map(([machineId, jobIds]) =>
		words.unreadablePart(jobs.machines.get(machineId)?.name ?? words.unreadableUnnamedMachine, jobIds.length),
	);
	if (unnamed > 0) parts.push(words.unreadableUnnamed(unnamed));
	if (parts.length === 0) return undefined;
	return words.unreadableLine(parts.join(", "));
}

function jobsText(jobs: RemoteJobs): string {
	const words = interfaceText().machines.jobs;
	const placed = jobs.client.list();
	const lines = placed
		.slice(0, SHOWN_JOBS)
		.map((record) => words.row(record.offer.label, record.executorName, jobWords(record)));
	const here = jobs.runningHere();
	const unreadable = unreadableLine(jobs);
	return [
		placed.length > 0 ? words.placed(placed.length) : words.nonePlaced,
		...lines,
		...(placed.length > SHOWN_JOBS ? [words.older(placed.length - SHOWN_JOBS)] : []),
		...(unreadable ? [unreadable] : []),
		here > 0 ? words.runningHere(here) : words.nothingRunningHere,
	].join("\n");
}

async function runJob(jobs: RemoteJobs, machine: FleetMachine, task: string, host: JobCommandHost): Promise<void> {
	const words = interfaceText().machines.jobs;
	const cwd = await jobs.projectOn(machine.machineId);
	const result = await jobs.place(
		machine.machineId,
		{ idempotencyKey: `owner-run:${randomUUID()}`, instructions: task },
		cwd ? { cwd } : {},
	);
	if (result.kind === "refused") return host.showWarning(words.refused(machine.name, result.reason));
	host.showStatus(words.accepted(machine.name, cwd ? words.inCheckout : words.noCheckout));
}

/** Runs one job command; `rest` is the words after the subcommand. */
export async function runJobCommand(
	sub: string,
	rest: readonly string[],
	hub: RemoteHubController,
	host: JobCommandHost,
): Promise<void> {
	const words = interfaceText().machines.jobs;
	const jobs = hub.jobs;
	if (!jobs) return host.showWarning(words.unavailable);
	if (sub === "jobs") return host.showStatus(jobsText(jobs));
	const name = rest[0] ?? "";
	if (sub === "rotate") {
		const rotated = hub.rotate(name);
		if (!rotated) return host.showWarning(words.rotateUnknown(name));
		return host.showStatus(words.rotated(name, rotated.token));
	}
	const machine = jobs.machines.byName(name);
	if (!machine) return host.showWarning(words.unknownMachine(name, words.usage));
	const setPeer = (change: LinkPeerSettings) => updateLinkPeerSettings(hub.agentDir, machine.machineId, change);
	switch (sub) {
		case "run": {
			const task = rest.slice(1).join(" ").trim();
			if (!task) return host.showWarning(words.runUsage);
			return runJob(jobs, machine, task, host);
		}
		case "cancel": {
			const open = jobs.client.list().filter((record) => record.executorId === machine.machineId);
			const stopped = open.filter((record) => jobs.client.cancel(record.jobId)).length;
			// A record this build cannot read is named by its file alone: its stop is kept beside it as a marker, never written into it.
			const unreadable = jobs.client.unreadablePlaced().byMachine.get(machine.machineId) ?? [];
			const recorded = unreadable.filter((jobId) => jobs.client.cancelOn(machine.machineId, jobId, "owner")).length;
			if (stopped === 0 && recorded === 0) return host.showStatus(words.noOpenJob(machine.name));
			const parts = [
				stopped > 0 ? words.stopped(stopped, machine.name) : undefined,
				recorded > 0 ? words.stopRecorded(recorded, machine.name) : undefined,
			];
			return host.showStatus(parts.filter((part) => part !== undefined).join(" "));
		}
		case "hold":
		case "release":
			setPeer({ hold: sub === "hold" });
			return host.showStatus(sub === "hold" ? words.held(machine.name) : words.released(machine.name));
		case "trust": {
			const trust = LINK_PEER_TRUSTS.find((word) => word === rest[1]);
			if (!trust) return host.showWarning(words.trustUsage);
			setPeer({ trust });
			return host.showStatus(
				trust === "answers"
					? words.trustAnswers(machine.name)
					: trust === "reads"
						? words.trustReads(machine.name)
						: words.trustChanges(machine.name),
			);
		}
		case "accept": {
			if (rest[1] !== "on" && rest[1] !== "off") return host.showWarning(words.acceptUsage);
			setPeer({ acceptsJobs: rest[1] === "on" });
			if (rest[1] === "on") jobs.start();
			return host.showStatus(rest[1] === "on" ? words.accepts(machine.name) : words.refuses(machine.name));
		}
	}
}
