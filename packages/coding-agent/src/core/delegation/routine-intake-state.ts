/**
 * Owner-intake state of routines: the admission of one intake creation (its origin consumed, its per-session window and its live
 * caps), the per-session intake progress a write records, and the answers a routine tool save marks. The functions change the
 * routine state they are given; `persist` is the store's save.
 */
import {
	MAX_ROUTINE_INTAKE_ANSWERED,
	MAX_ROUTINE_INTAKE_ORIGINS,
	MAX_ROUTINE_INTAKE_SESSIONS,
	MAX_ROUTINE_INTAKE_UNANNOUNCED,
	type PersistentRoutineTarget,
	parseRoutineIntakeOrigin,
	parseRoutineIntakeSessions,
	ROUTINE_INTAKE_CAP_WINDOW_MS,
	ROUTINE_INTAKE_LIVE_CAP,
	ROUTINE_INTAKE_WINDOW_CAP,
	type RoutineIntakeChange,
	type RoutineIntakeOrigin,
	RoutineIntakeRefusal,
	type RoutineIntakeSession,
	type UpsertPersistentRoutineInput,
} from "../routines/routine-contract.ts";
import type { RoutineStoreState } from "./routine-occurrence-journal.ts";

/**
 * Admits one host intake creation under the store lock: create-only and session-targeted, refused when its
 * origin is consumed, when the session created {@link ROUTINE_INTAKE_WINDOW_CAP} routines within the cap
 * window, or when it holds {@link ROUTINE_INTAKE_LIVE_CAP} live intake routines.
 */
export function admitRoutineIntake(
	state: RoutineStoreState,
	input: UpsertPersistentRoutineInput,
): RoutineIntakeOrigin & { parentSessionId: string } {
	// The owner's branch is checked first, under the lock: a request navigated away from writes nothing.
	input.intakeGuard?.();
	const origin = parseRoutineIntakeOrigin(input.intakeOrigin);
	if (input.target.kind !== "session" || !input.createOnly || input.expectedRevision !== undefined)
		throw new Error("A routine intake creation is a create-only session routine.");
	const parentSessionId = input.target.parentSessionId;
	if (state.intakeOrigins.has(origin.key))
		throw new RoutineIntakeRefusal("consumed", "This owner request was already turned into a routine.");
	const nowMs = input.nowMs ?? Date.now();
	let recent = 0;
	for (const consumption of state.intakeOrigins.values())
		if (consumption.parentSessionId === parentSessionId && consumption.at > nowMs - ROUTINE_INTAKE_CAP_WINDOW_MS)
			recent++;
	if (recent >= ROUTINE_INTAKE_WINDOW_CAP)
		throw new RoutineIntakeRefusal(
			"window_cap",
			"The daily limit of automatic routines for this session is reached.",
		);
	let live = 0;
	for (const routine of state.routines.values())
		if (routine.origin && routine.target.kind === "session" && routine.target.parentSessionId === parentSessionId)
			live++;
	if (live >= ROUTINE_INTAKE_LIVE_CAP)
		throw new RoutineIntakeRefusal("live_cap", "This session already holds its limit of automatic routines.");
	return { ...origin, parentSessionId };
}

/**
 * Applies one change to a session's intake state inside the caller's mutation and moves it to the newest
 * position. Once the bound is reached the least recently written session with no pass in flight and no notice
 * owed leaves first, so another session's progress never displaces work this one still owes its owner.
 */
export function writeRoutineIntakeSession(
	state: RoutineStoreState,
	parentSessionId: string,
	nowMs: number,
	change: (current: RoutineIntakeSession | undefined) => Partial<Omit<RoutineIntakeSession, "parentSessionId">>,
): void {
	const current = state.intakeSessions.get(parentSessionId);
	// Parsed as the next load reads it: a write never persists state that load would refuse.
	const [next] = parseRoutineIntakeSessions([
		JSON.parse(JSON.stringify({ ...current, ...change(current), parentSessionId, updatedAt: nowMs })),
	]);
	state.intakeSessions.delete(parentSessionId);
	state.intakeSessions.set(parentSessionId, next!);
	while (state.intakeSessions.size > MAX_ROUTINE_INTAKE_SESSIONS) {
		let evicted: string | undefined;
		for (const [id, session] of state.intakeSessions)
			if (id !== parentSessionId && !session.batch && !session.unannounced) {
				evicted = id;
				break;
			}
		state.intakeSessions.delete(evicted ?? state.intakeSessions.keys().next().value!);
	}
}

/**
 * Records a consumed origin and its request's decision in the creating write, so the creation and its outcome are
 * one durable fact; the oldest origin leaves first once the journal is full.
 */
export function consumeRoutineIntake(
	state: RoutineStoreState,
	intake: RoutineIntakeOrigin & { parentSessionId: string },
	routineId: string,
	at: number,
): void {
	state.intakeOrigins.set(intake.key, { key: intake.key, parentSessionId: intake.parentSessionId, at });
	for (const oldest of state.intakeOrigins.keys()) {
		if (state.intakeOrigins.size <= MAX_ROUTINE_INTAKE_ORIGINS) break;
		state.intakeOrigins.delete(oldest);
	}
	const batch = state.intakeSessions.get(intake.parentSessionId)?.batch;
	if (!batch?.requests?.some((request) => request.key === intake.key)) return;
	const requests = batch.requests.map((request) =>
		request.key === intake.key ? { ...request, outcome: { kind: "created" as const, routineId } } : request,
	);
	writeRoutineIntakeSession(state, intake.parentSessionId, at, () => ({ batch: { ...batch, requests } }));
}

/** A routine tool save of a session marks the owner sources in its model's context as answered, in the same write. */
export function recordRoutineToolAnswers(
	state: RoutineStoreState,
	target: PersistentRoutineTarget,
	sourceIds: readonly string[],
	at: number,
): void {
	if (target.kind !== "session") throw new Error("Only a session routine records the owner sources it answered.");
	writeRoutineIntakeSession(state, target.parentSessionId, at, (current) => {
		const fresh = new Set(sourceIds);
		const answered = [...(current?.answered ?? []).filter((sourceId) => !fresh.has(sourceId)), ...fresh].slice(
			-MAX_ROUTINE_INTAKE_ANSWERED,
		);
		return answered.length > 0 ? { answered } : {};
	});
}

export function recordRoutineIntake(
	state: RoutineStoreState,
	parentSessionId: string,
	nowMs: number,
	change: RoutineIntakeChange,
	persist: () => void,
): void {
	const { batch, through } = change;
	const announced = new Set(change.announced ?? []);
	writeRoutineIntakeSession(state, parentSessionId, nowMs, (current) => {
		const records = [...(current?.unannounced ?? [])];
		const kept = new Set(records.map((record) => record.key));
		for (const record of change.announce ?? []) {
			if (kept.has(record.key)) continue;
			kept.add(record.key);
			records.push(record);
		}
		const unannounced = records.filter((record) => !announced.has(record.key)).slice(-MAX_ROUTINE_INTAKE_UNANNOUNCED);
		return {
			...(through !== undefined && (current?.through === undefined || through > current.through) ? { through } : {}),
			...(batch === undefined ? {} : { batch: batch ?? undefined }),
			unannounced: unannounced.length > 0 ? unannounced : undefined,
		};
	});
	persist();
}
