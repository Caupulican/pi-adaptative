/** Keeps the exact occurrences a phone command paused in the same atomic write as the schedule change. */
import {
	MAX_ROUTINE_OCCURRENCES,
	type RoutineDefinitionView,
	routineScheduleInputOf,
	type UpsertPersistentRoutineInput,
} from "../routines/routine-contract.ts";
import { isPlainRecord } from "../util/value-guards.ts";

interface Witness {
	key: string;
	expiresAt: number;
	ids: string[];
}
const MAX_PENDING_STOPS = 128;
export interface TaskStopRequest {
	key: string;
	bot: string;
	routine: string;
	incarnation: string;
	revision: number;
	now: number;
	expiresAt: number;
}
export type TaskStopDecision = { kind: "paused"; ids: readonly string[] } | { kind: "gone" | "changed" };

export function readStopWitnesses(value: unknown): Witness[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PENDING_STOPS) throw new Error("Invalid pending task stops.");
	const seen = new Set<string>();
	return value.map((row) => {
		if (
			!isPlainRecord(row) ||
			typeof row.key !== "string" ||
			!/^[a-f0-9]{64}$/.test(row.key) ||
			seen.has(row.key) ||
			typeof row.expiresAt !== "number" ||
			!Number.isSafeInteger(row.expiresAt) ||
			!Array.isArray(row.ids) ||
			row.ids.length > MAX_ROUTINE_OCCURRENCES ||
			!row.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 1024)
		)
			throw new Error("Invalid pending task stop.");
		seen.add(row.key);
		return { key: row.key, expiresAt: row.expiresAt, ids: row.ids };
	});
}

/** Called under the routine store lock. The receipt outlives edits and deletion of its original incarnation. */
export function commitTaskStop(
	rows: Witness[],
	request: TaskStopRequest,
	current: RoutineDefinitionView | undefined,
	bot: { retired?: boolean; remote?: boolean } | undefined,
	ids: () => string[],
	write: (pause?: UpsertPersistentRoutineInput) => void,
): TaskStopDecision {
	const existing = rows.find((r) => r.key === request.key);
	if (existing) return { kind: "paused", ids: existing.ids };
	if (
		!bot ||
		bot.retired ||
		bot.remote ||
		current?.target.kind !== "bot" ||
		current.target.agentId !== request.bot ||
		current.incarnationId !== request.incarnation
	)
		return { kind: "gone" };
	if (current.enabled && current.revision !== request.revision) return { kind: "changed" };
	for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.expiresAt <= request.now) rows.splice(i, 1);
	if (rows.length >= MAX_PENDING_STOPS) throw new Error("Pending task stops are full; retry the command.");
	const captured = ids();
	rows.push({ key: request.key, expiresAt: request.expiresAt, ids: captured });
	write(
		current.enabled
			? {
					routineId: current.routineId,
					target: current.target,
					expectedRevision: request.revision,
					prompt: current.prompt,
					schedule: routineScheduleInputOf(current.schedule),
					enabled: false,
				}
			: undefined,
	);
	return { kind: "paused", ids: captured };
}
