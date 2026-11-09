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
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { ManagedLaneBinding } from "../delegation/worker-lifecycle.ts";
import { type ManagedLaneEvent, ManagedLaneRuntimeAdmissionError } from "../extensions/managed-lane-records.ts";
import type { FleetDispatch } from "../fleet/fleet-types.ts";
import type { RemoteRefusalCode } from "../fleet/remote-admit.ts";
import type { Placement } from "../placement/placement-types.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { boundedLine } from "../util/bounded-line.ts";
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
import { JobStore, journalJob, outDir, type PlacerEnding, type PlacerJobRecord } from "./job-store.ts";
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

export interface RemotePlacementSession {
	recordManagedLane(event: ManagedLaneEvent): LaneRecord | undefined;
	/**
	 * The durable attempts of the managed lanes, by lane id: a replayed dispatch of a durable lane reads its attempt back here, and
	 * a restart finds the placer-side lanes a predecessor left open.
	 */
	managedLaneBindings(): ReadonlyMap<string, ManagedLaneBinding>;
}

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
			readonly offer: JobOffer;
			readonly deadlineMs: number;
			readonly goalId?: string;
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
	readonly offer: JobOffer;
	readonly state: "pending" | "accepted";
	readonly deadlineMs: number;
	readonly goalId?: string;
}

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

/** The prefix of a placed job's lane id: `remote-<jobId>`. */
const REMOTE_LANE_PREFIX = "remote-";
/** The prefix of a placed job's authorization: `remote-job:<machineId>`, naming the machine that runs the job. */
const REMOTE_JOB_AUTHORIZATION_PREFIX = "remote-job:";
/** The end a lane takes when its placement was never recorded: the job was never offered to its machine. */
const PLACEMENT_ABANDONED = "placement_abandoned";

export const remoteJobLaneId = (jobId: string): string => `${REMOTE_LANE_PREFIX}${jobId}`;
/** The authorization a placed job's managed lane is dispatched under: the machine that runs it (a lane is bound to one). */
const remoteJobAuthorization = (machineId: string): string => `${REMOTE_JOB_AUTHORIZATION_PREFIX}${machineId}`;

/**
 * A placed job's id: a hash of this machine, the target machine and the placement's idempotency key. Each target machine gets its
 * own job and lane for a step; a replay on the same machine derives the same id and finds the same record and lane.
 */
const placedJobId = (selfId: string, machineId: string, idempotencyKey: string): string =>
	createHash("sha256")
		.update(JSON.stringify([selfId, machineId, idempotencyKey]))
		.digest("base64url")
		.slice(0, 22);

/** The placer's ending for a cancel: the owner's stop, the deadline, a revoke, or else the plan's own stop. */
function endingOfCancel(reason: JobCancelReason): PlacerEnding {
	if (reason === "owner") return "owner_cancelled";
	if (reason === "deadline") return "remote_deadline";
	if (reason === "revoked") return "machine_revoked";
	return "plan_stopped";
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
		offer: prepared.offer,
		state: "pending",
		deadlineMs: prepared.deadlineMs,
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
		this.endAbandonedLanes();
		this.reconcile();
	}

	dispose(): void {
		this.started = false;
		this.watch.stop();
		this.stopFleet?.();
		this.stopFleet = undefined;
		for (const jobId of [...this.deadlines.keys(), ...this.holds.keys()]) this.disarm(jobId);
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
		dispatch: Pick<FleetDispatch, "idempotencyKey" | "instructions" | "writeScope">,
		placement: Extract<Placement, { kind: "remote_machine" }>,
		options: PlaceOptions = {},
	): Promise<PreparedOffer | { readonly kind: "refused"; readonly code: RemoteRefusalCode; readonly reason: string }> {
		const selfId = this.selfId();
		const jobId = placedJobId(selfId, placement.machineId, dispatch.idempotencyKey);
		const existing = this.store.out.read(jobId);
		if (existing) return { kind: "existing", record: existing };
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
			offer,
			deadlineMs,
			...(options.goalId ? { goalId: options.goalId } : {}),
		};
	}

	/**
	 * The synchronous half of a placement, run by the fleet's admit: the record an existing job id already has, or the job's
	 * managed lane and pending record written now. A replay of a job whose lane a crash left durable reads that lane's attempt
	 * back, so no second attempt starts and the record is written once. A runtime being replaced answers `runtime_replacing`
	 * before anything is written, so the offer stays prepared for the next try. A lane that ended with no record was never
	 * offered: its job starts again as the lane's next turn.
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
		try {
			const { record, attemptId, taskId } = this.writeLaneAndRecord(offerWrite(prepared));
			return { kind: "placed", record, attemptId, taskId };
		} catch (error) {
			if (error instanceof ManagedLaneRuntimeAdmissionError) return { kind: "runtime_replacing" };
			throw error;
		}
	}

	async place(
		dispatch: Pick<FleetDispatch, "idempotencyKey" | "instructions" | "writeScope">,
		placement: Extract<Placement, { kind: "remote_machine" }>,
		options: PlaceOptions = {},
	): Promise<PlaceResult> {
		const prepared = await this.prepareOffer(dispatch, placement, options);
		if (prepared.kind === "refused") return { kind: "refused", reason: prepared.reason };
		if (prepared.kind === "existing") return { kind: "placed", handle: this.handle(prepared.record) };
		const record = await this.open(offerWrite(prepared));
		return { kind: "placed", handle: this.handle(record) };
	}

	/** Whether this machine placed the job: its record is in this machine's placer store. */
	placedHere(jobId: string): boolean {
		return this.store.out.read(jobId) !== undefined;
	}

	/** Jobs this machine placed on `machineId` that are not sent yet: they will take that machine's room. */
	pendingCount(machineId: string): number {
		return this.store.pendingPlacedCount(machineId);
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
		const record = await this.open({
			machine,
			jobId,
			offer,
			state: "accepted",
			deadlineMs,
			...(options.goalId ? { goalId: options.goalId } : {}),
		});
		try {
			send(jobId);
		} catch (error) {
			// The record exists before the message goes, so a reply can never beat it; a send that fails ends the lane here.
			harnessLog.warn("placement", "a message to a linked machine could not be sent", {
				jobId,
				reason: error instanceof Error ? error.name : "unknown",
			});
			this.end(jobId, "machine_offline", "superseded");
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
		const known = this.store.out.read(jobId);
		if (known?.offer.kind !== "ask" || known.executorId !== machineId) return false;
		const outcome: JobOutcome = {
			status: "succeeded",
			summary: boundedReplySummary(redactKnownSecrets(text), this.machines.get(machineId)?.name ?? "the machine"),
		};
		this.store.updatePlaced(jobId, (current) =>
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
	private async open(input: OfferWrite): Promise<PlacerJobRecord> {
		return (await runtimeRetry(() => this.writeLaneAndRecord(input))).record;
	}

	/**
	 * The synchronous lane-then-record write, shared by `open` and `commitOffer`. The attempt is the one the lane records or, for
	 * a replayed dispatch whose lane is already durable, the one that lane runs under. A lane with neither is a broken invariant
	 * (a dispatch always prepares an attempt) and throws before the record is written. The runtime's admission error is thrown
	 * before anything is written.
	 */
	private writeLaneAndRecord(input: OfferWrite): {
		readonly record: PlacerJobRecord;
		readonly attemptId: string;
		readonly taskId: string;
	} {
		const { machine, jobId, offer, state, deadlineMs } = input;
		const now = this.timers.now();
		const laneId = remoteJobLaneId(jobId);
		const holdMs = loadLinkSettings(this.agentDir).offlineHoldMs;
		// The lane's turn: a live lane replays its own turn (the managed controller answers with the attempt it has); a lane that
		// ended without a record was never offered, so the job runs again as the lane's next turn.
		const bound = this.session.managedLaneBindings().get(laneId);
		const sequence = bound === undefined ? 1 : bound.ended ? bound.dispatchSequence + 1 : bound.dispatchSequence;
		this.session.recordManagedLane({
			laneId,
			phase: "dispatch",
			...(input.goalId ? { goalId: input.goalId } : {}),
			dispatch: {
				sequence,
				instructions: offer.instructions,
				profileId: "remote-job",
				provider: "link",
				authorizationId: remoteJobAuthorization(machine.machineId),
				authorizationKind: "profile-derived",
				allowedTools: REMOTE_JOB_LANE_TOOLS,
				writePaths: [],
				leaseTtlMs: deadlineMs + PLACER_GRACE_MS + holdMs + PLACER_GRACE_MS,
			},
		});
		const written = this.session.managedLaneBindings().get(laneId);
		if (!written) throw new Error("remote_job_lane_unrecorded");
		let record: PlacerJobRecord;
		try {
			record = this.store.createPlaced({
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
			});
		} catch (error) {
			// The lane is durable and its record is not: no offer can follow, so the lane ends here instead of at its lease.
			this.endAbandonedLane(laneId, written.dispatchSequence);
			throw error;
		}
		harnessLog.info("placement", "a job was placed on a linked machine", { jobId, peer: machine.machineId });
		journalJob(this.agentDir, { side: "placer", jobId, peer: machine.machineId, event: state });
		this.start();
		this.reconcile();
		return { record, attemptId: written.attemptId, taskId: written.taskId };
	}

	/**
	 * The machine a placement for this idempotency key is already bound to: the machine of its placed job, the most recent when
	 * there are several. Undefined when no placed job exists for the key. Read-only.
	 */
	boundMachine(idempotencyKey: string): string | undefined {
		const selfId = this.selfId();
		let bound: PlacerJobRecord | undefined;
		for (const machine of this.machines.list()) {
			const record = this.store.out.read(placedJobId(selfId, machine.machineId, idempotencyKey));
			if (record && (bound === undefined || record.createdAt > bound.createdAt)) bound = record;
		}
		return bound?.executorId;
	}

	/**
	 * Ends the placer-side lanes a predecessor left open between writing a lane and writing its placed record. A lane with no record
	 * was never offered to its machine, so it ends as `placement_abandoned`; its evidence stays in the lane. Runs once per start,
	 * before this session places or admits anything.
	 */
	private endAbandonedLanes(): void {
		for (const [laneId, binding] of this.session.managedLaneBindings()) {
			if (binding.ended || !laneId.startsWith(REMOTE_LANE_PREFIX)) continue;
			if (!binding.authorizationId?.startsWith(REMOTE_JOB_AUTHORIZATION_PREFIX)) continue;
			if (this.store.out.read(laneId.slice(REMOTE_LANE_PREFIX.length)) !== undefined) continue;
			this.endAbandonedLane(laneId, binding.dispatchSequence);
		}
	}

	/** Ends one abandoned placement lane; a failure is logged and the lane stays as it was (the next start tries again). */
	private endAbandonedLane(laneId: string, dispatchSequence: number): void {
		try {
			this.session.recordManagedLane({
				laneId,
				phase: "terminal",
				dispatchSequence,
				status: "canceled",
				reasonCode: PLACEMENT_ABANDONED,
				summary: "The placement was not recorded, so the job was never offered to its machine.",
			});
		} catch (error) {
			harnessLog.warn("placement", "an abandoned placement lane could not be ended", {
				laneId,
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	/** The owner stops a job; it ends here at once and the executor is told to stop. */
	cancel(jobId: string, reason: JobCancelReason = "owner"): boolean {
		return this.end(jobId, endingOfCancel(reason), reason);
	}

	/**
	 * A revoked machine's jobs end as revoked, whichever session placed them (each owner applies its own), and the jobs
	 * it placed here are stopped.
	 */
	revokeMachine(machineId: string): void {
		for (const record of this.store.out.list())
			if (record.executorId === machineId) this.end(record.jobId, "machine_revoked", "revoked");
		for (const record of this.store.in.list())
			if (record.placerId === machineId)
				this.store.updateExecuted(record.placerId, record.jobId, (current) =>
					current.state === "terminal" || current.cancel ? undefined : { ...current, cancel: "revoked" },
				);
	}

	private end(jobId: string, ending: PlacerEnding, cancel: JobCancelReason): boolean {
		let ended = false;
		this.store.updatePlaced(jobId, (current) => {
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
			journalJob(this.agentDir, {
				side: "placer",
				jobId,
				peer: this.store.out.read(jobId)?.executorId ?? "",
				event: "ended",
				code: ending,
			});
			this.reconcile();
		}
		return ended;
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
	private reconcile(): void {
		if (!this.started) return;
		const sessionId = this.sessionId();
		const now = this.timers.now();
		const holdMs = loadLinkSettings(this.agentDir).offlineHoldMs;
		for (const record of this.store.out.list()) {
			if (record.ownerSession !== sessionId || record.appliedAt !== undefined) continue;
			if (record.progress && record.progress.seq > (this.emittedSeq.get(record.jobId) ?? 0)) {
				this.emittedSeq.set(record.jobId, record.progress.seq);
				this.emit(record.jobId, {
					kind: "progress",
					phase: record.progress.phase,
					...(record.progress.line ? { line: record.progress.line } : {}),
				});
			}
			if (placedJobTerminal(record)) {
				this.apply(record);
				continue;
			}
			if (now >= record.deadlineAt) {
				this.end(record.jobId, "remote_deadline", "deadline");
				continue;
			}
			if (!this.deadlines.has(record.jobId))
				this.deadlines.set(
					record.jobId,
					alarmAt(this.timers, record.deadlineAt, () => this.end(record.jobId, "remote_deadline", "deadline")),
				);
			const machine = this.machines.get(record.executorId);
			const holdUntil =
				machine && !machine.online && machine.offlineSince !== undefined
					? machine.offlineSince + holdMs
					: undefined;
			// A job waits for its machine within the hold, then ends as unreachable so it can be placed elsewhere.
			if (holdUntil !== undefined && now >= holdUntil) this.end(record.jobId, "machine_offline", "superseded");
			else this.holdFor(record.jobId, holdUntil);
		}
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
				// Only a recorded end counts as applied: a failed record stays open and is applied again at the next change
				// of the store or the next start, never dropped.
				const applied = failed
					? undefined
					: this.store.updatePlaced(record.jobId, (current) =>
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
				if (!applied) return;
				this.emit(record.jobId, { kind: "ended", record: applied });
				this.listeners.delete(record.jobId);
				this.emittedSeq.delete(record.jobId);
			});
	}
}
