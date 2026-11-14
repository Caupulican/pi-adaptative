/**
 * The owner notices a session's routine scheduler keeps (`harness-notice.ts`), each read at every pass from the routine
 * store's durable records: a routine paused after failed runs, a time zone this runtime cannot place, a snag its runs keep
 * meeting, and a result settled undeliverable, or a routine removed, because the point of the session it was addressed
 * to can never come back.
 * Read from durable records, a notice survives the process that wrote the state: a restart or a session reopened in the
 * background observes it again, and a notice already saved in the session is found and not repeated.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import type { HarnessNotice } from "../harness-notice.ts";
import { englishText } from "../language/interface-text.ts";
import { type RoutineDefinitionView, type RoutineOccurrence, routineZoneUnsupported } from "./routine-contract.ts";
import { latestUndeliverableResults } from "./routine-origin-reach.ts";
import { PROMOTED_SNAG_RUNS, promotedRoutineSnags } from "./routine-progress.ts";
import type { RetiredRoutineRecord } from "./routine-retired.ts";

/** The notice kinds a routine state is told under; each subject (`scope`) holds its own episodes. */
export type RoutineNoticeKind = "routine-paused" | "routine-unschedulable" | "routine-snag" | "routine-origin-lost";

/** The session's notice owner, as the scheduler reaches it; `undefined` observes that the state ended. */
export interface RoutineNoticePort {
	noticeRoutineState(kind: RoutineNoticeKind, scope: string, notice: HarnessNotice | undefined): void;
}

/** The routine store's durable records of one session a pass observes. */
export interface RoutineNoticeFacts {
	readonly routines: readonly RoutineDefinitionView[];
	/** The session's runs in the journal, settled ones included. */
	readonly occurrences: readonly RoutineOccurrence[];
	/** The session's kept records of removed routines. */
	readonly retired: readonly RetiredRoutineRecord[];
}

/**
 * Per routine, the latest loss of its saved origin the owner is told: a result settled undeliverable, or the routine's
 * removal because its own origin is lost, whichever came last (the removal on a tie: it ends the routine).
 */
function originLostNotices(facts: RoutineNoticeFacts): Map<string, HarnessNotice> {
	const notices = new Map<string, { readonly at: number; readonly notice: HarnessNotice }>();
	for (const result of latestUndeliverableResults(facts.occurrences).values())
		notices.set(result.routineId, {
			at: result.settledAt,
			notice: {
				reason: `result:${result.occurrenceId}:${result.loss}`,
				text: `A result of routine ${result.routineId} can never reach this session, so it no longer waits for delivery: ${englishText().notices.routineOriginLoss(result.loss)}.`,
			},
		});
	for (const record of facts.retired) {
		if (record.reason !== "origin-lost") continue;
		const known = notices.get(record.routineId);
		if (known && known.at > record.retiredAt) continue;
		notices.set(record.routineId, {
			at: record.retiredAt,
			notice: {
				reason: `retired:${record.incarnationId}`,
				text: `Routine ${record.routineId} was removed: the point of this session it was saved at can never be reached again (its session file is gone, or its entry is missing from the session file), so none of its runs could ever report here. Save it again to keep it running.`,
			},
		});
	}
	return new Map([...notices].map(([routineId, { notice }]) => [routineId, notice]));
}

/** Observes the routine states of one session for the owner; keeps only which episodes this runtime already logged. */
export class RoutineStateNotices {
	/** Pauses already logged by this process, keyed by routine and the occurrence whose failure paused it. */
	private readonly announcedPauses = new Set<string>();
	/** Snag scopes this runtime observed as promoted, so one that stops being promoted is observed clear. */
	private readonly noticedSnags = new Set<string>();

	/**
	 * Observes, for each routine of the session, the kept states the owner acts on: a pause after failed runs, a time zone
	 * this runtime cannot place, and each snag its progress record counts at least {@link PROMOTED_SNAG_RUNS} times while
	 * unresolved (one notice per snag episode); then, per routine, the latest loss of its saved origin.
	 */
	observe(port: RoutineNoticePort, facts: RoutineNoticeFacts): void {
		const promoted = new Set<string>();
		for (const routine of facts.routines) {
			if (routine.target.kind !== "session") continue;
			this.observePause(port, routine);
			const schedule = routine.schedule;
			port.noticeRoutineState(
				"routine-unschedulable",
				routine.routineId,
				schedule.kind === "calendar" && routineZoneUnsupported(schedule) !== undefined
					? {
							reason: `${routine.routineId}:${routine.incarnationId}:${schedule.timeZone}`,
							text: `Routine ${routine.routineId} cannot be scheduled: time zone ${JSON.stringify(schedule.timeZone)} is not supported by this runtime, so it does not run until the owner changes the zone or a runtime that supports it opens the session.`,
						}
					: undefined,
			);
			for (const scope of this.observeSnags(port, routine)) promoted.add(scope);
		}
		// A snag that resolved, was reset or left with its routine ends its notice.
		for (const scope of this.noticedSnags) {
			if (promoted.has(scope)) continue;
			this.noticedSnags.delete(scope);
			port.noticeRoutineState("routine-snag", scope, undefined);
		}
		for (const [routineId, notice] of originLostNotices(facts))
			port.noticeRoutineState("routine-origin-lost", routineId, notice);
	}

	/** A pause after failed runs, from its durable record, so a restart finds the notice already saved. */
	private observePause(port: RoutineNoticePort, routine: RoutineDefinitionView): void {
		const pause = routine.failurePause;
		if (pause) {
			const key = `${routine.routineId}:${pause.occurrenceId}`;
			if (!this.announcedPauses.has(key)) {
				this.announcedPauses.add(key);
				harnessLog.warn("routines", "a routine was paused after failed runs", {
					routineId: routine.routineId,
					after: pause.after,
				});
			}
		}
		port.noticeRoutineState(
			"routine-paused",
			routine.routineId,
			pause && {
				reason: `${routine.routineId}:${pause.occurrenceId}`,
				text: `Routine ${routine.routineId} was paused after ${pause.after} failed runs in a row and stays paused until the owner resumes it.`,
				// The failed run's own words: the model reads them fenced as data, the owner's line does not carry them.
				evidence: `The last run reported:\n${pause.lastError}`,
			},
		);
	}

	/** Each promoted snag of the routine, told once per episode; returns the scopes observed promoted. */
	private observeSnags(port: RoutineNoticePort, routine: RoutineDefinitionView): string[] {
		const scopes: string[] = [];
		for (const snag of promotedRoutineSnags(routine.progress)) {
			const scope = `${routine.routineId}:snag:${snag.signature}`;
			scopes.push(scope);
			this.noticedSnags.add(scope);
			// A paused or off routine runs nothing: the headline says so first, and its
			// reason changes with that state, so the notice is told again when the state changes.
			const held =
				routine.failurePause !== undefined
					? "paused until the owner resumes it"
					: !routine.enabled
						? "off until the owner enables it"
						: undefined;
			const stumbling = `keeps stumbling on the same thing (${snag.seenCount} runs so far).`;
			// The snag's own words, as the run wrote them: fenced for the model, never part of the owner's line.
			const evidence = [
				`Where the run stumbled: ${snag.what}`,
				...(snag.remedy ? [`The last remedy tried: ${snag.remedy}`] : []),
			].join("\n");
			port.noticeRoutineState("routine-snag", scope, {
				reason: `${routine.routineId}:${snag.signature}:${snag.firstSeenAt}:${held === undefined ? "active" : "held"}`,
				text:
					held === undefined
						? `Routine ${routine.routineId} ${stumbling} A note through the routine tool reaches its next run.`
						: `Routine ${routine.routineId} is ${held}; a note through the routine tool reaches its first run after that. It ${stumbling}`,
				evidence,
			});
		}
		return scopes;
	}
}
