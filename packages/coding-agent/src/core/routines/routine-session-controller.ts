import { isDeepStrictEqual } from "node:util";
import type { WorkerDelegationRequest } from "../delegation/worker-delegation-request.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { hostTimeZone } from "./calendar-schedule.ts";
import { nextRoutineAt, type RoutineDefinitionView, routineScheduleInputOf } from "./routine-contract.ts";
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
	now(): number;
	isDisposed(): boolean;
}

function summary(routine: RoutineDefinitionView): RoutineToolSummary {
	const nextRunAt = nextRoutineAt(routine.schedule, routine.cursor);
	return {
		routineId: routine.routineId,
		revision: routine.revision,
		enabled: routine.enabled,
		schedule: routineScheduleInputOf(routine.schedule),
		...(nextRunAt === undefined ? {} : { nextRunAt }),
		...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
		...(routine.lastStatus === undefined ? {} : { lastStatus: routine.lastStatus }),
	};
}

function view(routine: RoutineDefinitionView): RoutineToolView {
	return {
		...summary(routine),
		prompt: routine.prompt,
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
		if (savedIntent.receiptOrigin.sessionId !== this.deps.parentSessionId)
			throw new Error("Routine parent changed during admission.");
		return view(
			this.deps.store.upsertRoutine({
				routineId: input.routineId,
				prompt: input.prompt,
				target: { kind: "session", parentSessionId: this.deps.parentSessionId },
				// A calendar rule without a zone follows the wall clock of the session that authored it.
				schedule:
					input.schedule.kind === "calendar" && input.schedule.timeZone === undefined
						? { ...input.schedule, timeZone: hostTimeZone() }
						: input.schedule,
				enabled: prior?.enabled ?? true,
				nowMs: this.deps.now(),
				executionSnapshot: {
					parentSessionId: this.deps.parentSessionId,
					parentBranchAnchor: savedIntent.receiptOrigin.leafId,
					savedIntent,
					...(input.profileId === undefined ? {} : { profileId: input.profileId }),
				},
				...(expectedRevision === undefined ? { createOnly: true } : { expectedRevision }),
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
