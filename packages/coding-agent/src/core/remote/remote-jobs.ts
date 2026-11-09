/**
 * A session's remote work placement: the placer client, the job runner, the roster's words from facts and the fleet's
 * remote room, composed once per session and owned by its hub controller. Nothing here starts until the owner linked
 * this machine (a hub turned on, a hub joined, or a peer allowed to place jobs); then it starts watchers and a lock
 * only, never a child process. The session's worker ports reach it from the background lane controller.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ManagedLaneView } from "../delegation/managed-lane-views.ts";
import type { PersistentBotLiveState } from "../delegation/persistent-bot-team-store.ts";
import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import { MAX_ADVERT_MODELS, type ModelFact, WIRE_WORD } from "./capabilities.ts";
import { type FleetMachine, FleetMachines } from "./fleet-machines.ts";
import { type PlaceOptions, type PlaceResult, RemoteJobClient, type RemotePlacementSession } from "./job-client.ts";
import { JobRunner, type JobRunnerSession } from "./job-runner.ts";
import { activeExecutorJobs, JobStore, type PlacerJobRecord } from "./job-store.ts";
import { listJoins, loadLinkSettings, type MachineIdentity } from "./registry.ts";
import { resolveRepoIdentity } from "./repo-identity.ts";

/** The session's worker surface, structurally the background lane controller's own methods. */
export type RemoteJobSession = JobRunnerSession & RemotePlacementSession;

export interface RemoteJobPorts {
	readonly session: RemoteJobSession;
	readonly sessionId: () => string;
	/** The session's directory: a job placed without one names this project, when the peer has it checked out. */
	readonly cwd: () => string;
	/** The models this session can run, for the advert's provider classes (never an account or a key). */
	readonly models: () => readonly Model<Api>[];
	readonly usesSubscription: (model: Model<Api>) => boolean;
	/** The fleet the remote room registers with; materialized only once a peer has advertised. */
	readonly fleet?: () => { registerCapacitySource(source: PlacementCapacitySource): () => void };
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama-cpp", "llamacpp", "vllm", "local"]);

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

	/** Whether the owner linked this machine at all: a hub joined, or a peer allowed to place jobs here. */
	static linked(agentDir: string): boolean {
		const settings = loadLinkSettings(agentDir);
		return listJoins(agentDir).length > 0 || Object.values(settings.peers).some((peer) => peer.acceptsJobs === true);
	}

	/**
	 * Starts placement and the roster's facts once, and the runner whenever the machine is linked by now: a hub joined or
	 * a peer allowed mid-session arms it at the next call. Idempotent.
	 */
	start(): void {
		if (!this.started) {
			this.started = true;
			this.client.start();
			this.stopFleet = this.machines.subscribe(() => {
				this.registerCapacity();
				this.onRosterChange();
			});
			this.registerCapacity();
		}
		if (RemoteJobs.linked(this.agentDir)) this.armRunner();
	}

	/** Takes the runner role for this agent directory, or waits for the session holding it. */
	armRunner(): void {
		this.runner ??= new JobRunner({
			agentDir: this.agentDir,
			session: this.ports.session,
			models: () => modelFacts(this.ports.models(), this.ports.usesSubscription),
			room: () => loadLinkSettings(this.agentDir).jobRoom,
		});
		this.runner.arm();
	}

	dispose(): void {
		this.started = false;
		this.stopFleet?.();
		this.stopFleet = undefined;
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

	/** Registers each advertised machine's room with the fleet once, so the scheduler sees remote room. */
	private registerCapacity(): void {
		const fleet = this.ports.fleet;
		if (!fleet) return;
		for (const machine of this.machines.list()) {
			if (!machine.facts || this.capacity.has(machine.machineId)) continue;
			const machineId = machine.machineId;
			try {
				this.capacity.set(
					machineId,
					fleet().registerCapacitySource({
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
		const open = machine ? this.openJobsOn(machine.machineId).length : 0;
		if (!connected)
			return {
				state: "offline",
				...(open > 0 ? { currentSummary: `offline, ${plural(open, "job")} waiting` } : {}),
			};
		if (open > 0) return { state: "running", currentSummary: `working on ${plural(open, "job")}` };
		const facts = machine?.facts;
		if (!facts) return { state: "idle" };
		if (!facts.accepts.jobs) return { state: "idle", currentSummary: "takes no jobs now" };
		return { state: "idle", currentSummary: facts.room > 0 ? `ready, ${facts.room} free` : "full" };
	}

	/** A placed job's worker row: the job's own words and where it runs, never an id. */
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
					: `on ${record.executorName}`;
		return { ...view, label: `${record.offer.label} · ${where}` };
	}
}
