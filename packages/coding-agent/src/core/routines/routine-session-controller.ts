import { isDeepStrictEqual } from "node:util";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerDelegationRequest } from "../delegation/worker-delegation-request.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { strictCanonicalDigest } from "../steering/canonical.ts";
import { hostTimeZone } from "./calendar-schedule.ts";
import {
	nextRoutineAt,
	ROUTINE_UNFINISHED_PHASES,
	type RoutineDefinitionView,
	type RoutineEventAnchor,
	type RoutineIntakeOrigin,
	RoutineIntakeRefusal,
	type RoutineIntakeRefusalReason,
	type RoutineScheduleInput,
	routineEnded,
	routineScheduleInputOf,
	routineStartWindow,
	routineZoneUnsupported,
} from "./routine-contract.ts";
import { describeRoutineProgress } from "./routine-progress.ts";
import type { RoutineSchedulerController } from "./routine-scheduler-controller.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import {
	createRoutineToolDefinition,
	type RoutineToolInput,
	type RoutineToolPort,
	type RoutineToolSummary,
	type RoutineToolView,
} from "./routine-tool.ts";
import { describeWatchCondition, parseWatchCondition, type WatchCondition } from "./watch-contract.ts";

interface RoutineSessionDeps {
	readonly store: RoutineStorePort;
	readonly scheduler: RoutineSchedulerController;
	readonly parentSessionId: string;
	capture(request: WorkerDelegationRequest, signal?: AbortSignal): Promise<WorkerSavedIntent>;
	invocationKey(callId: string): string;
	/** The session ledger's current position; read only when an event routine is saved. */
	eventAnchor(): RoutineEventAnchor;
	/**
	 * The session's admission of a watch condition, the one the monitor applies again at every evaluation: it returns the
	 * condition in canonical form (a file's absolute path) or throws the reason the session may not watch it.
	 */
	admitWatch(condition: WatchCondition): WatchCondition;
	/**
	 * Owner sources recorded in the current run: the model's context holds every one of them while a tool call of the
	 * run executes. Empty when the owner said nothing in it (a routine result, CI event or other host input opened it)
	 * or no run is active.
	 */
	ownerTurnSources(): readonly string[];
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

function summary(routine: RoutineDefinitionView, store: RoutineStorePort, nowMs: number): RoutineToolSummary {
	const unschedulable = routineZoneUnsupported(routine.schedule);
	const nextRunAt =
		unschedulable === undefined && !routine.conditionMet
			? nextRoutineAt(routine.schedule, routine.cursor)
			: undefined;
	// The window as the claim reads it: an unfinished run of the routine holds it shut, and an ended routine starts nothing.
	const opensAt =
		nextRunAt === undefined || routineEnded(routine, nowMs) !== undefined
			? undefined
			: routineStartWindow(
					routine,
					routine.cursor,
					store.listRoutineOccurrences({ routineId: routine.routineId, phases: ROUTINE_UNFINISHED_PHASES }),
				)?.opensAt;
	return {
		routineId: routine.routineId,
		revision: routine.revision,
		enabled: routine.enabled,
		schedule: routineScheduleInputOf(routine.schedule),
		...(routine.schedule.kind === "event" && routine.schedule.source === "watch"
			? { scheduleText: describeWatchCondition(routine.schedule.condition) }
			: {}),
		...(nextRunAt === undefined ? {} : { nextRunAt }),
		...(opensAt === undefined || nextRunAt === undefined || opensAt >= nextRunAt ? {} : { startsFrom: opensAt }),
		...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
		...(routine.lastStatus === undefined ? {} : { lastStatus: routine.lastStatus }),
		...(unschedulable === undefined ? {} : { unschedulable }),
		...(routine.failurePause === undefined ? {} : { pausedAfterFailures: routine.failurePause.after }),
		...(routine.conditionMet ? { endReportedMet: true as const } : {}),
	};
}

function view(routine: RoutineDefinitionView, store: RoutineStorePort, nowMs: number): RoutineToolView {
	const progress = describeRoutineProgress(routine.progress);
	return {
		...summary(routine, store, nowMs),
		prompt: routine.prompt,
		...(routine.lastSummary === undefined
			? {}
			: { lastSummary: wrapUntrustedText(routine.lastSummary, `routine-last-summary:${routine.routineId}`) }),
		...(progress === undefined
			? {}
			: { progress: wrapUntrustedText(progress, `routine-progress:${routine.routineId}`) }),
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
		return {
			routines: page.map((routine) => summary(routine, this.deps.store, this.deps.now())),
			...(entries.length > page.length ? { next: page.at(-1)!.routineId } : {}),
		};
	}

	async get(routineId: string, signal?: AbortSignal): Promise<RoutineToolView | undefined> {
		this.check(signal);
		const routine = this.deps.store.getRoutine(routineId);
		return routine && this.owns(routine) ? view(routine, this.deps.store, this.deps.now()) : undefined;
	}

	create(input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView> {
		return this.save(input, undefined, "tool", signal);
	}
	update(input: RoutineToolInput, expectedRevision: number, signal?: AbortSignal): Promise<RoutineToolView> {
		return this.save(input, expectedRevision, "tool", signal);
	}
	/** The embedding host's own creation: no model turn answers it, so no owner turn is required or stamped. */
	createForHost(input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView> {
		return this.save(input, undefined, "host", signal);
	}

	async setEnabled(
		routineId: string,
		expectedRevision: number,
		enabled: boolean,
		signal?: AbortSignal,
	): Promise<RoutineToolView> {
		this.check(signal);
		// Pausing only narrows standing work, so any turn may do it; resuming restarts it and needs the owner's request.
		if (enabled) this.requireOwnerTurn();
		const routine = this.require(routineId, expectedRevision);
		const saved = this.deps.store.upsertRoutine({
			routineId,
			expectedRevision,
			target: routine.target,
			prompt: routine.prompt,
			schedule: routineScheduleInputOf(routine.schedule),
			enabled,
			executionSnapshot: routine.executionSnapshot,
			nowMs: this.deps.now(),
		});
		harnessLog.info("routines", enabled ? "a routine was resumed" : "a routine was paused", () => ({
			routineId,
			revision: saved.revision,
		}));
		return view(saved, this.deps.store, this.deps.now());
	}

	async delete(routineId: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
		this.check(signal);
		this.require(routineId, expectedRevision);
		if (!this.deps.store.deleteRoutine(routineId, expectedRevision, this.deps.now()))
			throw new Error("Routine changed before deletion.");
		harnessLog.info("routines", "a routine was deleted", { routineId });
	}

	async run(routineId: string, expectedRevision: number, invocationId: string, signal?: AbortSignal) {
		this.check(signal);
		// A manual occurrence spends a worker run and its result can open another parent turn: only the owner's words start one.
		this.requireOwnerTurn();
		this.require(routineId, expectedRevision);
		const commandId = strictCanonicalDigest({
			parentSessionId: this.deps.parentSessionId,
			invocation: this.deps.invocationKey(invocationId),
		});
		return { occurrenceId: this.deps.scheduler.run(routineId, expectedRevision, commandId) };
	}

	async note(routineId: string, text: string, signal?: AbortSignal): Promise<RoutineToolView> {
		this.check(signal);
		// Every later run reads the note: only the owner's words write it, never a turn a run's own result opened.
		this.requireOwnerTurn();
		this.requireOwned(routineId);
		const saved = this.deps.store.noteRoutineProgress({ routineId, text, nowMs: this.deps.now() });
		harnessLog.info("routines", "the owner noted where a routine's task stands", { routineId });
		return view(saved, this.deps.store, this.deps.now());
	}

	async resetProgress(routineId: string, signal?: AbortSignal): Promise<RoutineToolView> {
		this.check(signal);
		this.requireOwnerTurn();
		this.requireOwned(routineId);
		const saved = this.deps.store.resetRoutineProgress({ routineId });
		harnessLog.info("routines", "a routine's progress was reset", { routineId });
		return view(saved, this.deps.store, this.deps.now());
	}

	/**
	 * Creates a routine the host derived from the owner's own words: the same parent check, zone default, event
	 * anchor and store write as a tool save, with read-only worker authority and the origin consumed in that write.
	 * `guard` throws {@link RoutineIntakeBranchChanged} once the owner's branch changed since the request was judged;
	 * it is checked after admission and again under the store lock, so a request navigated away from creates nothing.
	 * Widening its authority is a later routine tool update, never intake.
	 */
	async createFromIntake(
		spec: { readonly prompt: string; readonly schedule: RoutineScheduleInput },
		origin: RoutineIntakeOrigin,
		guard: () => void,
		signal?: AbortSignal,
	): Promise<RoutineIntakeCreation> {
		this.check(signal);
		let savedIntent: WorkerSavedIntent;
		try {
			savedIntent = await this.deps.capture(
				{
					instructions: spec.prompt,
					knowledge: [],
					objectiveId: null,
					authority: { readOnly: true },
					reportsProgress: true,
				},
				signal,
			);
		} catch (error) {
			// An abort, a disposed session or a branch change is not the admission's answer; the caller retries or stops.
			this.check(signal);
			guard();
			return { refused: "admission", reason: error instanceof Error ? error.message : String(error) };
		}
		this.check(signal);
		guard();
		try {
			const created = this.persist(
				{ routineId: routineIntakeRoutineId(origin), prompt: spec.prompt, schedule: spec.schedule, knowledge: [] },
				savedIntent,
				{ enabled: true, intakeOrigin: origin, intakeGuard: guard },
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
		author: "tool" | "host",
		signal?: AbortSignal,
	): Promise<RoutineToolView> {
		this.check(signal);
		// Read before admission waits: the sources in this call's context, never words the owner sends meanwhile.
		const toolAnsweredSources = author === "tool" ? this.requireOwnerTurn() : undefined;
		const prior = expectedRevision === undefined ? undefined : this.require(input.routineId, expectedRevision);
		const sameIntent =
			prior?.executionSnapshot &&
			prior.prompt === input.prompt &&
			prior.executionSnapshot.profileId === input.profileId &&
			isDeepStrictEqual(prior.executionSnapshot.savedIntent.knowledgeReferences, input.knowledge ?? []) &&
			// An intent captured before routine runs reported progress is captured again, so its runs keep the section.
			prior.executionSnapshot.savedIntent.executionContract.worker.profile.reportsProgress === true;
		const savedIntent = sameIntent
			? prior.executionSnapshot!.savedIntent
			: await this.deps.capture(
					{
						instructions: input.prompt,
						profileId: input.profileId,
						knowledge: input.knowledge ?? [],
						objectiveId: null,
						reportsProgress: true,
					},
					signal,
				);
		this.check(signal);
		return this.persist(input, savedIntent, {
			enabled: prior?.enabled ?? true,
			...(expectedRevision === undefined ? {} : { expectedRevision }),
			...(prior?.schedule.kind === "calendar" ? { timeZone: prior.schedule.timeZone } : {}),
			...(toolAnsweredSources === undefined ? {} : { toolAnsweredSources }),
		});
	}

	/**
	 * The one write of a saved routine for every creation path: the parent check, the calendar zone default, the
	 * event anchor and the store upsert. A create is `createOnly`; an update names the revision it replaces. A calendar
	 * rule without a zone takes `extras.timeZone` (an update's saved zone), else this host's. A tool save records the
	 * owner sources its model's context held; an intake creation carries the origin it consumes and its branch guard.
	 */
	private persist(
		input: RoutineToolInput,
		savedIntent: WorkerSavedIntent,
		extras: {
			readonly enabled: boolean;
			readonly expectedRevision?: number;
			readonly timeZone?: string;
			readonly toolAnsweredSources?: readonly string[];
			readonly intakeOrigin?: RoutineIntakeOrigin;
			readonly intakeGuard?: () => void;
		},
	): RoutineToolView {
		if (savedIntent.receiptOrigin.sessionId !== this.deps.parentSessionId)
			throw new Error("Routine parent changed during admission.");
		const authored = input.schedule;
		const watching = authored.kind === "event" && authored.source === "watch";
		const saved = this.deps.store.upsertRoutine({
			routineId: input.routineId,
			prompt: input.prompt,
			target: { kind: "session", parentSessionId: this.deps.parentSessionId },
			// A calendar rule without a zone keeps the routine's saved zone, or follows the authoring session's wall clock.
			// A watch condition is admitted by the session before it is saved, so only what it may watch is stored.
			schedule:
				authored.kind === "calendar" && authored.timeZone === undefined
					? { ...authored, timeZone: extras.timeZone ?? hostTimeZone() }
					: authored.kind === "event" && authored.source === "watch"
						? { ...authored, condition: this.deps.admitWatch(parseWatchCondition(authored.condition)) }
						: authored,
			enabled: extras.enabled,
			nowMs: this.deps.now(),
			// A watch is decided by its monitor and the store, not by the session's host-event ledger: no anchor, no ledger.
			...(authored.kind === "event" && !watching ? { eventAnchor: this.deps.eventAnchor() } : {}),
			executionSnapshot: {
				parentSessionId: this.deps.parentSessionId,
				parentBranchAnchor: savedIntent.receiptOrigin.leafId,
				savedIntent,
				...(input.profileId === undefined ? {} : { profileId: input.profileId }),
			},
			...(extras.expectedRevision === undefined
				? { createOnly: true }
				: { expectedRevision: extras.expectedRevision }),
			...(extras.toolAnsweredSources === undefined ? {} : { toolAnsweredSources: extras.toolAnsweredSources }),
			...(extras.intakeOrigin === undefined ? {} : { intakeOrigin: extras.intakeOrigin }),
			...(extras.intakeGuard === undefined ? {} : { intakeGuard: extras.intakeGuard }),
		});
		const origin =
			extras.intakeOrigin !== undefined ? "intake" : extras.expectedRevision === undefined ? "create" : "update";
		harnessLog.info("routines", "a routine was saved", () => ({
			routineId: input.routineId,
			origin,
			schedule: input.schedule.kind,
			revision: saved.revision,
		}));
		return view(saved, this.deps.store, this.deps.now());
	}

	/**
	 * The owner sources the current run answers. Standing work is created, changed, restarted or run only on the owner's
	 * own words: a run a routine result, CI event or other host input opened cannot extend or re-trigger the automation
	 * that woke it.
	 */
	private requireOwnerTurn(): readonly string[] {
		const sources = this.deps.ownerTurnSources();
		if (sources.length === 0) {
			harnessLog.warn("routines", "a routine change was refused: the owner has not spoken in this turn");
			throw new Error(
				"The owner has not spoken in this turn (a routine result, CI event or host input started it): create, update, resume, run, note and reset_progress wait for the owner's request; pause and delete still work. Tell the owner what to change.",
			);
		}
		return sources;
	}

	private owns(routine: RoutineDefinitionView): boolean {
		return routine.target.kind === "session" && routine.target.parentSessionId === this.deps.parentSessionId;
	}

	private require(routineId: string, revision: number): RoutineDefinitionView {
		const routine = this.requireOwned(routineId);
		if (routine.revision !== revision) throw new Error("Routine revision changed; read it before editing.");
		return routine;
	}

	private requireOwned(routineId: string): RoutineDefinitionView {
		const routine = this.deps.store.getRoutine(routineId);
		if (!routine || !this.owns(routine)) throw new Error("Routine is absent from this session.");
		return routine;
	}

	private check(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.deps.isDisposed()) throw new Error("Routine session is disposed.");
		this.deps.store.reload();
	}
}
