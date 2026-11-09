/**
 * A session's remote work placement: the placer client, the job runner, the roster's words from facts and the fleet's
 * remote room, composed once per session and owned by its hub controller. Nothing here starts until the owner linked
 * this machine (a hub turned on, a hub joined, or a peer allowed to place jobs); then it starts watchers and a lock
 * only, never a child process. The session's worker ports reach it from the background lane controller.
 *
 * The roster's words come from facts that change under this session: the fleet's machine records, the job stores and
 * the link's settings. Each change reaches the roster through a watch (`DirectoryWatch`, `FleetMachines`), never by a
 * poll; a running job's duration is re-read on a one-minute alarm while a job runs.
 */

import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import { alarmAt, SYSTEM_TIMER_PORT, type WallAlarm } from "../../kernel/timer-port.ts";
import type { ManagedLaneView } from "../delegation/managed-lane-views.ts";
import type { PersistentBotLiveState } from "../delegation/persistent-bot-team-store.ts";
import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import { MAX_ADVERT_MODELS, type ModelFact, WIRE_WORD } from "./capabilities.ts";
import { type FleetMachine, FleetMachines } from "./fleet-machines.ts";
import { type PlaceOptions, type PlaceResult, RemoteJobClient, type RemotePlacementSession } from "./job-client.ts";
import { JobRunner, type JobRunnerSession } from "./job-runner.ts";
import { activeExecutorJobs, inDir, JobStore, outDir, type PlacerJobRecord } from "./job-store.ts";
import { hubTurnedOn, listJoins, loadLinkSettings, type MachineIdentity } from "./registry.ts";
import { resolveRepoIdentity } from "./repo-identity.ts";
import { DirectoryWatch } from "./store-watch.ts";

/** The session's worker surface, structurally the background lane controller's own methods. */
export type RemoteJobSession = JobRunnerSession & RemotePlacementSession;

export interface RemoteJobPorts {
	/** Told on every change of the job stores, from any process: a session settles the terminals it still holds. */
	readonly onJobsChanged?: () => void;
	readonly session: RemoteJobSession;
	readonly sessionId: () => string;
	/** The session's directory: a job placed without one names this project, when the peer has it checked out. */
	readonly cwd: () => string;
	/** The models this session can run, for the advert's provider classes (never an account or a key). */
	readonly models: () => readonly Model<Api>[];
	readonly usesSubscription: (model: Model<Api>) => boolean;
}

/** The fleet a session's remote machines' room registers with (`attachFleet`). */
export interface RemoteRoomFleet {
	registerCapacitySource(source: PlacementCapacitySource): () => void;
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama-cpp", "llamacpp", "vllm", "local"]);
/** The mark of a job another machine runs, the same computer the bot rows of remote machines carry. */
export const REMOTE_WORKER_MARK = "💻";
/** How often a roster with a running job re-reads its duration. */
const ROSTER_TICK_MS = 60_000;

/** The advert's model facts: provider and model class words, the access kind, and no headroom claim this build cannot read. */
export function modelFacts(
	models: readonly Model<Api>[],
	usesSubscription: (model: Model<Api>) => boolean,
): ModelFact[] {
	const facts = new Map<string, ModelFact>();
	for (const model of models) {
		const provider = model.provider.toLowerCase();
		const modelClass = model.id.toLowerCase();
		if (!WIRE_WORD.test(provider) || !WIRE_WORD.test(modelClass)) continue;
		facts.set(`${provider}/${modelClass}`, {
			provider,
			modelClass,
			access: LOCAL_PROVIDERS.has(provider) ? "local" : usesSubscription(model) ? "subscription" : "api",
			headroom: "unknown",
		});
	}
	return [...facts.values()].slice(0, MAX_ADVERT_MODELS);
}

/** What a remote machine's roster row says, from facts: its state and a few plain words. */
export interface RemoteRosterWords {
	readonly state: PersistentBotLiveState;
	readonly currentSummary?: string;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** How long a job has been running, in plain words: seconds, minutes, then hours and minutes. */
export function runningFor(since: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - since) / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export class RemoteJobs {
	private readonly agentDir: string;
	private readonly ports: RemoteJobPorts;
	readonly machines: FleetMachines;
	readonly client: RemoteJobClient;
	private readonly store: JobStore;
	private runner: JobRunner | undefined;
	private readonly capacity = new Map<string, () => void>();
	private readonly onRosterChange: () => void;
	private stopFleet: (() => void) | undefined;
	private jobsWatch: DirectoryWatch | undefined;
	private linkWatch: DirectoryWatch | undefined;
	private rosterTick: WallAlarm | undefined;
	/** The session's fleet, once its worker runtime exists; the remote room registers with it from then on. */
	private fleet: RemoteRoomFleet | undefined;
	private started = false;

	constructor(agentDir: string, identity: () => MachineIdentity, ports: RemoteJobPorts, onRosterChange: () => void) {
		this.agentDir = agentDir;
		this.ports = ports;
		this.machines = new FleetMachines(agentDir);
		this.store = new JobStore(agentDir);
		this.client = new RemoteJobClient({
			agentDir,
			selfId: () => identity().machineId,
			sessionId: ports.sessionId,
			session: ports.session,
			machines: this.machines,
		});
		this.onRosterChange = onRosterChange;
	}

	/** Whether the owner linked this machine at all: a hub on, a hub joined, or a peer allowed to place jobs here. */
	static linked(agentDir: string): boolean {
		const settings = loadLinkSettings(agentDir);
		return (
			hubTurnedOn(agentDir) ||
			listJoins(agentDir).length > 0 ||
			Object.values(settings.peers).some((peer) => peer.acceptsJobs === true)
		);
	}

	/**
	 * Starts placement, the roster's watches and the link's runner state once; the runner follows the link from then on
	 * (`refreshLink`). Idempotent. Nothing here reaches the fleet or builds the worker runtime.
	 */
	start(): void {
		if (!this.started) {
			this.started = true;
			this.client.start();
			this.stopFleet = this.machines.subscribe(() => {
				this.registerCapacity();
				this.onRosterChange();
			});
			// A job's end or a placed job's change is written by a process that may not be this one: the stores are watched.
			this.jobsWatch = new DirectoryWatch([outDir(this.agentDir), inDir(this.agentDir)], () => {
				this.onRosterChange();
				this.ports.onJobsChanged?.();
			});
			this.jobsWatch.start();
			this.linkWatch = new DirectoryWatch([join(this.agentDir, "remote")], () => this.refreshLink());
			this.linkWatch.start();
		}
		this.refreshLink();
	}

	/**
	 * Arms the runner while the machine is linked, and lets it go once nothing links it: at once when no job runs, else when
	 * the last running job ends. Called on start and on every change to the link's records.
	 */
	refreshLink(): void {
		if (!this.started) return;
		if (RemoteJobs.linked(this.agentDir)) this.armRunner();
		else this.runner?.retire();
	}

	/** Takes the runner role for this agent directory, or waits for the session holding it. */
	armRunner(): void {
		if (!this.runner || this.runner.retired) {
			this.runner = new JobRunner({
				agentDir: this.agentDir,
				session: this.ports.session,
				models: () => modelFacts(this.ports.models(), this.ports.usesSubscription),
				room: () => loadLinkSettings(this.agentDir).jobRoom,
			});
		}
		this.runner.arm();
	}

	dispose(): void {
		this.started = false;
		this.stopFleet?.();
		this.stopFleet = undefined;
		this.jobsWatch?.stop();
		this.jobsWatch = undefined;
		this.linkWatch?.stop();
		this.linkWatch = undefined;
		this.rosterTick?.stop();
		this.rosterTick = undefined;
		for (const unregister of this.capacity.values()) unregister();
		this.capacity.clear();
		this.client.dispose();
		this.runner?.dispose();
		this.runner = undefined;
	}

	place(
		machineId: string,
		dispatch: { idempotencyKey: string; instructions: string },
		options?: PlaceOptions,
	): Promise<PlaceResult> {
		this.start();
		return this.client.place({ ...dispatch, writeScope: [] }, { kind: "remote_machine", machineId }, options);
	}

	/** The session's directory when `machineId` offers its project, so an owner's job runs in that checkout. */
	async projectOn(machineId: string): Promise<string | undefined> {
		const cwd = this.ports.cwd();
		const identity = await resolveRepoIdentity(cwd);
		const offered = this.machines
			.get(machineId)
			?.facts?.checkouts.some((checkout) => checkout.repoKey === identity?.repoKey);
		return identity && offered ? cwd : undefined;
	}

	/** Jobs other machines placed here that have not finished. */
	runningHere(): number {
		return activeExecutorJobs(this.store);
	}

	/**
	 * Gives the session's fleet the room of every advertised machine, once each, so the scheduler sees remote room for a
	 * plan node or a placed job. Called when the fleet is first reached (`attachFleet`) and on every change of the machines.
	 */
	attachFleet(fleet: RemoteRoomFleet): void {
		if (this.fleet === fleet) return;
		this.fleet = fleet;
		this.registerCapacity();
	}

	private registerCapacity(): void {
		const fleet = this.fleet;
		if (!fleet) return;
		for (const machine of this.machines.list()) {
			if (!machine.facts || this.capacity.has(machine.machineId)) continue;
			const machineId = machine.machineId;
			try {
				this.capacity.set(
					machineId,
					fleet.registerCapacitySource({
						key: `machine:${machineId}`,
						room: () => {
							const current = this.machines.get(machineId);
							if (!current?.online) return { slots: 0, reason: "placement_offline" };
							const slots = current.facts?.accepts.jobs ? current.facts.room : 0;
							return slots > 0 ? { slots } : { slots: 0, reason: "placement_room" };
						},
						subscribe: (onChange) => this.machines.subscribe(onChange),
					}),
				);
			} catch (error) {
				harnessLog.warn("placement", "a linked machine's room could not be given to the fleet", {
					peer: machineId,
					reason: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}

	/** Jobs this machine placed on `machineId` that have not ended. */
	private openJobsOn(machineId: string): PlacerJobRecord[] {
		return this.store.out
			.list()
			.filter((record) => record.executorId === machineId && record.appliedAt === undefined && !record.ending);
	}

	/** The roster row of the machine named `name`, from its facts and the jobs placed there. */
	rosterWords(name: string, connected: boolean): RemoteRosterWords {
		const machine = this.machines.byName(name);
		const open = machine ? this.openJobsOn(machine.machineId) : [];
		if (!connected)
			return {
				state: "offline",
				...(open.length > 0 ? { currentSummary: `offline, ${plural(open.length, "job")} waiting` } : {}),
			};
		if (open.length > 0) {
			this.scheduleRosterTick();
			const since = Math.min(...open.map((record) => record.createdAt));
			return {
				state: "running",
				currentSummary: `working on ${plural(open.length, "job")} for ${runningFor(since)}`,
			};
		}
		const facts = machine?.facts;
		if (!facts) return { state: "idle" };
		if (!facts.accepts.jobs) return { state: "idle", currentSummary: "takes no jobs now" };
		// A machine whose projects are none of them set up refuses a project job until the owner readies one.
		if (facts.checkouts.length > 0 && !facts.checkouts.some((checkout) => checkout.ready))
			return { state: "idle", currentSummary: "needs setup before it takes a project" };
		return { state: "idle", currentSummary: facts.room > 0 ? `ready, ${facts.room} free` : "full" };
	}

	/** A running job's duration is re-read once a minute, through the roster's own change path. */
	private scheduleRosterTick(): void {
		if (this.rosterTick) return;
		this.rosterTick = alarmAt(SYSTEM_TIMER_PORT, Date.now() + ROSTER_TICK_MS, () => {
			this.rosterTick = undefined;
			this.onRosterChange();
		});
	}

	/** A placed job's worker row: the job's own words, where it runs and for how long; never an id. */
	describeLane(view: ManagedLaneView): ManagedLaneView {
		if (!view.laneId.startsWith("remote-")) return view;
		const record = this.store.out.list().find((entry) => entry.laneId === view.laneId);
		if (!record) return view;
		const machine: FleetMachine | undefined = this.machines.get(record.executorId);
		const where =
			machine && !machine.online
				? `waiting for ${record.executorName} to come back`
				: record.state === "pending"
					? `waiting for ${record.executorName} to take it`
					: `on ${record.executorName} for ${runningFor(record.createdAt)}`;
		return { ...view, label: `${REMOTE_WORKER_MARK} ${record.offer.label} · ${where}` };
	}
}
