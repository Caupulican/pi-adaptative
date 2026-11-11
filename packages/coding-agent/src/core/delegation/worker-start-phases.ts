/**
 * A worker start in two phases, so the fleet can decide a start synchronously after the slow work is done:
 *
 * - `prepare` (asynchronous): the controller's admission of a start (the replay of an earlier start with the same key,
 *   the worker's directory, the route, task fitness, the specialist reuse, worktree isolation, authority and contract).
 *   It persists nothing about the new task; it may hold an identity allocation and a fresh worktree lane until the start
 *   is materialized or released.
 * - `materialize` (synchronous, cheap): the controller's one synchronous step that judges identity headroom again and
 *   persists the task and attempt, then runs it or queues it on the dispatch queue. A replayed start materializes as the
 *   record it already has, so materializing twice never makes two tasks.
 *
 * The parent's own `start` runs both phases back to back. A fleet dispatch is prepared by `FleetScheduler.prepare` and
 * materialized by `FleetScheduler.admit`; a prepared dispatch never admitted is released by the fleet's
 * cancel, stop or disposal, which returns its allocation and removes its unused lane. Every started worker keeps the
 * terminal-signal, bounded-handoff and parent-notify obligations of the controller's run path: nothing here runs a
 * worker by any other path.
 */

import { isAbsolute, resolve } from "node:path";

import type { Api, Model } from "@caupulican/pi-ai";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { FleetDispatch } from "../fleet/fleet-types.ts";
import {
	ESCALATION_AUTHORITY_MISMATCH,
	type FleetLocalStart,
	type FleetLocalStartPort,
	LOCAL_START_RUNTIME_REPLACING,
} from "../fleet/local-admit.ts";
import type { WorkerExecutionAuthorityContract } from "../orchestration/contracts.ts";
import {
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationThinkingLevel,
	type WorkerRole,
} from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import { awaitWorkerStartSettlement, type WorkerModelMove } from "./worker-credential-health.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS } from "./worker-directory-admission.ts";
import type { WorkerDispatchWaitState } from "./worker-dispatch-scheduler.ts";
import { authorityDigest, type RerunPlacement } from "./worker-escalation.ts";
import type { ResolvedWorkerProfilePreset } from "./worker-profile-resolver.ts";

/** Prepared fleet dispatches held at once; a dispatch prepared past it is refused until one is admitted or released. */
export const MAX_PREPARED_DISPATCHES = 256;

/** What `prepare` decided: refused, an already existing worker (a replay or a reused specialist), or a fresh start. */
export type WorkerStartAdmission<A> =
	| { kind: "refused"; skipReason: string }
	| { kind: "existing"; record: LaneRecord; replayed: boolean }
	| { kind: "fresh"; admission: A; releaseAllocation?: () => void };

/** What `materialize` did with a fresh start: persisted it (running or queued), or refused it. */
export type WorkerStartMaterialized =
	| { started: false; skipReason: string }
	| {
			started: true;
			record: LaneRecord;
			modelPinBypass?: WorkerRole;
			startSettled?: Promise<readonly WorkerModelMove[]>;
	  };

/** The parent's answer for one start. */
export type QueuedWorkerAttemptOutcome =
	| { started: false; skipReason: string }
	| {
			started: true;
			record: LaneRecord;
			modelPinBypass?: WorkerRole;
			/** Active lanes whose instructions resemble this one; the parent decides whether one is a copy. */
			similarLaneIds?: string[];
			/** Moves the worker already made off its admitted model while its start credentials settled. */
			modelMoves?: readonly WorkerModelMove[];
	  };

/** What the phases read from, and ask of, the worker controller. `A` is the controller's fresh admission. */
export interface WorkerStartPhasePort<A> {
	/** Aborted when the controller is disposed. */
	readonly closed: AbortSignal;
	/** The request as the controller keeps it: cloned, with its knowledge grant and receipt origin captured. */
	capture(request: WorkerDelegationRequest): WorkerDelegationRequest;
	/** Runs `run` under the runtime generation's admission; `aborted` answers when admission never came. */
	admitted<T>(run: () => Promise<T>, aborted: () => T, signal?: AbortSignal): Promise<T>;
	/** Runs `run` synchronously under the runtime generation's admission; undefined while a replacement holds it. */
	admittedNow<T>(run: () => T): T | undefined;
	prepare(request: WorkerDelegationRequest, signal?: AbortSignal): Promise<WorkerStartAdmission<A>>;
	materialize(request: WorkerDelegationRequest, admission: A): WorkerStartMaterialized;
	/** The session's working directory: the base the request's relative write and read scopes resolve against. */
	sessionCwd(): string;
	/** The model a fresh admission runs on. */
	admissionModel(admission: A): Model<Api>;
	/** The authority a fresh admission runs under: what an escalation's rerun must keep. */
	admittedAuthority(admission: A): WorkerExecutionAuthorityContract;
	/** Where a fresh admission runs and in which isolation: compared with an escalation's recorded placement. */
	admittedPlacement(admission: A): RerunPlacement;
	/** The verifier a plan verify step runs as, derived from its subject attempt's admitted contract. */
	planVerifierPreset(subject: {
		readonly subjectTaskId: string;
		readonly subjectAttemptId: string;
	}): { ok: true; resolved: ResolvedWorkerProfilePreset } | { ok: false; reason: string };
	/** The fresh lane directory a start that never ran leaves behind, removed by `discardLaneDirectory`. */
	laneDirectory(admission: A): string;
	discardLaneDirectory(cwd: string): Promise<void> | undefined;
	fanoutHeadroomSkipReason(request: WorkerDelegationRequest, remaining: number): string | undefined;
	similarLaneIds(request: WorkerDelegationRequest): readonly string[];
	currentRecord(laneId: string): LaneRecord | undefined;
	/** The record with this generation's dispatch wait reason attached. */
	withWaitReason(record: LaneRecord): LaneRecord;
	activeAttempt(laneId: string): AttemptRuntimeState | undefined;
	/** A task's most recent attempt, whether or not it is still active. */
	lastAttempt(taskId: string): AttemptRuntimeState | undefined;
	waitState(laneId: string): WorkerDispatchWaitState | undefined;
	warn(message: string): void;
}

interface PreparedDispatch<A> {
	readonly request: WorkerDelegationRequest;
	readonly selected: Exclude<WorkerStartAdmission<A>, { kind: "refused" }>;
}

/** One thinking level above `level` (the highest stays); `off` is the base when the previous level is unknown. */
function raisedThinking(level: OrchestrationThinkingLevel | undefined): OrchestrationThinkingLevel {
	const index = ORCHESTRATION_THINKING_LEVELS.indexOf(level ?? "off");
	return ORCHESTRATION_THINKING_LEVELS[Math.min(ORCHESTRATION_THINKING_LEVELS.length - 1, index + 1)] ?? "off";
}

/** The directory a rerun's pinned location names: the session root, an absolute path, or a path under the session root. */
function locationBase(location: string, sessionCwd: string): string {
	if (location === ".") return sessionCwd;
	return isAbsolute(location) ? location : resolve(sessionCwd, location);
}

/**
 * The worker request a fleet dispatch stands for. Deterministic in the dispatch alone (plus the superseded attempt's
 * thinking for a raised escalation), so a dispatch prepared again after a restart replays its durable start through
 * `messageReplayKey` instead of conflicting with it. The dependency ids are a display mirror (the plan graph gates
 * order) and the isolation follows the controller's own worktree rule for a writing worker.
 */
export function workerRequestForDispatch(
	dispatch: FleetDispatch,
	supersededThinking: OrchestrationThinkingLevel | undefined,
	sessionCwd: string,
	verifier?: ResolvedWorkerProfilePreset,
): WorkerDelegationRequest {
	const thinkingLevel =
		dispatch.thinking === "inherit"
			? undefined
			: dispatch.thinking === "raise_one"
				? raisedThinking(supersededThinking)
				: dispatch.thinking;
	const pinned = dispatch.escalation?.pinned;
	const inLane = pinned?.location === "lane";
	const freshPinnedLane = inLane && pinned.laneDirectory === undefined;
	// A rerun's scopes are relative to where its original's cwd sat (the reused lane directory for an in-place lane rerun, or
	// the session cwd before `isolateFreshWriter` relocates a fresh lane rerun); a plan step's are relative to the session cwd.
	const base = pinned
		? inLane
			? (pinned.laneDirectory ?? sessionCwd)
			: locationBase(pinned.location, sessionCwd)
		: sessionCwd;
	const fromBase = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
	const writePaths = dispatch.writeScope.map(fromBase);
	const pinnedPath = inLane
		? dispatch.escalation?.attemptOfTaskId
			? undefined
			: pinned.laneDirectory
		: pinned && pinned.location !== "."
			? pinned.location
			: undefined;
	const authority = {
		...(dispatch.model ? { model: { provider: dispatch.model.provider, modelId: dispatch.model.modelId } } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(writePaths.length > 0 ? { writePaths } : {}),
		// A plan step that names no files is read-only work, as an assigned task that names none is: the plan runs such steps
		// side by side in the shared checkout on that promise. A rerun keeps what its original was admitted with.
		...(dispatch.plan && !pinned && writePaths.length === 0 ? { readOnly: true } : {}),
		// A review inspects the workspace its subject worked in, which is a worktree lane until that work lands.
		...(dispatch.verification?.directory && !pinned ? { path: dispatch.verification.directory } : {}),
		...(pinned
			? {
					...(pinned.role !== undefined ? { role: pinned.role } : {}),
					...(pinned.capabilities !== undefined ? { capabilities: [...pinned.capabilities] } : {}),
					...(pinned.toolNames !== undefined ? { toolNames: [...pinned.toolNames] } : {}),
					readOnly: pinned.readOnly,
					...(pinned.shellReadOnly ? { shellReadOnly: true } : {}),
					...(pinned.readScope !== undefined ? { readPaths: pinned.readScope.map(fromBase) } : {}),
					budget: { ...pinned.budget },
					// The original's workspace: set for a read-only lane review rerun or non-root shared path; omitted for `attemptOf` lane reruns (adopted via `prior`) and fresh lanes.
					...(pinnedPath !== undefined ? { path: pinnedPath } : {}),
				}
			: {}),
	};
	return {
		instructions: dispatch.instructions,
		...(dispatch.brief ? { brief: dispatch.brief } : {}),
		objectiveId: dispatch.demand.objectiveId,
		// A brokered start belongs to its leader's delegation objective, never to the foreground goal.
		...(dispatch.delegation ? { delegationObjectiveId: dispatch.delegation.objectiveId } : {}),
		// A rerun is admitted as the original was: its registered profile, parent, bot soul, origins and checkout.
		...(pinned?.profileId !== undefined ? { profileId: pinned.profileId } : {}),
		// A plan verify step runs its derived read-only review run, anchored on the first result it checks. It is not a verification
		// of that result: the anchor names the review's subject and the review reconciles nothing.
		...(dispatch.verification && verifier
			? {
					profileId: verifier.profile.profileId,
					verifierPreset: verifier,
					reviewOf: {
						taskId: dispatch.verification.subjectTaskId,
						attemptId: dispatch.verification.subjectAttemptId,
					},
				}
			: {}),
		...(dispatch.plan ? { planStep: { planId: dispatch.plan.planId, nodeId: dispatch.plan.nodeId } } : {}),
		// The lane waits where its dispatch demands: a verify step first, then the plan's critical path.
		fleetRank: { priority: dispatch.demand.priority, criticalPath: dispatch.demand.onCriticalPath },
		...(pinned?.parentAgentId !== undefined ? { parentAgentId: pinned.parentAgentId } : {}),
		...(pinned?.botSoul !== undefined ? { botSoul: pinned.botSoul } : {}),
		...(pinned?.turnOrigin !== undefined ? { turnOrigin: pinned.turnOrigin } : {}),
		...(pinned?.receiptOrigin !== undefined ? { receiptOrigin: pinned.receiptOrigin } : {}),
		...(pinned
			? { isolation: freshPinnedLane ? ("worktree" as const) : ("shared" as const) }
			: dispatch.isolation === "worktree"
				? { isolation: "worktree" as const }
				: {}),
		// A fresh worktree-lane rerun needs its own new worker identity so `isolateFreshWriter` binds a new lane rather than reusing an idle specialist.
		...(freshPinnedLane
			? {
					parallelWork: {
						independentOf: dispatch.escalation?.supersedesTaskId ? [dispatch.escalation.supersedesTaskId] : [],
						justification: "Escalation rerun isolated in a fresh worktree lane.",
					},
				}
			: {}),
		...(dispatch.escalation?.attemptOfTaskId ? { attemptOf: { taskId: dispatch.escalation.attemptOfTaskId } } : {}),
		messageReplayKey: `fleet:${dispatch.idempotencyKey}`,
		...(Object.keys(authority).length > 0 ? { authority } : {}),
		taskContext: {
			requirementIds: [...(dispatch.escalation?.requirementIds ?? dispatch.requirementIds)],
			dependsOnTaskIds: [],
			acceptanceCriterionIds: [...(dispatch.escalation?.acceptanceCriterionIds ?? [])],
			resourcePointerIds: [],
		},
	};
}

export class WorkerStartPhases<A> implements FleetLocalStartPort {
	private readonly port: WorkerStartPhasePort<A>;
	private readonly prepared = new Map<string, PreparedDispatch<A>>();
	private readonly preparing = new Map<string, Promise<{ ok: true } | { ok: false; skipReason: string }>>();

	constructor(port: WorkerStartPhasePort<A>) {
		this.port = port;
	}

	/** The parent's start: prepare, then materialize at once. */
	start(request: WorkerDelegationRequest, signal?: AbortSignal): Promise<QueuedWorkerAttemptOutcome> {
		if (this.port.closed.aborted) return Promise.resolve({ started: false, skipReason: "session_disposed" });
		const captured = this.port.capture(request);
		return this.port.admitted(
			() => this.startCaptured(captured, signal),
			() => ({
				started: false,
				skipReason: this.port.closed.aborted ? "session_disposed" : "worker_start_aborted",
			}),
			signal,
		);
	}

	// ---- the fleet half (FleetLocalStartPort) ----

	prepare(dispatch: FleetDispatch, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; skipReason: string }> {
		const key = dispatch.idempotencyKey;
		if (this.prepared.has(key)) return Promise.resolve({ ok: true });
		const running = this.preparing.get(key);
		if (running) return running;
		if (this.port.closed.aborted) return Promise.resolve({ ok: false, skipReason: "session_disposed" });
		if (this.prepared.size + this.preparing.size >= MAX_PREPARED_DISPATCHES)
			return Promise.resolve({ ok: false, skipReason: "worker_dispatch_queue_full" });
		const basis = dispatch.escalation?.attemptOfTaskId ?? dispatch.escalation?.supersedesTaskId;
		const last = basis ? this.port.lastAttempt(basis) : undefined;
		const supersededThinking = (last?.runningModel ?? last?.dispatch.executionContract?.worker.modelBinding)
			?.thinkingLevel;
		const verifier = dispatch.verification ? this.port.planVerifierPreset(dispatch.verification) : undefined;
		if (verifier && !verifier.ok) return Promise.resolve({ ok: false, skipReason: verifier.reason });
		const captured = this.port.capture(
			workerRequestForDispatch(
				dispatch,
				supersededThinking,
				this.port.sessionCwd(),
				verifier?.ok ? verifier.resolved : undefined,
			),
		);
		const preparation = this.port
			.admitted(
				async (): Promise<{ ok: true } | { ok: false; skipReason: string }> => {
					const selected = await this.port.prepare(captured, signal);
					if (selected.kind === "refused") return { ok: false, skipReason: selected.skipReason };
					// An escalation reruns under the authority its outcome was recorded under. Only the admission made here
					// knows what the rerun would run under, so the comparison happens before anything is materialized.
					if (
						selected.kind === "fresh" &&
						dispatch.escalation &&
						authorityDigest(
							this.port.admittedAuthority(selected.admission),
							this.port.admittedPlacement(selected.admission),
						) !== dispatch.escalation.authorityDigest
					) {
						selected.releaseAllocation?.();
						this.discard(this.port.laneDirectory(selected.admission));
						return { ok: false, skipReason: ESCALATION_AUTHORITY_MISMATCH };
					}
					this.prepared.set(key, { request: captured, selected });
					return { ok: true };
				},
				() => ({ ok: false, skipReason: this.port.closed.aborted ? "session_disposed" : "worker_start_aborted" }),
				signal,
			)
			.finally(() => this.preparing.delete(key));
		this.preparing.set(key, preparation);
		return preparation;
	}

	preparedModel(idempotencyKey: string): Model<Api> | undefined {
		const selected = this.prepared.get(idempotencyKey)?.selected;
		return selected?.kind === "fresh" ? this.port.admissionModel(selected.admission) : undefined;
	}

	materialize(dispatch: FleetDispatch): FleetLocalStart | undefined {
		const key = dispatch.idempotencyKey;
		const entry = this.prepared.get(key);
		if (!entry) return undefined;
		const { selected } = entry;
		if (selected.kind === "existing") {
			this.prepared.delete(key);
			return this.localStart(selected.record);
		}
		// A fleet admit holds no runtime admission of its own: take it for this one synchronous step. While a runtime
		// replacement holds it, the dispatch stays prepared and the refusal says so; a later admit materializes it.
		const outcome = this.port.admittedNow((): WorkerStartMaterialized => {
			this.prepared.delete(key);
			try {
				return this.port.materialize(entry.request, selected.admission);
			} catch (error) {
				return {
					started: false,
					skipReason: `worker_start_error:${error instanceof Error ? error.message : String(error)}`,
				};
			} finally {
				selected.releaseAllocation?.();
			}
		});
		if (!outcome) return { started: false, skipReason: LOCAL_START_RUNTIME_REPLACING };
		if (!outcome.started) {
			this.discard(this.port.laneDirectory(selected.admission));
			return outcome;
		}
		return this.localStart(outcome.record);
	}

	/** Releases one prepared dispatch, or every one: its allocation is returned and its unused fresh lane removed. */
	release(idempotencyKey?: string): void {
		const keys = idempotencyKey === undefined ? [...this.prepared.keys()] : [idempotencyKey];
		for (const key of keys) {
			const entry = this.prepared.get(key);
			if (!entry) continue;
			this.prepared.delete(key);
			if (entry.selected.kind !== "fresh") continue;
			entry.selected.releaseAllocation?.();
			this.discard(this.port.laneDirectory(entry.selected.admission));
		}
	}

	// ---- internals ----

	private async startCaptured(
		request: WorkerDelegationRequest,
		signal?: AbortSignal,
	): Promise<QueuedWorkerAttemptOutcome> {
		if (request.fanoutRemaining !== undefined && request.fanoutRemaining > 1) {
			const headroomSkipReason = this.port.fanoutHeadroomSkipReason(request, request.fanoutRemaining);
			if (headroomSkipReason) return { started: false, skipReason: headroomSkipReason };
		}
		const selected = await this.port.prepare(request, signal);
		if (selected.kind === "refused") return { started: false, skipReason: selected.skipReason };
		// A reused specialist's turn or a replayed start can be queued too: its record says why, like a fresh lane's.
		if (selected.kind === "existing") return { started: true, record: this.port.withWaitReason(selected.record) };
		const similar = this.port.similarLaneIds(request);
		let outcome: WorkerStartMaterialized;
		try {
			outcome = this.port.materialize(request, selected.admission);
		} finally {
			selected.releaseAllocation?.();
		}
		if (!outcome.started) {
			// A start that never ran leaves its fresh worktree lane unused: remove it.
			await this.port.discardLaneDirectory(this.port.laneDirectory(selected.admission));
			return outcome;
		}
		const { startSettled, ...started } = outcome;
		// A running worker's result names the model it settled on, and the moves on the way, so the parent never probes
		// credentials or names a model to work around a login the harness already routed past. Bounded: past it, the
		// admitted model is reported and the lane's status shows any later move.
		const modelMoves = startSettled
			? await awaitWorkerStartSettlement(
					startSettled,
					AbortSignal.any([
						this.port.closed,
						AbortSignal.timeout(WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS),
						...(signal ? [signal] : []),
					]),
				)
			: undefined;
		const record = (modelMoves ? this.port.currentRecord(started.record.laneId) : undefined) ?? started.record;
		return {
			...started,
			record: this.port.withWaitReason(record),
			...(similar.length > 0 ? { similarLaneIds: [...similar] } : {}),
			...(modelMoves && modelMoves.length > 0 ? { modelMoves } : {}),
		};
	}

	/** A materialized lane as the fleet reads it: its attempt, whether it runs, and why it waits. */
	private localStart(record: LaneRecord): FleetLocalStart {
		const attempt = this.port.activeAttempt(record.laneId);
		if (!attempt) return { started: false, skipReason: "orchestration_attempt_missing" };
		const binding = attempt.dispatch.executionContract?.worker.modelBinding;
		const wait = this.port.waitState(record.laneId);
		return {
			started: true,
			laneId: record.laneId,
			attemptId: attempt.attemptId,
			running: attempt.status === "leased" || attempt.status === "running",
			...(binding ? { modelRef: `${binding.provider}/${binding.modelId}`, provider: binding.provider } : {}),
			...(wait ? { wait: { reason: wait.reason, ...(wait.detail ? { detail: wait.detail } : {}) } } : {}),
		};
	}

	private discard(cwd: string): void {
		const removal = this.port.discardLaneDirectory(cwd);
		if (!removal) return;
		removal.catch((error: unknown) => {
			this.port.warn(
				`An unused worker lane could not be removed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}
