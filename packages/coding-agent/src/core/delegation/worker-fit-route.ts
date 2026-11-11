/**
 * The worker task-fit route: fitness checks for fresh and queued starts and the per-attempt record of candidates judged unfit.
 * A fresh start moves to its next ranked candidate on an inadequate or open judgment (`nextCandidate`). A queued start does the
 * same inside its own attempt: the candidate it judged unfit is recorded (`unfitFor`), and its pinned contract resolves past it,
 * so the lane moves without a new attempt or event. Every candidate is one the pinned contract already lists, so the move never
 * changes authority.
 */

import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@caupulican/pi-ai";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { HostEventSubscriptionInput } from "../events/host-event-contract.ts";
import { buildCapabilityCard, describeModelCard } from "../expert-routing/capability-card.ts";
import type { RouteChoiceJudge, WorkerTaskFitInput } from "../expert-routing/system-one-choice.ts";
import { exhaustedTaskFitReason, type WorkerTaskFitVerdict } from "../expert-routing/worker-task-fit-exits.ts";
import { WorkerTaskFitness, type WorkerTaskFitnessFailure } from "../expert-routing/worker-task-fitness.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { KnowledgeGrant, KnowledgeGrantReference } from "../memory/knowledge-grant.ts";
import type { ModelRegistry } from "../model-registry.ts";
import {
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	type OrchestrationModelBinding,
	type WorkerExecutionContract,
	type WorkerModelRouteSource,
	type WorkerRole,
} from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { ResolvedWorkerDelegationSettings } from "../settings/settings-schema.ts";
import type { ParentExecutionSettingsSource } from "./parent-execution-context.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import { workerFitnessInstructions } from "./worker-fanout-header.ts";
import type { ResolvedWorkerProfile } from "./worker-profile-resolver.ts";

/** The most attempts whose unfit candidates are kept; the oldest attempt's record is dropped first. */
const MAX_UNFIT_ATTEMPTS = 256;
const FALLBACK_FITNESS_CODE = "worker_task_fitness_binding_unavailable";

/** A worker's resolved start, or the reason it cannot start. */
export type WorkerAdmission =
	| {
			ok: true;
			instructions: string;
			settings: ResolvedWorkerDelegationSettings;
			shipment: ResolvedWorkerProfile;
			verifierShipment?: ResolvedWorkerProfile;
			/** Exact pointer selection persisted when this request is admitted. */
			resourcePointerIds: readonly string[];
			executionContract: WorkerExecutionContract;
			executionPlan: WorkerExecutionPlan;
			knowledgeGrant?: KnowledgeGrant;
			knowledgeReferences: readonly KnowledgeGrantReference[];
			subscriptions: readonly HostEventSubscriptionInput[];
			/** Existing task identity, revalidated after asynchronous fitness admission. */
			admittedAttemptId?: string;
			/** Who chose the admitted model (never the router): recorded on the dispatch for the operator. */
			modelRouteSource: WorkerModelRouteSource;
			modelPinSource?: string;
			/**
			 * Set when a pin policy is active, the effective role has no pin (a roles-only config
			 * with no `default` leaves it unpinned), and the caller requested an explicit model —
			 * i.e. the owner's pin was evaded, not just inapplicable. Diagnostics only: admission is
			 * never blocked on this. Value is the effective role that bypassed the policy.
			 */
			modelPinBypass?: WorkerRole;
	  }
	| { ok: false; skipReason: string };

/** Keep the original route provenance and pin diagnostics across contract/directory re-admission. */
export function preserveWorkerAdmissionRoute(
	current: Extract<WorkerAdmission, { ok: true }>,
	origin: Pick<Extract<WorkerAdmission, { ok: true }>, "modelRouteSource" | "modelPinSource" | "modelPinBypass">,
): Extract<WorkerAdmission, { ok: true }> {
	return {
		...current,
		modelRouteSource: origin.modelRouteSource,
		...(origin.modelPinSource ? { modelPinSource: origin.modelPinSource } : {}),
		...(origin.modelPinBypass ? { modelPinBypass: origin.modelPinBypass } : {}),
	};
}

/** What the fit route reads from, and asks of, the worker controller. */
export interface WorkerFitRoutePort {
	settings(): ParentExecutionSettingsSource;
	isSystemOneEnabled(): boolean;
	routeJudge(): RouteChoiceJudge | undefined;
	sessionId(): string;
	cwd(): string;
	isDisposed(): boolean;
	abortSignal(): AbortSignal;
	modelRegistry(): ModelRegistry;
	snapshot(): TaskRuntimeProjection;
	activeAttempt(laneId: string): AttemptRuntimeState | undefined;
	goalFor(request: WorkerDelegationRequest): GoalState | undefined;
	isRouteModelAvailable(model: Model<Api> | undefined): boolean;
	resolveAdmission(
		request: WorkerDelegationRequest,
		pinned?: WorkerExecutionContract,
		binding?: OrchestrationModelBinding,
		attempt?: AttemptRuntimeState,
	): WorkerAdmission;
}

function modelRefOf(binding: { readonly provider: string; readonly modelId: string }): string {
	return `${binding.provider}/${binding.modelId}`;
}

/**
 * A reason as a failure: the code before its first colon when that is a bounded identifier, and the rest, redacted, as the
 * detail. A reason whose code is not an identifier is the detail whole, under `fallbackCode`.
 */
function failureOfReason(reason: string, fallbackCode: string): WorkerTaskFitnessFailure {
	const separator = reason.indexOf(":");
	const code = separator < 0 ? reason : reason.slice(0, separator);
	const validCode = code.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH && /^[A-Za-z0-9._-]+$/.test(code);
	const diagnostic = validCode ? (separator < 0 ? undefined : reason.slice(separator + 1)) : reason;
	const detail = diagnostic ? boundedRedactedDiagnosticText(diagnostic) : undefined;
	return { reasonCode: validCode ? code : fallbackCode, ...(detail ? { detail } : {}) };
}

export class WorkerFitRoute {
	private readonly port: WorkerFitRoutePort;
	private readonly taskFitness = new WorkerTaskFitness();
	/** Candidates judged unfit per queued attempt; consulted when its pinned contract is resolved. At most 256 attempts. */
	private readonly unfit = new Map<string, Set<string>>();

	constructor(port: WorkerFitRoutePort) {
		this.port = port;
	}

	/** The candidates judged unfit for a queued attempt, read when its pinned contract is resolved. */
	unfitFor(attemptId: string): ReadonlySet<string> | undefined {
		return this.unfit.get(attemptId);
	}

	private enabled(): boolean {
		return (
			this.port.settings().getModelRouterSettings().enabled &&
			this.port.settings().getModelRouterSettings().fitnessGate === true &&
			this.port.isSystemOneEnabled() &&
			this.port.routeJudge()?.isRouteJudgmentEnabled?.() !== false
		);
	}

	private fitnessInput(
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
		fitnessInstructions = request.instructions,
	): WorkerTaskFitInput {
		return {
			instructions: workerFitnessInstructions(fitnessInstructions),
			objective: this.port.goalFor(request)?.userGoal ?? "",
			model: describeModelCard(
				buildCapabilityCard(admission.shipment.model, { subscription: false, evidence: "unprobed" }),
			),
			thinkingLevel: admission.shipment.modelBinding.thinkingLevel,
			role: admission.shipment.profile.role,
		};
	}

	/**
	 * The admission of a running or queued attempt. Re-resolving its pinned contract reports the route as `contract`, so the
	 * route the attempt was admitted under is read from its recorded provenance: an inherited route is judged unbound, as on
	 * the fresh path.
	 */
	private existingAdmission(request: WorkerDelegationRequest, record: LaneRecord): WorkerAdmission {
		const attempt = this.port.activeAttempt(record.laneId);
		if (!attempt) return { ok: false, skipReason: "worker_task_fitness_binding_unavailable" };
		const admission = this.port.resolveAdmission(request, attempt.dispatch.executionContract, undefined, attempt);
		const recorded = attempt.dispatch.modelRouteSource;
		return admission.ok && recorded !== undefined ? { ...admission, modelRouteSource: recorded } : admission;
	}

	/** The judgment of a running or queued start's current admission. */
	async checkExisting(
		request: WorkerDelegationRequest,
		record: LaneRecord,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		const admission = this.existingAdmission(request, record);
		if (admission.ok) return this.check(request, admission);
		// Non-fitness admission owners already return a reason followed by an optional diagnostic.
		return failureOfReason(admission.skipReason, FALLBACK_FITNESS_CODE);
	}

	/**
	 * The scheduler's preflight for a queued start. An unbound route whose pinned contract is an ordered fallback does not cancel
	 * on an inadequate or open judgment: it records the candidate as unfit for this attempt and re-resolves, and the start moves
	 * to the next candidate the contract lists. The candidates run out into the judgments' own reason.
	 */
	async checkQueued(
		request: WorkerDelegationRequest,
		record: LaneRecord,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		const verdicts: WorkerTaskFitVerdict[] = [];
		let failure = await this.checkExisting(request, record);
		while (failure) {
			const attempt = this.port.activeAttempt(record.laneId);
			if (
				attempt?.dispatch.modelRouteSource !== "inherited" ||
				failure.fit === undefined ||
				attempt.dispatch.executionContract?.worker.profile.modelPolicy.mode !== "ordered-fallback"
			)
				return failure;
			const judged = this.existingAdmission(request, record);
			if (!judged.ok) return failure;
			verdicts.push(failure.fit);
			this.markUnfit(attempt.attemptId, modelRefOf(judged.shipment.modelBinding));
			const next = this.existingAdmission(request, record);
			if (!next.ok || this.unfit.get(attempt.attemptId)?.has(modelRefOf(next.shipment.modelBinding)))
				return failureOfReason(exhaustedTaskFitReason(verdicts), FALLBACK_FITNESS_CODE);
			failure = await this.checkExisting(request, record);
		}
		return undefined;
	}

	private markUnfit(attemptId: string, modelRef: string): void {
		const refs = this.unfit.get(attemptId);
		if (refs) {
			refs.add(modelRef);
			return;
		}
		if (this.unfit.size >= MAX_UNFIT_ATTEMPTS) {
			const [oldest] = this.unfit.keys();
			if (oldest !== undefined) this.unfit.delete(oldest);
		}
		this.unfit.set(attemptId, new Set([modelRef]));
	}

	/** Pure lookup while the scheduler still owns the queue, immediately before synchronous dispatch. */
	hasCurrent(request: WorkerDelegationRequest, record: LaneRecord): boolean {
		if (!this.enabled()) return true;
		try {
			const admission = this.existingAdmission(request, record);
			return (
				admission.ok && this.taskFitness.hasAccepted(this.port.routeJudge(), this.fitnessInput(request, admission))
			);
		} catch {
			// The owned preflight reports the actual failure through the existing cancellation path.
			return false;
		}
	}

	/**
	 * The next ranked fallback candidate an unbound route has not been judged on, admitted under the route's own source.
	 * Undefined when the profile has no ordered fallback left that resolves and is available.
	 */
	nextCandidate(
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
		judgedModelRefs: ReadonlySet<string>,
	): Extract<WorkerAdmission, { ok: true }> | undefined {
		const policy = admission.executionContract.worker.profile.modelPolicy;
		if (policy.mode !== "ordered-fallback") return undefined;
		for (const candidate of policy.candidates) {
			if (judgedModelRefs.has(`${candidate.provider}/${candidate.modelId}`)) continue;
			const model = this.port.modelRegistry().find(candidate.provider, candidate.modelId);
			if (!this.port.isRouteModelAvailable(model)) continue;
			// Admitted as route selection admits a candidate: under the directory the original start captured, on the
			// candidate's own binding, and only when the authority is the original's (a candidate never widens the grant).
			const compiled = this.port.resolveAdmission(
				{ ...request, executionContext: admission.executionContract.worker.executionContext },
				undefined,
				candidate,
			);
			if (!compiled.ok || !isDeepStrictEqual(compiled.shipment.modelBinding, candidate)) continue;
			if (
				!isDeepStrictEqual(
					compiled.executionContract.worker.authority,
					admission.executionContract.worker.authority,
				)
			)
				continue;
			return { ...compiled, modelRouteSource: admission.modelRouteSource };
		}
		return undefined;
	}

	/** The same final task/model check covers explicit, inherited and fallback worker bindings. */
	async check(
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
		signal?: AbortSignal,
		fitnessInstructions = request.instructions,
	): Promise<WorkerTaskFitnessFailure | undefined> {
		if (!this.enabled()) return;
		const judge = this.port.routeJudge();
		const sessionId = this.port.sessionId();
		const cwd = this.port.cwd();
		const objective = this.port.goalFor(request)?.userGoal;
		const binding = admission.shipment.modelBinding;
		const model = structuredClone(admission.shipment.model);
		let failure: WorkerTaskFitnessFailure | undefined;
		try {
			failure = await this.taskFitness.check(
				judge,
				this.fitnessInput(request, admission, fitnessInstructions),
				signal ?? this.port.abortSignal(),
				// Only an inherited route may move: a pinned, named or profile-bound model keeps its pending question.
				{ bound: admission.modelRouteSource !== "inherited" },
			);
		} catch (error) {
			failure = {
				reasonCode: "worker_task_fitness_unavailable",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		if (!this.enabled()) return;
		const current = this.port.resolveAdmission(
			{ ...request, profileId: admission.executionContract.worker.profile.profileId },
			admission.executionContract,
			undefined,
			admission.admittedAttemptId ? this.port.snapshot().attempts[admission.admittedAttemptId] : undefined,
		);
		if (
			(admission.admittedAttemptId !== undefined &&
				current.ok &&
				current.admittedAttemptId !== admission.admittedAttemptId) ||
			this.port.isDisposed() ||
			this.port.sessionId() !== sessionId ||
			this.port.cwd() !== cwd ||
			this.port.routeJudge() !== judge ||
			this.port.goalFor(request)?.userGoal !== objective ||
			!current.ok ||
			!isDeepStrictEqual(current.shipment.modelBinding, binding) ||
			!isDeepStrictEqual(current.shipment.model, model)
		)
			return { reasonCode: "worker_task_fitness_stale" };
		if (!failure?.detail) return failure;
		const detail = boundedRedactedDiagnosticText(failure.detail);
		return { reasonCode: failure.reasonCode, ...(detail ? { detail } : {}) };
	}
}
