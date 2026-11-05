import { isDeepStrictEqual } from "node:util";
import type { WorkerDelegationRequest } from "../delegation/worker-delegation-request.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { hostTimeZone } from "./calendar-schedule.ts";
import {
	nextRoutineAt,
	type RoutineDefinitionView,
	type RoutineEventAnchor,
	type RoutineIntakeOrigin,
	RoutineIntakeRefusal,
	type RoutineIntakeRefusalReason,
	type RoutineScheduleInput,
	routineScheduleInputOf,
	routineZoneUnsupported,
} from "./routine-contract.ts";
import type { RoutineSchedulerController } from "./routine-scheduler-controller.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import {
	createRoutineToolDefinition,
	type RoutineToolInput,
	type RoutineToolPort,
	type RoutineToolSummary,
	type RoutineToolView,
} from "./routine-tool.ts";

interface RoutineSessionDeps {
	readonly store: RoutineStorePort;
	readonly scheduler: RoutineSchedulerController;
	readonly parentSessionId: string;
	capture(request: WorkerDelegationRequest, signal?: AbortSignal): Promise<WorkerSavedIntent>;
	invocationKey(callId: string): string;
	/** The session ledger's current position; read only when an event routine is saved. */
	eventAnchor(): RoutineEventAnchor;
	/** Owner-evidence instant (ms) of the session's newest owner source, if any; stamped on every non-intake save. */
	latestOwnerSourceAt(): number | undefined;
	now(): number;
	isDisposed(): boolean;
}

/** A host intake creation: the routine, or why the routine owner refused it. Other failures are thrown. */
export type RoutineIntakeCreation =
	| { readonly created: RoutineToolView }
	| { readonly refused: RoutineIntakeRefusalReason | "admission"; readonly reason: string };

/** The deterministic routine id of one intake origin, so a replay meets its own routine. */
export function routineIntakeRoutineId(origin: RoutineIntakeOrigin): string {
	return `owner-${origin.key.slice(0, 16)}`;
}

function summary(routine: RoutineDefinitionView): RoutineToolSummary {
	const unschedulable = routineZoneUnsupported(routine.schedule);
	const nextRunAt = unschedulable === undefined ? nextRoutineAt(routine.schedule, routine.cursor) : undefined;
	return {
		routineId: routine.routineId,
		revision: routine.revision,
		enabled: routine.enabled,
		schedule: routineScheduleInputOf(routine.schedule),
		...(nextRunAt === undefined ? {} : { nextRunAt }),
		...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
		...(routine.lastStatus === undefined ? {} : { lastStatus: routine.lastStatus }),
		...(unschedulable === undefined ? {} : { unschedulable }),
	};
}

function view(routine: RoutineDefinitionView): RoutineToolView {
	return {
		...summary(routine),
		prompt: routine.prompt,
		...(routine.lastSummary === undefined
			? {}
			: { lastSummary: wrapUntrustedText(routine.lastSummary, `routine-last-summary:${routine.routineId}`) }),
		...(routine.executionSnapshot?.profileId === undefined ? {} : { profileId: routine.executionSnapshot.profileId }),
		knowledge: routine.executionSnapshot?.savedIntent.knowledgeReferences ?? [],
	};
}

/** Model-facing commands are scoped here; target identity and compiled authority never come from model arguments. */
export class RoutineSessionController implements RoutineToolPort {
	private readonly deps: RoutineSessionDeps;
	readonly tool = createRoutineToolDefinition(() => this);

	constructor(deps: RoutineSessionDeps) {
		this.deps = deps;
	}

	async list(after: string | undefined, limit: number, signal?: AbortSignal) {
		this.check(signal);
		const entries = this.deps.store
			.listRoutines()
			.filter((routine) => this.owns(routine) && (after === undefined || routine.routineId > after))
			.sort((left, right) => (left.routineId < right.routineId ? -1 : left.routineId === right.routineId ? 0 : 1));
		const page = entries.slice(0, Math.max(1, Math.min(20, limit)));
		return { routines: page.map(summary), ...(entries.length > page.length ? { next: page.at(-1)!.routineId } : {}) };
	}

	async get(routineId: string, signal?: AbortSignal): Promise<RoutineToolView | undefined> {
		this.check(signal);
		const routine = this.deps.store.getRoutine(routineId);
		return routine && this.owns(routine) ? view(routine) : undefined;
	}

	create(input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView> {
		return this.save(input, undefined, signal);
	}
	update(input: RoutineToolInput, expectedRevision: number, signal?: AbortSignal): Promise<RoutineToolView> {
		return this.save(input, expectedRevision, signal);
	}

	async setEnabled(
		routineId: string,
		expectedRevision: number,
		enabled: boolean,
		signal?: AbortSignal,
	): Promise<RoutineToolView> {
		this.check(signal);
		const routine = this.require(routineId, expectedRevision);
		return view(
			this.deps.store.upsertRoutine({
				routineId,
				expectedRevision,
				target: routine.target,
				prompt: routine.prompt,
				schedule: routineScheduleInputOf(routine.schedule),
				enabled,
				executionSnapshot: routine.executionSnapshot,
				nowMs: this.deps.now(),
			}),
		);
	}

	async delete(routineId: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
		this.check(signal);
		this.require(routineId, expectedRevision);
		if (!this.deps.store.deleteRoutine(routineId, expectedRevision, this.deps.now()))
			throw new Error("Routine changed before deletion.");
	}

	async run(routineId: string, expectedRevision: number, invocationId: string, signal?: AbortSignal) {
		this.check(signal);
		this.require(routineId, expectedRevision);
		const commandId = canonicalDigest({
			parentSessionId: this.deps.parentSessionId,
			invocation: this.deps.invocationKey(invocationId),
		});
		return { occurrenceId: this.deps.scheduler.run(routineId, expectedRevision, commandId) };
	}

	/**
	 * Creates a routine the host derived from the owner's own words: the same parent check, zone default, event
	 * anchor and store write as a tool save, with read-only worker authority and the origin consumed in that write.
	 * Widening its authority is a later routine tool update, never intake.
	 */
	async createFromIntake(
		spec: { readonly prompt: string; readonly schedule: RoutineScheduleInput },
		origin: RoutineIntakeOrigin,
		signal?: AbortSignal,
	): Promise<RoutineIntakeCreation> {
		this.check(signal);
		let savedIntent: WorkerSavedIntent;
		try {
			savedIntent = await this.deps.capture(
				{ instructions: spec.prompt, knowledge: [], objectiveId: null, authority: { readOnly: true } },
				signal,
			);
		} catch (error) {
			// An abort or a disposed session is not the admission's answer; the caller retries or stops.
			this.check(signal);
			return { refused: "admission", reason: error instanceof Error ? error.message : String(error) };
		}
		this.check(signal);
		try {
			const created = this.persist(
				{ routineId: routineIntakeRoutineId(origin), prompt: spec.prompt, schedule: spec.schedule, knowledge: [] },
				savedIntent,
				{ enabled: true, intakeOrigin: origin },
			);
			return { created };
		} catch (error) {
			if (error instanceof RoutineIntakeRefusal) return { refused: error.reason, reason: error.message };
			throw error;
		}
	}

	private async save(
		input: RoutineToolInput,
		expectedRevision: number | undefined,
		signal?: AbortSignal,
	): Promise<RoutineToolView> {
		this.check(signal);
		const prior = expectedRevision === undefined ? undefined : this.require(input.routineId, expectedRevision);
		const sameIntent =
			prior?.executionSnapshot &&
			prior.prompt === input.prompt &&
			prior.executionSnapshot.profileId === input.profileId &&
			isDeepStrictEqual(prior.executionSnapshot.savedIntent.knowledgeReferences, input.knowledge ?? []);
		const savedIntent = sameIntent
			? prior.executionSnapshot!.savedIntent
			: await this.deps.capture(
					{
						instructions: input.prompt,
						profileId: input.profileId,
						knowledge: input.knowledge ?? [],
						objectiveId: null,
					},
					signal,
				);
		this.check(signal);
		const toolAuthoredThrough = this.deps.latestOwnerSourceAt();
		return this.persist(input, savedIntent, {
			enabled: prior?.enabled ?? true,
			...(expectedRevision === undefined ? {} : { expectedRevision }),
			...(prior?.schedule.kind === "calendar" ? { timeZone: prior.schedule.timeZone } : {}),
			...(toolAuthoredThrough === undefined ? {} : { toolAuthoredThrough }),
		});
	}

	/**
	 * The one write of a saved routine for every creation path: the parent check, the calendar zone default, the
	 * event anchor and the store upsert. A create is `createOnly`; an update names the revision it replaces. A calendar
	 * rule without a zone takes `extras.timeZone` (an update's saved zone), else this host's. A tool save stamps the
	 * owner source it answered; an intake creation carries the origin it consumes.
	 */
	private persist(
		input: RoutineToolInput,
		savedIntent: WorkerSavedIntent,
		extras: {
			readonly enabled: boolean;
			readonly expectedRevision?: number;
			readonly timeZone?: string;
			readonly toolAuthoredThrough?: number;
			readonly intakeOrigin?: RoutineIntakeOrigin;
		},
	): RoutineToolView {
		if (savedIntent.receiptOrigin.sessionId !== this.deps.parentSessionId)
			throw new Error("Routine parent changed during admission.");
		return view(
			this.deps.store.upsertRoutine({
				routineId: input.routineId,
				prompt: input.prompt,
				target: { kind: "session", parentSessionId: this.deps.parentSessionId },
				// A calendar rule without a zone keeps the routine's saved zone, or follows the authoring session's wall clock.
				schedule:
					input.schedule.kind === "calendar" && input.schedule.timeZone === undefined
						? { ...input.schedule, timeZone: extras.timeZone ?? hostTimeZone() }
						: input.schedule,
				enabled: extras.enabled,
				nowMs: this.deps.now(),
				...(input.schedule.kind === "event" ? { eventAnchor: this.deps.eventAnchor() } : {}),
				executionSnapshot: {
					parentSessionId: this.deps.parentSessionId,
					parentBranchAnchor: savedIntent.receiptOrigin.leafId,
					savedIntent,
					...(input.profileId === undefined ? {} : { profileId: input.profileId }),
				},
				...(extras.expectedRevision === undefined
					? { createOnly: true }
					: { expectedRevision: extras.expectedRevision }),
				...(extras.toolAuthoredThrough === undefined ? {} : { toolAuthoredThrough: extras.toolAuthoredThrough }),
				...(extras.intakeOrigin === undefined ? {} : { intakeOrigin: extras.intakeOrigin }),
			}),
		);
	}

	private owns(routine: RoutineDefinitionView): boolean {
		return routine.target.kind === "session" && routine.target.parentSessionId === this.deps.parentSessionId;
	}

	private require(routineId: string, revision: number): RoutineDefinitionView {
		const routine = this.deps.store.getRoutine(routineId);
		if (!routine || !this.owns(routine)) throw new Error("Routine is absent from this session.");
		if (routine.revision !== revision) throw new Error("Routine revision changed; read it before editing.");
		return routine;
	}

	private check(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.deps.isDisposed()) throw new Error("Routine session is disposed.");
		this.deps.store.reload();
	}
}
