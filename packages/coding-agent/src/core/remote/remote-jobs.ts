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
import type { RemoteBackendPort } from "../fleet/remote-admit.ts";
import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import type { RemotePlacementSession } from "./abandoned-placements.ts";
import { isOneOf, MAX_ADVERT_MODELS, type ModelFact, WIRE_WORD } from "./capabilities.ts";
import { type FleetMachine, FleetMachines } from "./fleet-machines.ts";
import { type PlaceOptions, type PlaceResult, type PreparedOffer, RemoteJobClient } from "./job-client.ts";
import { JOB_CANCEL_REASONS, type JobCancelReason } from "./job-protocol.ts";
import { JobRunner, type JobRunnerSession } from "./job-runner.ts";
import {
	activeExecutorJobs,
	inDir,
	JobStore,
	outDir,
	type PlacerJobRecord,
	unreadableHoldingRoom,
} from "./job-store.ts";
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

/** The fleet a session's remote machines register with (`attachFleet`): their room, and this session's placement backend. */
export interface RemoteRoomFleet {
	registerCapacitySource(source: PlacementCapacitySource): () => void;
	registerRemoteBackend(port: RemoteBackendPort): () => void;
}

/** A remote task id or a remote lane id: `remote-<jobId>`, with the `:turn:<n>` a placed job's task adds. */
const REMOTE_TASK_ID = /^remote-([A-Za-z0-9_-]{1,64})(?::turn:\d+)?$/;

/**
 * The job protocol's reason for a fleet cancel: the fleet's own reason (a plan's close, join or step end) when the protocol
 * names it. A reason it does not name ends the job as `superseded`, and the rename is logged rather than silent.
 */
function jobCancelReasonOf(reasonCode: string): JobCancelReason {
	if (isOneOf(JOB_CANCEL_REASONS, reasonCode)) return reasonCode;
	harnessLog.warn("placement", "a placed job was cancelled for a reason the job protocol does not name", {
		reasonCode,
	});
	return "superseded";
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama-cpp", "llamacpp", "vllm", "local"]);
/**
 * The mark of a bot that lives on another machine (a joined machine's bot rows) and of a job another machine runs: a
 * computer, readable at a glance. The one definition; the interactive bot views re-export it.
 */
export const REMOTE_MARK = "💻";
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
	/** This session's placement backend in the fleet, while the machine is linked: removed when the link is gone. */
	private unregisterBackend: (() => void) | undefined;
	/** The offers prepared for the fleet, by dispatch key: committed by its admit, released by its release. */
	private readonly offers = new Map<string, PreparedOffer>();
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
		this.syncBackend();
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
		this.dropBackend();
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
		return activeExecutorJobs(this.store, Date.now(), loadLinkSettings(this.agentDir).offlineHoldMs);
	}

	/**
	 * Gives the session's fleet the room of every advertised machine, once each, so the scheduler sees remote room for a
	 * plan node or a placed job. Called when the fleet is first reached (`attachFleet`) and on every change of the machines.
	 */
	attachFleet(fleet: RemoteRoomFleet): void {
		if (this.fleet === fleet) return;
		this.dropBackend();
		this.fleet = fleet;
		this.registerCapacity();
		this.syncBackend();
	}

	/**
	 * Registers this session's placement backend with the fleet while the machine is linked, so a plan step or a placed job can
	 * be offered to a linked machine; once no link is left, the backend is removed and nothing is offered.
	 */
	private syncBackend(): void {
		const fleet = this.fleet;
		// Registration waits for `start`, the only point the link watch that removes it is running.
		if (!fleet || !this.started) return;
		if (!RemoteJobs.linked(this.agentDir)) this.dropBackend();
		else this.unregisterBackend ??= fleet.registerRemoteBackend(this.backendPort());
	}

	/** Unregisters the placement backend and forgets its prepared offers: a link that is gone offers nothing. */
	private dropBackend(): void {
		this.unregisterBackend?.();
		this.unregisterBackend = undefined;
		this.offers.clear();
	}

	/**
	 * The fleet's view of a linked machine: linked, held and online from the link's records and the machine's record; the job
	 * offer is prepared here and committed by the fleet's admit. A remote task or lane id is cancelled here, never locally.
	 */
	private backendPort(): RemoteBackendPort {
		return {
			status: (machineId) => {
				const machine = this.machines.get(machineId);
				const settings = loadLinkSettings(this.agentDir);
				return {
					linked: machine !== undefined,
					held: settings.peers[machineId]?.hold === true,
					online: machine?.online === true,
					offlineHoldMs: settings.offlineHoldMs,
				};
			},
			prepare: async (dispatch, machineId, signal) => {
				const prepared = await this.client.prepareOffer(
					dispatch,
					{ kind: "remote_machine", machineId },
					{ cwd: this.ports.cwd(), ...(dispatch.brief?.goal ? { label: dispatch.brief.goal } : {}) },
				);
				// An abort is the caller's own stop, not a refusal: the plan executor reports nothing for it.
				signal?.throwIfAborted();
				// A refusal drops any offer this key still holds: nothing prepared under it outlives the refusal.
				if (prepared.kind === "refused") {
					this.offers.delete(dispatch.idempotencyKey);
					return { ok: false, code: prepared.code, detail: prepared.reason };
				}
				this.offers.set(dispatch.idempotencyKey, prepared);
				return { ok: true };
			},
			commit: (dispatch, machineId) => {
				const key = dispatch.idempotencyKey;
				const prepared = this.offers.get(key);
				// An offer is for the machine it was prepared on; a commit to another machine finds none here.
				if (!prepared || (prepared.kind === "offer" && prepared.machine.machineId !== machineId))
					return { kind: "not_prepared" };
				const commit = this.client.commitOffer(prepared);
				// The runtime's replacement keeps the offer: the next admit commits it.
				if (commit.kind === "runtime_replacing") return commit;
				this.offers.delete(key);
				if (commit.kind === "attempt_unknown") return commit;
				if (commit.kind === "refused") return { kind: "refused", code: commit.code, detail: commit.reason };
				return {
					kind: "placed",
					taskId: commit.taskId,
					attemptId: commit.attemptId,
					laneId: commit.record.laneId,
				};
			},
			boundMachine: (idempotencyKey) => this.client.boundMachine(idempotencyKey),
			release: (key) => {
				this.offers.delete(key);
			},
			cancel: (id, reasonCode) => {
				const jobId = REMOTE_TASK_ID.exec(id)?.[1];
				// Only a job this machine placed is cancelled here; any other id stays with the local lanes.
				if (jobId === undefined || !this.client.placedHere(jobId)) return false;
				this.client.cancel(jobId, jobCancelReasonOf(reasonCode));
				return true;
			},
			cancelPlan: (planId, reasonCode) => this.client.cancelPlan(planId, jobCancelReasonOf(reasonCode)),
		};
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
							// Jobs placed here and not sent yet will take that room, so they are not offered twice.
							const slots = current.facts?.accepts.jobs
								? Math.max(0, current.facts.room - this.client.pendingCount(machineId))
								: 0;
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

	/**
	 * Jobs this machine placed on `machineId` that have not ended: the readable records, and the unreadable records its file names
	 * for it. An unreadable record may be open, so it is counted; its words and creation time are unknown.
	 */
	private openJobsOn(machineId: string): {
		readonly records: readonly PlacerJobRecord[];
		readonly unreadable: number;
	} {
		const pass = this.store.placedScan();
		const holdMs = loadLinkSettings(this.agentDir).offlineHoldMs;
		return {
			records: [...pass.valid.values()].filter(
				(record) => record.executorId === machineId && record.appliedAt === undefined && !record.ending,
			),
			unreadable: unreadableHoldingRoom(pass.unreadable, Date.now(), holdMs, "placer").filter(
				(entry) => entry.machineId === machineId,
			).length,
		};
	}

	/** The roster row of the machine named `name`, from its facts and the jobs placed there. */
	rosterWords(name: string, connected: boolean): RemoteRosterWords {
		const machine = this.machines.byName(name);
		const open: { readonly records: readonly PlacerJobRecord[]; readonly unreadable: number } = machine
			? this.openJobsOn(machine.machineId)
			: { records: [], unreadable: 0 };
		const count = open.records.length + open.unreadable;
		if (!connected)
			return {
				state: "offline",
				...(count > 0 ? { currentSummary: `offline, ${plural(count, "job")} waiting` } : {}),
			};
		if (count > 0) {
			this.scheduleRosterTick();
			// The duration is the oldest readable job's; with only unreadable records there is none to measure.
			const since =
				open.records.length > 0 ? Math.min(...open.records.map((record) => record.createdAt)) : undefined;
			return {
				state: "running",
				currentSummary:
					since === undefined
						? `working on ${plural(count, "job")}`
						: `working on ${plural(count, "job")} for ${runningFor(since)}`,
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
		return { ...view, label: `${REMOTE_MARK} ${record.offer.label} · ${where}` };
	}
}
