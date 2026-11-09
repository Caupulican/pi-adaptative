/**
 * The placer's side in the session that places a job: `place` checks the target from facts, writes the job's managed
 * lane (the remote kind: provider `link`, read tools only, no write paths) and its pending record, and returns a handle.
 * The record is the non-host queue: whichever process holds the link to the executor sends it (`job-transport.ts`), so
 * a session that does not host the hub places exactly like the one that does. The end is applied here, by the owning
 * session only, at most once: the executor's outcome, a refusal, or an end the placer observes itself (the deadline,
 * the offline hold, a revoke, the owner's cancel). The managed lane then emits the terminal notification to this
 * session like any other worker. Everything is driven by store and fleet events and wall alarms; nothing polls.
 */

import { createHash, randomUUID } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import { alarmAt, SYSTEM_TIMER_PORT, type TimerPort, type WallAlarm } from "../../kernel/timer-port.ts";
import type { ManagedLaneBinding } from "../delegation/worker-lifecycle.ts";
import { ManagedLaneRuntimeAdmissionError } from "../extensions/managed-lane-records.ts";
import type { FleetDispatch } from "../fleet/fleet-types.ts";
import type { RemoteRefusalCode } from "../fleet/remote-admit.ts";
import type { Placement } from "../placement/placement-types.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { boundedLine } from "../util/bounded-line.ts";
import {
	endAbandonedPlacement,
	endAbandonedPlacements,
	endMarkedPlacement,
	placedJobLaneBinding,
	type RemotePlacementSession,
	remoteJobAuthorization,
	remoteJobLaneId,
} from "./abandoned-placements.ts";
import type { FleetMachine, FleetMachines } from "./fleet-machines.ts";
import {
	boundedJobSummary,
	digestOffer,
	digestOutcome,
	type JobCancelReason,
	type JobOffer,
	type JobOutcome,
	type JobPhase,
	MAX_JOB_DEADLINE_MS,
	MAX_JOB_INSTRUCTIONS_BYTES,
	MAX_JOB_LABEL_CHARS,
	MIN_JOB_DEADLINE_MS,
} from "./job-protocol.ts";
import {
	type CancelMark,
	endingOfCancel,
	JobStore,
	journalJob,
	outDir,
	type PlacementKey,
	type PlacerEnding,
	type PlacerJobRecord,
	type RecordCreate,
	type RecordRead,
} from "./job-store.ts";
import { placedJobTerminal } from "./outcome-adapter.ts";
import { loadLinkSettings } from "./registry.ts";
import { resolveRepoIdentity } from "./repo-identity.ts";
import { DirectoryWatch } from "./store-watch.ts";

/** The managed lane tools a read-only placed job is granted on the placer's side: the lane's record, not the peer's tools. */
const REMOTE_JOB_LANE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const DEFAULT_JOB_DEADLINE_MS = 30 * 60_000;
/** A conversation turn with a machine's own session is answered in minutes or not at all. */
export const DEFAULT_ASK_DEADLINE_MS = 10 * 60_000;
/** Time for the offer to travel and wait in the executor's queue, past the job's own deadline. */
const PLACER_GRACE_MS = 60_000;
/** The refusal reason for a placed record this build cannot read: the record stays as it is, never overwritten or offered again from here. */
const RECORD_UNREADABLE_REASON = "the job's placed record cannot be read by this build; it is left as it is";
/** The refusal reason for a placement turn ledger this build cannot read: no turn can be told spent, so nothing is placed under the key. */
const TURN_UNREADABLE_REASON = "the placement's turn record cannot be read by this build; nothing is placed under it";
/** The first retry of a lane end that could not be recorded; each later retry waits twice as long, up to the cap. */
const APPLY_RETRY_MS = 30_000;
const APPLY_RETRY_MAX_MS = 10 * 60_000;

export type RemoteJobEvent =
	| { readonly kind: "progress"; readonly phase: JobPhase; readonly line?: string }
	| { readonly kind: "ended"; readonly record: PlacerJobRecord };

export interface RemoteJobHandle {
	readonly jobId: string;
	readonly laneId: string;
	subscribe(listener: (event: RemoteJobEvent) => void): () => void;
	cancel(reason: JobCancelReason): void;
}

export type PlaceResult =
	| { readonly kind: "placed"; readonly handle: RemoteJobHandle }
	| { readonly kind: "refused"; readonly reason: string };

/** A placement's preparation: the record a job id already has, or the offer a new job writes. */
export type PreparedOffer =
	| { readonly kind: "existing"; readonly record: PlacerJobRecord }
	| {
			readonly kind: "offer";
			readonly machine: FleetMachine;
			readonly jobId: string;
			/** The placement's turn the job id holds; the lane is dispatched at this sequence. */
			readonly turn: number;
			readonly offer: JobOffer;
			readonly deadlineMs: number;
			readonly goalId?: string;
			readonly placement: PlacementKey;
	  };

/** A committed offer: the job's record, the attempt and task its managed lane runs under, or why it is not placed here. */
export type PlacementCommit =
	| { readonly kind: "placed"; readonly record: PlacerJobRecord; readonly attemptId: string; readonly taskId: string }
	| { readonly kind: "attempt_unknown" }
	| { readonly kind: "runtime_replacing" }
	| { readonly kind: "refused"; readonly code: RemoteRefusalCode; readonly reason: string };

/** What writing a job's lane and record takes: the job, its offer, and the state the record starts in. */
interface OfferWrite {
	readonly machine: FleetMachine;
	readonly jobId: string;
	readonly turn: number;
	readonly offer: JobOffer;
	readonly state: "pending" | "accepted";
	readonly deadlineMs: number;
	readonly goalId?: string;
	/** A placement's key; absent for a conversation turn, which no placement names. */
	readonly placement?: PlacementKey;
}

/** What writing a job's lane and record came to: the record with its attempt, or the refusal that wrote no record and sent nothing. */
type LaneWrite =
	| { readonly kind: "written"; readonly record: PlacerJobRecord; readonly attemptId: string; readonly taskId: string }
	| { readonly kind: "refused"; readonly code: RemoteRefusalCode; readonly reason: string };

export interface PlaceOptions {
	readonly label?: string;
	/** The checkout the task is about; the executor must offer the same project. Absent: an answer-only job. */
	readonly cwd?: string;
	readonly deadlineMs?: number;
	readonly goalId?: string;
}

export interface AskOptions {
	readonly deadlineMs?: number;
	readonly goalId?: string;
}

/**
 * A placed job's id: a hash of this machine, the target machine, the placement's idempotency key and the placement's turn. A step's
 * placements on one machine are numbered turns (`placementTurn`): a replay of a placement derives the same id and finds the same job,
 * record and lane; a placement made again after its turn ended and its record was pruned is the next turn, with a new id, lane, record
 * and executor admission. The turn is in the id, so no executor record of an earlier turn is ever the one a later turn meets.
 */
const placedJobId = (selfId: string, machineId: string, idempotencyKey: string, turn: number): string =>
	createHash("sha256")
		.update(JSON.stringify([selfId, machineId, idempotencyKey, turn]))
		.digest("base64url")
		.slice(0, 22);

/** A placement's turn: its number, the job id that turn runs under, and the placed record that id holds now. */
interface PlacementTurn {
	readonly turn: number;
	readonly jobId: string;
	readonly record: RecordRead<PlacerJobRecord>;
}

/**
 * The turn a placement of `idempotencyKey` on `machineId` is at, read without a write. The turn ledger (`JobStore.readPlacementTurn`) holds
 * the highest turn ever raised for the key, and it is never released by retention, so a spent turn stays spent after its record and its
 * lane are both gone. The raised turn is the current one unless it is spent: its placed record is absent and its lane is absent or ended.
 * A spent turn moves the placement on to the next turn. Undefined when the ledger cannot be read, so no turn can be told spent.
 */
function placementTurn(
	bindings: ReadonlyMap<string, ManagedLaneBinding>,
	store: Pick<JobStore, "placedState" | "readPlacementTurn">,
	selfId: string,
	machineId: string,
	idempotencyKey: string,
): PlacementTurn | undefined {
	const ledger = store.readPlacementTurn(machineId, idempotencyKey);
	if (ledger.kind === "unreadable") return undefined;
	const raised = ledger.kind === "valid" ? ledger.turn : 0;
	const turn = Math.max(1, raised);
	const jobId = placedJobId(selfId, machineId, idempotencyKey, turn);
	const record = store.placedState(machineId, jobId);
	const lane = bindings.get(remoteJobLaneId(jobId));
	const spent = raised > 0 && record.kind === "absent" && (lane === undefined || lane.ended === true);
	if (!spent) return { turn, jobId, record };
	const next = turn + 1;
	const nextJobId = placedJobId(selfId, machineId, idempotencyKey, next);
	return { turn: next, jobId: nextJobId, record: store.placedState(machineId, nextJobId) };
}

/** The placement key a dispatch's record carries: its idempotency key and, for a plan step, the step it belongs to. */
function placementKeyOf(dispatch: Pick<FleetDispatch, "idempotencyKey" | "plan">): PlacementKey {
	return {
		idempotencyKey: dispatch.idempotencyKey,
		...(dispatch.plan
			? {
					plan: {
						planId: dispatch.plan.planId,
						nodeId: dispatch.plan.nodeId,
						version: dispatch.plan.version,
					},
				}
			: {}),
	};
}

/**
 * A machine's reply as the ask lane's summary: the whole reply when it fits the summary bound, else the part that fits with
 * a plain note that the reply was cut and where the full reply is (the machine's chat). The cut is decided by bytes.
 */
export function boundedReplySummary(reply: string, machineName: string): string {
	return boundedJobSummary(
		reply,
		`\n\nThe reply was cut here: it is longer than this summary. The full reply is in the chat with ${machineName}.`,
	);
}

function runtimeRetry<T>(run: () => T): Promise<T> {
	try {
		return Promise.resolve(run());
	} catch (error) {
		if (!(error instanceof ManagedLaneRuntimeAdmissionError)) return Promise.reject(error);
		return new Promise((resolve, reject) => {
			const stop = error.onRuntimeAvailable(() => {
				stop();
				runtimeRetry(run).then(resolve, reject);
			});
		});
	}
}

/** The write a prepared offer makes: its job and offer, the record pending until the transport sends the offer. */
function offerWrite(prepared: Extract<PreparedOffer, { readonly kind: "offer" }>): OfferWrite {
	return {
		machine: prepared.machine,
		jobId: prepared.jobId,
		turn: prepared.turn,
		offer: prepared.offer,
		state: "pending",
		deadlineMs: prepared.deadlineMs,
		placement: prepared.placement,
		...(prepared.goalId ? { goalId: prepared.goalId } : {}),
	};
}

export class RemoteJobClient {
	private readonly agentDir: string;
	private readonly selfId: () => string;
	private readonly sessionId: () => string;
	private readonly session: RemotePlacementSession;
	private readonly machines: FleetMachines;
	private readonly timers: TimerPort;
	private readonly store: JobStore;
	private readonly watch: DirectoryWatch;
	private stopFleet: (() => void) | undefined;
	private readonly deadlines = new Map<string, WallAlarm>();
	/** The offline-hold alarm of a job whose executor is down, with the instant it is due. */
	private readonly holds = new Map<string, { readonly at: number; readonly alarm: WallAlarm }>();
	private readonly listeners = new Map<string, Set<(event: RemoteJobEvent) => void>>();
	private readonly emittedSeq = new Map<string, number>();
	private readonly applying = new Set<string>();
	/** The retry alarm of a lane end that could not be recorded, and how many times it has failed so far, by job. */
	private readonly applyRetries = new Map<string, WallAlarm>();
	private readonly applyAttempts = new Map<string, number>();
	private started = false;

	constructor(options: {
		agentDir: string;
		selfId: () => string;
		sessionId: () => string;
		session: RemotePlacementSession;
		machines: FleetMachines;
		timers?: TimerPort;
	}) {
		this.agentDir = options.agentDir;
		this.selfId = options.selfId;
		this.sessionId = options.sessionId;
		this.session = options.session;
		this.machines = options.machines;
		this.timers = options.timers ?? SYSTEM_TIMER_PORT;
		this.store = new JobStore(options.agentDir);
		this.watch = new DirectoryWatch([outDir(options.agentDir)], () => this.reconcile());
	}

	/** Starts following this session's placed jobs (ends left from before a restart are applied now). Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.watch.start();
		this.stopFleet = this.machines.subscribe(() => this.reconcile());
		endAbandonedPlacements(this.session, this.store);
		this.reconcile();
	}

	dispose(): void {
		this.started = false;
		this.watch.stop();
		this.stopFleet?.();
		this.stopFleet = undefined;
		for (const jobId of [...this.deadlines.keys(), ...this.holds.keys()]) this.disarm(jobId);
		for (const alarm of this.applyRetries.values()) alarm.stop();
		this.applyRetries.clear();
		this.applyAttempts.clear();
		this.listeners.clear();
	}

	/** Every job this machine placed, newest first. */
	list(): PlacerJobRecord[] {
		return this.store.out.list().sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Why the job cannot be placed on `machine`, in a fixed order of code facts; undefined when it can. */
	private refusal(
		machine: FleetMachine | undefined,
		dispatch: Pick<FleetDispatch, "instructions" | "writeScope">,
	): { readonly code: RemoteRefusalCode; readonly reason: string } | undefined {
		if (!machine) return { code: "unlinked", reason: "that machine is not linked with this one" };
		if (loadLinkSettings(this.agentDir).peers[machine.machineId]?.hold)
			return { code: "held", reason: `${machine.name} is on hold (/remote release ${machine.name})` };
		if (dispatch.writeScope.length > 0)
			return { code: "writes", reason: "jobs that change files are not placed on other machines yet" };
		if (!machine.facts)
			return { code: "no_facts", reason: `${machine.name} has not told this machine what it can take yet` };
		if (!machine.facts.accepts.jobs)
			return { code: "jobs_disabled", reason: `${machine.name} does not take jobs from this machine now` };
		if (Buffer.byteLength(dispatch.instructions, "utf8") > MAX_JOB_INSTRUCTIONS_BYTES)
			return { code: "too_long", reason: `the task is longer than ${MAX_JOB_INSTRUCTIONS_BYTES / 1024} KiB` };
		// No credential leaves this machine: a task that holds one is not sent at all, not sent with it masked.
		if (redactKnownSecrets(dispatch.instructions) !== dispatch.instructions)
			return {
				code: "secret",
				reason: "the task holds what looks like a secret; remove it and place the job again",
			};
		return undefined;
	}

	/**
	 * Why the job's durable lane cannot take a placement on `machineId`.The job id names the target machine, so a lane bound to
	 * another machine is not reachable from a placement here: the check is a guard against a broken invariant. Undefined otherwise.
	 */
	private laneRefusal(
		machineId: string,
		jobId: string,
	): { readonly code: RemoteRefusalCode; readonly reason: string } | undefined {
		const binding = this.session.managedLaneBindings().get(remoteJobLaneId(jobId));
		if (binding && binding.authorizationId !== remoteJobAuthorization(machineId))
			return { code: "lane_bound_elsewhere", reason: "the job's lane is bound to another machine" };
		return undefined;
	}

	/**
	 * The asynchronous half of a placement: the existing record a job id replays, or the offer a new job writes. Every
	 * refusal is a code fact and nothing is written here.
	 */
	async prepareOffer(
		dispatch: Pick<FleetDispatch, "idempotencyKey" | "instructions" | "writeScope" | "plan">,
		placement: Extract<Placement, { kind: "remote_machine" }>,
		options: PlaceOptions = {},
	): Promise<PreparedOffer | { readonly kind: "refused"; readonly code: RemoteRefusalCode; readonly reason: string }> {
		const selfId = this.selfId();
		const current = placementTurn(
			this.session.managedLaneBindings(),
			this.store,
			selfId,
			placement.machineId,
			dispatch.idempotencyKey,
		);
		if (!current) return { kind: "refused", code: "record_unreadable", reason: TURN_UNREADABLE_REASON };
		const { jobId, turn } = current;
		const existing = current.record;
		if (existing.kind === "valid") return { kind: "existing", record: existing.record };
		if (existing.kind === "unreadable")
			return { kind: "refused", code: "record_unreadable", reason: RECORD_UNREADABLE_REASON };
		const machine = this.machines.get(placement.machineId);
		const refused = this.refusal(machine, dispatch);
		if (refused || !machine)
			return {
				kind: "refused",
				code: refused?.code ?? "unlinked",
				reason: refused?.reason ?? "that machine is not linked with this one",
			};
		const lane = this.laneRefusal(machine.machineId, jobId);
		if (lane) return { kind: "refused", code: lane.code, reason: lane.reason };
		let repo: JobOffer["repo"];
		if (options.cwd) {
			const identity = await resolveRepoIdentity(options.cwd);
			if (identity) {
				if (!machine.facts?.checkouts.some((checkout) => checkout.repoKey === identity.repoKey))
					return {
						kind: "refused",
						code: "project_missing",
						reason: `${machine.name} does not offer this project`,
					};
				repo = { repoKey: identity.repoKey, ...(identity.headSha ? { baseSha: identity.headSha } : {}) };
			}
		}
		const deadlineMs = Math.max(
			MIN_JOB_DEADLINE_MS,
			Math.min(MAX_JOB_DEADLINE_MS, options.deadlineMs ?? DEFAULT_JOB_DEADLINE_MS),
		);
		const offer: JobOffer = {
			jobId,
			v: 1,
			kind: "task",
			label: boundedLine(options.label ?? dispatch.instructions, MAX_JOB_LABEL_CHARS),
			instructions: dispatch.instructions,
			envelope: { writes: false },
			...(repo ? { repo } : {}),
			deadlineMs,
			hops: [selfId],
		};
		return {
			kind: "offer",
			machine,
			jobId,
			turn,
			offer,
			deadlineMs,
			placement: placementKeyOf(dispatch),
			...(options.goalId ? { goalId: options.goalId } : {}),
		};
	}

	/**
	 * The synchronous half of a placement, run by the fleet's admit: the record an existing job id already has, or the job's
	 * managed lane and pending record written now. A replay of a job whose lane a crash left durable reads that lane's attempt
	 * back, so no second attempt starts and the record is written once. A runtime being replaced answers `runtime_replacing`
	 * before anything is written, so the offer stays prepared for the next try. A lane that ended after the offer was prepared
	 * refuses it (`lane_ended`): its turn is spent, and nothing is written under its job id.
	 */
	commitOffer(prepared: PreparedOffer): PlacementCommit {
		if (prepared.kind === "existing") {
			const binding = this.session.managedLaneBindings().get(prepared.record.laneId);
			return prepared.record.attemptId && binding
				? { kind: "placed", record: prepared.record, attemptId: prepared.record.attemptId, taskId: binding.taskId }
				: { kind: "attempt_unknown" };
		}
		const lane = this.laneRefusal(prepared.machine.machineId, prepared.jobId);
		if (lane) return { kind: "refused", code: lane.code, reason: lane.reason };
		// The turn is read again: a turn that moved since the offer was prepared writes nothing under the job id it was prepared for.
		const current = placementTurn(
			this.session.managedLaneBindings(),
			this.store,
			this.selfId(),
			prepared.machine.machineId,
			prepared.placement.idempotencyKey,
		);
		if (!current) return { kind: "refused", code: "record_unreadable", reason: TURN_UNREADABLE_REASON };
		if (current.turn !== prepared.turn)
			return {
				kind: "refused",
				code: "lane_ended",
				reason: "the job's placement turn moved while it was being placed",
			};
		try {
			const write = this.writeLaneAndRecord(offerWrite(prepared));
			return write.kind === "written"
				? { kind: "placed", record: write.record, attemptId: write.attemptId, taskId: write.taskId }
				: write;
		} catch (error) {
			if (error instanceof ManagedLaneRuntimeAdmissionError) return { kind: "runtime_replacing" };
			throw error;
		}
	}

	async place(
		dispatch: Pick<FleetDispatch, "idempotencyKey" | "instructions" | "writeScope" | "plan">,
		placement: Extract<Placement, { kind: "remote_machine" }>,
		options: PlaceOptions = {},
	): Promise<PlaceResult> {
		const prepared = await this.prepareOffer(dispatch, placement, options);
		if (prepared.kind === "refused") return { kind: "refused", reason: prepared.reason };
		if (prepared.kind === "existing") return { kind: "placed", handle: this.handle(prepared.record) };
		const write = await this.open(offerWrite(prepared));
		if (write.kind === "refused") return { kind: "refused", reason: write.reason };
		return { kind: "placed", handle: this.handle(write.record) };
	}

	/** Whether this machine placed the job: its record is in this machine's placer store, readable or not. */
	placedHere(jobId: string): boolean {
		return this.store.placedMachineOf(jobId) !== undefined;
	}

	/** Jobs this machine placed on `machineId` that are not sent yet: they will take that machine's room. */
	pendingCount(machineId: string): number {
		return this.store.pendingPlacedCount(machineId, this.timers.now(), loadLinkSettings(this.agentDir).offlineHoldMs);
	}

	/**
	 * A conversation turn with a linked machine's own session, placed like a job so it is a lane: the message goes now as
	 * an ordinary chat message under the job's id (a machine of any build answers it), and the machine's reply under that
	 * id is the lane's end (`completeAsk`). A machine that stays silent, drops off past the offline hold, or is revoked
	 * ends the lane through the same placer-side endings as any placed job, and the lane's end reaches the asking session
	 * through the one terminal notification every worker uses. `send` writes the message and throws when it cannot.
	 */
	async ask(
		machine: FleetMachine,
		text: string,
		options: AskOptions,
		send: (jobId: string) => void,
	): Promise<PlaceResult> {
		if (loadLinkSettings(this.agentDir).peers[machine.machineId]?.hold)
			return { kind: "refused", reason: `${machine.name} is on hold (/remote release ${machine.name})` };
		if (!machine.online) return { kind: "refused", reason: `${machine.name} is not connected now` };
		if (Buffer.byteLength(text, "utf8") > MAX_JOB_INSTRUCTIONS_BYTES)
			return { kind: "refused", reason: `the message is longer than ${MAX_JOB_INSTRUCTIONS_BYTES / 1024} KiB` };
		const jobId = `ask${randomUUID().replaceAll("-", "")}`;
		const deadlineMs = Math.max(
			MIN_JOB_DEADLINE_MS,
			Math.min(MAX_JOB_DEADLINE_MS, options.deadlineMs ?? DEFAULT_ASK_DEADLINE_MS),
		);
		const offer: JobOffer = {
			jobId,
			v: 1,
			kind: "ask",
			label: boundedLine(text, MAX_JOB_LABEL_CHARS),
			instructions: text,
			envelope: { writes: false },
			deadlineMs,
			hops: [this.selfId()],
		};
		// A conversation turn's id is fresh, so it is always the first turn of its own lane.
		const write = await this.open({
			machine,
			jobId,
			turn: 1,
			offer,
			state: "accepted",
			deadlineMs,
			...(options.goalId ? { goalId: options.goalId } : {}),
		});
		if (write.kind === "refused") return { kind: "refused", reason: write.reason };
		const record = write.record;
		try {
			send(jobId);
		} catch (error) {
			// The record exists before the message goes, so a reply can never beat it; a send that fails ends the lane here.
			harnessLog.warn("placement", "a message to a linked machine could not be sent", {
				jobId,
				reason: error instanceof Error ? error.name : "unknown",
			});
			this.end(machine.machineId, jobId, "machine_offline", "superseded");
			return {
				kind: "refused",
				reason: error instanceof Error ? error.message : `${machine.name} is not connected now`,
			};
		}
		return { kind: "placed", handle: this.handle(record) };
	}

	/**
	 * The machine's reply to a conversation turn is that turn's outcome. False when the reply answers nothing placed
	 * here (an ordinary chat reply), so the caller keeps it as chat only; a turn already ended keeps its first end.
	 */
	completeAsk(machineId: string, jobId: string, text: string): boolean {
		const known = this.store.placedState(machineId, jobId);
		if (known.kind === "unreadable") {
			harnessLog.warn("placement", "a reply to a placed job whose record cannot be read was kept as chat", {
				jobId,
			});
			return false;
		}
		if (known.kind !== "valid" || known.record.offer.kind !== "ask" || known.record.executorId !== machineId)
			return false;
		const outcome: JobOutcome = {
			status: "succeeded",
			summary: boundedReplySummary(redactKnownSecrets(text), this.machines.get(machineId)?.name ?? "the machine"),
		};
		this.store.updatePlaced(machineId, jobId, (current) =>
			current.appliedAt !== undefined || current.ending || current.state === "terminal" || current.state === "ended"
				? undefined
				: { ...current, state: "terminal", outcome, outcomeDigest: digestOutcome(outcome) },
		);
		journalJob(this.agentDir, { side: "placer", jobId, peer: machineId, event: "answered" });
		this.reconcile();
		return true;
	}

	/**
	 * Writes a job's managed lane and then its record: a crash between the two leaves a durable lane that a replay of the same
	 * job id finds and reads back, so the order never needs a second attempt. `pending` waits for the transport to send the
	 * offer; `accepted` is a record whose message was sent by the caller.
	 */
	private async open(input: OfferWrite): Promise<LaneWrite> {
		return runtimeRetry(() => this.writeLaneAndRecord(input));
	}

	/**
	 * The synchronous lane-then-record write, shared by `open` and `commitOffer`. The attempt is the one the lane records or, for
	 * a replayed dispatch whose lane is already durable, the one that lane runs under. A lane with neither is a broken invariant
	 * (a dispatch always prepares an attempt) and throws before the record is written. The runtime's admission error is thrown
	 * before anything is written. A lane that ends during its own dispatch, or a record this build cannot read, is a typed refusal
	 * that writes no record and sends nothing.
	 */
	private writeLaneAndRecord(input: OfferWrite): LaneWrite {
		const { machine, jobId, offer, state, deadlineMs, turn } = input;
		// An unreadable record is not an absent one: the dispatch would replay a lane that may be live, and the write would overwrite it.
		if (this.store.placedState(machine.machineId, jobId).kind === "unreadable")
			return { kind: "refused", code: "record_unreadable", reason: RECORD_UNREADABLE_REASON };
		const now = this.timers.now();
		const laneId = remoteJobLaneId(jobId);
		const holdMs = loadLinkSettings(this.agentDir).offlineHoldMs;
		this.session.recordManagedLane({
			laneId,
			phase: "dispatch",
			...(input.goalId ? { goalId: input.goalId } : {}),
			dispatch: {
				// The lane is dispatched at the job's turn: a replay of the turn is the same dispatch, and an ended lane answers the write
				// below as refused (its dispatch is not repeated).
				sequence: turn,
				instructions: offer.instructions,
				profileId: "remote-job",
				provider: "link",
				authorizationId: remoteJobAuthorization(machine.machineId),
				authorizationKind: "profile-derived",
				allowedTools: REMOTE_JOB_LANE_TOOLS,
				writePaths: [],
				leaseTtlMs: deadlineMs + PLACER_GRACE_MS + holdMs + PLACER_GRACE_MS,
				// The key the record is written under: a plan's stop finds this job through its lane when the record cannot be read.
				...(input.placement ? { placement: input.placement } : {}),
			},
		});
		const written = this.session.managedLaneBindings().get(laneId);
		if (!written) throw new Error("remote_job_lane_unrecorded");
		// The turn is raised once its lane exists and before its record or offer: every turn that can have an offer is then on the ledger, so a
		// turn the ledger shows spent has no executor record that a later placement could meet. A lane that ended during its dispatch has no
		// offer, and a runtime that is replacing before the dispatch leaves nothing raised, so the same turn is retried.
		if (input.placement && !this.store.raisePlacementTurn(machine.machineId, input.placement.idempotencyKey, turn)) {
			endAbandonedPlacement(this.session, laneId, written.dispatchSequence);
			return { kind: "refused", code: "record_unreadable", reason: TURN_UNREADABLE_REASON };
		}
		// The dispatch can end its own lane (an orphan's retry runs inside the controller's first hydration): an ended lane takes
		// no record and no offer.
		if (written.ended)
			return { kind: "refused", code: "lane_ended", reason: "the job's lane ended while it was being placed" };
		let created: RecordCreate<PlacerJobRecord>;
		try {
			created = this.store.createPlaced({
				v: 1,
				jobId,
				executorId: machine.machineId,
				executorName: machine.name,
				ownerSession: this.sessionId(),
				laneId,
				offer,
				offerDigest: digestOffer(offer),
				state,
				createdAt: now,
				deadlineAt: now + deadlineMs + PLACER_GRACE_MS,
				lastSeq: 0,
				attemptId: written.attemptId,
				...(input.placement ? { placement: input.placement } : {}),
			});
		} catch (error) {
			// The lane is durable and its record is not: no offer can follow, so the lane ends here instead of at its lease.
			endAbandonedPlacement(this.session, laneId, written.dispatchSequence);
			throw error;
		}
		// The record turned unreadable after the check above: it may belong to a live job, so its lane is left open.
		if (created.kind !== "valid")
			return { kind: "refused", code: "record_unreadable", reason: RECORD_UNREADABLE_REASON };
		harnessLog.info("placement", "a job was placed on a linked machine", { jobId, peer: machine.machineId });
		journalJob(this.agentDir, { side: "placer", jobId, peer: machine.machineId, event: state });
		this.start();
		this.reconcile();
		return { kind: "written", record: created.record, attemptId: written.attemptId, taskId: written.taskId };
	}

	/**
	 * The machine a placement for this idempotency key is already bound to: the machine of its placed job, the most recent when
	 * there are several. Undefined when no placed job exists for the key. Read-only. A readable record is found by its key; an
	 * unreadable one carries no key, so each linked machine's latest turn, from its turn ledger, is read by its job id, and an
	 * unreadable record of that turn (or an unreadable ledger) still binds the key to its machine.
	 */
	boundMachine(idempotencyKey: string): string | undefined {
		const selfId = this.selfId();
		const candidates: PlacerJobRecord[] = [];
		for (const record of this.store.placedScan().valid.values())
			if (record.placement?.idempotencyKey === idempotencyKey) candidates.push(record);
		// The ledger names the latest turn of each machine; a turn whose record cannot be read, or a ledger that cannot be read, binds the key.
		let unreadable: string | undefined;
		for (const machine of this.machines.list()) {
			const ledger = this.store.readPlacementTurn(machine.machineId, idempotencyKey);
			if (ledger.kind === "unreadable") {
				unreadable ??= machine.machineId;
				continue;
			}
			if (ledger.kind === "absent") continue;
			const jobId = placedJobId(selfId, machine.machineId, idempotencyKey, ledger.turn);
			if (this.store.placedState(machine.machineId, jobId).kind === "unreadable") unreadable ??= machine.machineId;
		}
		let bound: PlacerJobRecord | undefined;
		for (const record of candidates) if (bound === undefined || record.createdAt > bound.createdAt) bound = record;
		return bound?.executorId ?? unreadable;
	}

	/** The owner stops a job; it ends here at once and the executor is told to stop. True when the stop is recorded (`cancelOn`). */
	cancel(jobId: string, reason: JobCancelReason = "owner"): boolean {
		const machineId = this.store.placedMachineOf(jobId);
		return machineId !== undefined && this.cancelOn(machineId, jobId, reason);
	}

	/**
	 * The stop of the placed job `jobId` on `machineId`. A readable record ends here at once. A record this build cannot read takes a
	 * cancel marker beside it, and its lane ends from the marker (in the session holding the lane); the executor is told from the marker
	 * whenever it is linked. True when the stop is recorded, now or by a marker that stands.
	 */
	cancelOn(machineId: string, jobId: string, reason: JobCancelReason): boolean {
		if (this.end(machineId, jobId, endingOfCancel(reason), reason)) return true;
		if (this.store.placedState(machineId, jobId).kind !== "unreadable") return false;
		this.store.markPlacedCancel(machineId, jobId, reason);
		journalJob(this.agentDir, { side: "placer", jobId, peer: machineId, event: "cancel_marked", code: reason });
		endMarkedPlacement(this.session, machineId, jobId, reason);
		return true;
	}

	/**
	 * The placed records this build cannot read: the job ids their file names hold, by the machine they are with, and how many of them
	 * name no machine. An unnamed one counts for room and cannot be stopped by name.
	 */
	unreadablePlaced(): { readonly byMachine: ReadonlyMap<string, readonly string[]>; readonly unnamed: number } {
		const byMachine = new Map<string, string[]>();
		let unnamed = 0;
		for (const entry of this.store.placedScan().unreadable) {
			if (entry.machineId === undefined || entry.jobId === undefined) {
				unnamed += 1;
				continue;
			}
			byMachine.set(entry.machineId, [...(byMachine.get(entry.machineId) ?? []), entry.jobId]);
		}
		return { byMachine, unnamed };
	}

	/**
	 * Stops every placed job of this session that belongs to the plan `planId`, whichever lane still names it. A readable record's plan is
	 * its placement key. A record this build cannot read is matched through its lane: the lane's dispatch carries the same key, so the
	 * stop is a cancel marker beside the record (`cancelOn`). Returns how many stops were recorded; a readable job that already ended keeps
	 * its first end. A record whose lane an earlier build wrote has no key, so its plan is unknown: it is not matched, and is reported.
	 */
	cancelPlan(planId: string, reason: JobCancelReason): number {
		const sessionId = this.sessionId();
		let stopped = 0;
		for (const record of [...this.store.placedScan().valid.values()])
			if (
				record.ownerSession === sessionId &&
				record.placement?.plan?.planId === planId &&
				this.end(record.executorId, record.jobId, endingOfCancel(reason), reason)
			)
				stopped += 1;
		let unkeyed = 0;
		for (const [machineId, jobIds] of this.unreadablePlaced().byMachine)
			for (const jobId of jobIds) {
				const binding = placedJobLaneBinding(this.session, machineId, jobId);
				if (binding === undefined) continue;
				if (binding.placement === undefined) {
					unkeyed += 1;
					continue;
				}
				if (binding.placement.plan?.planId === planId && this.cancelOn(machineId, jobId, reason)) stopped += 1;
			}
		if (unkeyed > 0)
			harnessLog.warn(
				"placement",
				"a placed job's record cannot be read and its lane carries no placement key (an earlier build's lane, or a conversation turn), so this stop cannot name its plan",
				{ plan: planId, jobs: unkeyed },
			);
		return stopped;
	}

	/**
	 * A revoked machine's jobs end as revoked, whichever session placed them (each owner applies its own), and the jobs it placed here
	 * are stopped. A record this build cannot read takes a revoked marker (`cancelOn`), since its job is known by its file name.
	 */
	revokeMachine(machineId: string): void {
		for (const record of [...this.store.placedScan().valid.values()])
			if (record.executorId === machineId) this.end(machineId, record.jobId, "machine_revoked", "revoked");
		for (const jobId of this.unreadablePlaced().byMachine.get(machineId) ?? [])
			this.cancelOn(machineId, jobId, "revoked");
		this.store.cancelExecutedFrom(machineId, "revoked");
	}

	private end(machineId: string, jobId: string, ending: PlacerEnding, cancel: JobCancelReason): boolean {
		let ended = false;
		this.store.updatePlaced(machineId, jobId, (current) => {
			if (
				current.appliedAt !== undefined ||
				current.ending ||
				current.state === "refused" ||
				current.state === "terminal"
			)
				return undefined;
			ended = true;
			return { ...current, state: "ended", ending, cancel };
		});
		if (ended) {
			journalJob(this.agentDir, { side: "placer", jobId, peer: machineId, event: "ended", code: ending });
			this.reconcile();
		}
		return ended;
	}

	/**
	 * Applies a cancel marker. A readable record takes the stop as its ending, and the marker is spent. A record this build cannot read keeps
	 * its marker, and its lane ends from the marker in the session holding the lane (`endMarkedPlacement`). A marker whose record is gone
	 * is removed.
	 */
	private honorCancelMark(mark: CancelMark): void {
		const state = this.store.placedState(mark.machineId, mark.jobId);
		if (state.kind === "unreadable") {
			endMarkedPlacement(this.session, mark.machineId, mark.jobId, mark.reason);
			return;
		}
		if (state.kind === "valid") this.end(mark.machineId, mark.jobId, endingOfCancel(mark.reason), mark.reason);
		this.store.clearPlacedCancelMark(mark.machineId, mark.jobId);
	}

	private handle(record: PlacerJobRecord): RemoteJobHandle {
		return {
			jobId: record.jobId,
			laneId: record.laneId,
			subscribe: (listener) => {
				let set = this.listeners.get(record.jobId);
				if (!set) {
					set = new Set();
					this.listeners.set(record.jobId, set);
				}
				set.add(listener);
				return () => {
					set.delete(listener);
				};
			},
			cancel: (reason) => {
				this.cancel(record.jobId, reason);
			},
		};
	}

	private emit(jobId: string, event: RemoteJobEvent): void {
		for (const listener of [...(this.listeners.get(jobId) ?? [])]) listener(event);
	}

	private disarm(jobId: string): void {
		this.deadlines.get(jobId)?.stop();
		this.deadlines.delete(jobId);
		this.holds.get(jobId)?.alarm.stop();
		this.holds.delete(jobId);
	}

	/** Arms (or re-arms, when the instant moved) the offline hold of a job whose executor is down; clears it once it is back. */
	private holdFor(jobId: string, holdUntil: number | undefined): void {
		const current = this.holds.get(jobId);
		if (current?.at === holdUntil) return;
		current?.alarm.stop();
		this.holds.delete(jobId);
		if (holdUntil !== undefined)
			this.holds.set(jobId, { at: holdUntil, alarm: alarmAt(this.timers, holdUntil, () => this.reconcile()) });
	}

	/** Brings this session's placed jobs up to date with the store and the fleet; idempotent. */
	/**
	 * Brings every unapplied placed record up to date with the store and the fleet; idempotent. Any session that reads a record writes its
	 * time-based end (the deadline, the offline hold): both are code facts, and a closed owner's pending job must not keep a machine's room.
	 * Progress and the lane's end belong to the owning session alone, which holds the lane.
	 */
	private reconcile(): void {
		if (!this.started) return;
		const sessionId = this.sessionId();
		const now = this.timers.now();
		const holdMs = loadLinkSettings(this.agentDir).offlineHoldMs;
		for (const mark of this.store.placedCancelMarks()) this.honorCancelMark(mark);
		for (const record of [...this.store.placedScan().valid.values()]) {
			if (record.appliedAt !== undefined) continue;
			const owned = record.ownerSession === sessionId;
			if (owned && record.progress && record.progress.seq > (this.emittedSeq.get(record.jobId) ?? 0)) {
				this.emittedSeq.set(record.jobId, record.progress.seq);
				this.emit(record.jobId, {
					kind: "progress",
					phase: record.progress.phase,
					...(record.progress.line ? { line: record.progress.line } : {}),
				});
			}
			if (placedJobTerminal(record)) {
				if (owned) this.apply(record);
				else this.disarm(record.jobId);
				continue;
			}
			if (now >= record.deadlineAt) {
				this.end(record.executorId, record.jobId, "remote_deadline", "deadline");
				continue;
			}
			if (!this.deadlines.has(record.jobId))
				this.deadlines.set(
					record.jobId,
					alarmAt(this.timers, record.deadlineAt, () =>
						this.end(record.executorId, record.jobId, "remote_deadline", "deadline"),
					),
				);
			const machine = this.machines.get(record.executorId);
			const holdUntil =
				machine && !machine.online && machine.offlineSince !== undefined
					? machine.offlineSince + holdMs
					: undefined;
			// A job waits for its machine within the hold, then ends as unreachable so it can be placed elsewhere.
			if (holdUntil !== undefined && now >= holdUntil)
				this.end(record.executorId, record.jobId, "machine_offline", "superseded");
			else this.holdFor(record.jobId, holdUntil);
		}
	}

	/**
	 * Re-arms the apply of a lane end that could not be recorded: one alarm per job, at a capped doubling delay, and it is never dropped.
	 * The alarm runs `reconcile`, which applies the end again while the record is unapplied.
	 */
	private retryApply(jobId: string): void {
		// A client that was disposed schedules nothing: its end is applied by the next session that starts the client.
		if (!this.started) return;
		const attempt = (this.applyAttempts.get(jobId) ?? 0) + 1;
		this.applyAttempts.set(jobId, attempt);
		const delay = Math.min(APPLY_RETRY_MS * 2 ** (attempt - 1), APPLY_RETRY_MAX_MS);
		this.applyRetries.get(jobId)?.stop();
		this.applyRetries.set(
			jobId,
			alarmAt(this.timers, this.timers.now() + delay, () => {
				this.applyRetries.delete(jobId);
				this.reconcile();
			}),
		);
	}

	/** Records the end on the job's managed lane once; a lane that is gone or already ended takes nothing more. */
	private apply(record: PlacerJobRecord): void {
		const terminal = placedJobTerminal(record);
		if (!terminal || this.applying.has(record.jobId)) return;
		this.applying.add(record.jobId);
		this.disarm(record.jobId);
		let failed = false;
		const dispatchSequence = this.session.managedLaneBindings().get(record.laneId)?.dispatchSequence;
		void runtimeRetry(() =>
			this.session.recordManagedLane({
				laneId: record.laneId,
				phase: "terminal",
				...(dispatchSequence !== undefined ? { dispatchSequence } : {}),
				status: terminal.status,
				summary: terminal.summary,
				...(terminal.reasonCode ? { reasonCode: terminal.reasonCode } : {}),
			}),
		)
			// Nothing returned means the lane had already ended (this terminal replayed after a crash, or its lease ran out):
			// the lane is closed either way, so the end counts as applied. An unknown lane throws and is retried.
			.catch((error: unknown) => {
				failed = true;
				harnessLog.warn("placement", "a placed job's end could not be recorded on its lane", {
					jobId: record.jobId,
					reason: error instanceof Error ? error.name : "unknown",
				});
			})
			.finally(() => {
				// Only a recorded end counts as applied: a failed record stays open, and its retry alarm applies it again, never dropped.
				const applied = failed
					? undefined
					: this.store.updatePlaced(record.executorId, record.jobId, (current) =>
							current.appliedAt !== undefined ? undefined : { ...current, appliedAt: this.timers.now() },
						);
				this.applying.delete(record.jobId);
				journalJob(this.agentDir, {
					side: "placer",
					jobId: record.jobId,
					peer: record.executorId,
					event: failed ? "apply_failed" : "applied",
					code: terminal.reasonCode,
				});
				if (failed) {
					this.retryApply(record.jobId);
					return;
				}
				this.applyRetries.get(record.jobId)?.stop();
				this.applyRetries.delete(record.jobId);
				this.applyAttempts.delete(record.jobId);
				if (!applied) return;
				this.emit(record.jobId, { kind: "ended", record: applied });
				this.listeners.delete(record.jobId);
				this.emittedSeq.delete(record.jobId);
			});
	}
}
