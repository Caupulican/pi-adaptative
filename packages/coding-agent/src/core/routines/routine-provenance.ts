/**
 * What a saved routine records about how it came to exist, fixed at creation: the owner-intake origin the host created
 * it from, the authority a model's own `routine` tool call armed it under, whom a watch wakes and the scope a worker's watch
 * is observed under (`worker-watch-scope.ts`). This module owns the stored shape of the arming authority, its parse, the one
 * place the store stamps all four onto a new routine, and the check that the wake address and scope fit the routine.
 */
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { PersistentRoutineDefinition, RoutineIntakeOrigin, RoutineOrigin } from "./routine-contract.ts";
import { boundedRoutineText } from "./routine-field-guards.ts";
import { type RoutineWakeAddress, wakeAddressSession } from "./routine-wake-address.ts";
import type { WorkerWatchScope } from "./worker-watch-scope.ts";

/** Owner sources an arming stamp keeps; the newest stay, so the stamp never names more than the run's context held. */
export const MAX_ARM_OWNER_SOURCES = 16;
const MAX_ARM_TEXT_CHARS = 512;

/**
 * The authority a routine was armed under, never more than the run that armed it held:
 * - `owner`: the owner spoke in the run; these are the owner sources its context held.
 * - `goal`: a goal continuation opened the run and this goal was active; `ownerSourceId` is the owner source the goal was
 *   started from, when the goal records one (a goal the owner's own message started), and the run claims no other. The run
 *   is still unattended, so the goal's owner source names where the work came from, never words the run read.
 * - `wake`: a routine result, CI event or other host input opened the run; `ref` is that parent input's delivery id (or the
 *   wake's id when it covers several).
 * - `worker`: a worker runtime armed it for its own wait, within the bounds of the session that runs it; `runtimeId` is that
 *   runtime. It is never an owner's words and never what opened a root run.
 */
export type RoutineArmAuthority =
	| { readonly kind: "owner"; readonly sourceIds: readonly string[] }
	| { readonly kind: "goal"; readonly goalId: string; readonly ownerSourceId?: string }
	| { readonly kind: "wake"; readonly ref: string }
	| { readonly kind: "worker"; readonly runtimeId: string };

/** What opened a run the owner did not speak in: the arming authority the run can offer a routine it arms. */
export type RoutineRunOpener = Extract<RoutineArmAuthority, { readonly kind: "goal" | "wake" }>;

/** The stored arming authority; a malformed one makes the whole routine unreadable. */
export function parseRoutineArmAuthority(value: unknown): RoutineArmAuthority {
	if (!isPlainRecord(value)) throw new TypeError("Routine arming authority is invalid.");
	if (value.kind === "goal" && hasOnlyKeys(value, ["kind", "goalId", "ownerSourceId"]))
		return {
			kind: "goal",
			goalId: boundedRoutineText(value.goalId, MAX_ARM_TEXT_CHARS, "arming goal id"),
			...(value.ownerSourceId === undefined
				? {}
				: { ownerSourceId: boundedRoutineText(value.ownerSourceId, MAX_ARM_TEXT_CHARS, "arming goal source id") }),
		};
	if (value.kind === "wake" && hasOnlyKeys(value, ["kind", "ref"]))
		return { kind: "wake", ref: boundedRoutineText(value.ref, MAX_ARM_TEXT_CHARS, "arming delivery id") };
	if (value.kind === "worker" && hasOnlyKeys(value, ["kind", "runtimeId"]))
		return {
			kind: "worker",
			runtimeId: boundedRoutineText(value.runtimeId, MAX_ARM_TEXT_CHARS, "arming runtime id"),
		};
	if (
		value.kind === "owner" &&
		hasOnlyKeys(value, ["kind", "sourceIds"]) &&
		Array.isArray(value.sourceIds) &&
		value.sourceIds.length > 0 &&
		value.sourceIds.length <= MAX_ARM_OWNER_SOURCES
	)
		return {
			kind: "owner",
			sourceIds: value.sourceIds.map((id: unknown) =>
				boundedRoutineText(id, MAX_ARM_TEXT_CHARS, "arming source id"),
			),
		};
	throw new TypeError("Routine arming authority is invalid.");
}

/**
 * The stamps a routine is created with, fixed at creation: an update, enable or disable never adds, changes or drops
 * any. The intake origin is the host's own (an owner request it turned into a routine); the arming authority is the
 * model tool's; the wake address and a worker's scope are the saving caller's.
 */
export function creationProvenance(
	existing: Pick<PersistentRoutineDefinition, "origin" | "armedBy" | "wake" | "workerScope"> | undefined,
	intake: RoutineIntakeOrigin | undefined,
	armedBy: RoutineArmAuthority | undefined,
	wake: RoutineWakeAddress | undefined,
	workerScope: WorkerWatchScope | undefined,
): Pick<PersistentRoutineDefinition, "origin" | "armedBy" | "wake" | "workerScope"> {
	const created: RoutineOrigin | undefined = intake && {
		kind: "owner-intake",
		sourceId: intake.sourceId,
		...(intake.defaults === undefined ? {} : { defaults: intake.defaults }),
		...(intake.endCondition === undefined ? {} : { endCondition: intake.endCondition }),
	};
	const origin = existing?.origin ?? created;
	const stamp = existing ? existing.armedBy : armedBy;
	const address = existing ? existing.wake : wake;
	const scope = existing ? existing.workerScope : workerScope;
	return {
		...(origin ? { origin } : {}),
		...(stamp ? { armedBy: stamp } : {}),
		...(address ? { wake: address } : {}),
		...(scope ? { workerScope: scope } : {}),
	};
}

/** Whether a stored definition holds an arming stamp or a wake address, which a build that predates them cannot read. */
export function carriesRoutineArming(definition: Pick<PersistentRoutineDefinition, "armedBy" | "wake">): boolean {
	return definition.armedBy !== undefined || definition.wake !== undefined;
}

/**
 * Why a routine's wake address and worker scope do not fit it, or undefined when they do: only a watch of a session has an
 * armer to wake, and that armer belongs to the session; only a worker's watch carries a worker's scope, and a worker's
 * command or page watch must carry the one its runtime armed it under, since nothing else bounds what it runs.
 */
export function routineWakeRefusal(
	definition: Pick<PersistentRoutineDefinition, "target" | "schedule" | "wake" | "workerScope">,
): string | undefined {
	const { target, schedule, wake, workerScope } = definition;
	const watch = schedule.kind === "event" && schedule.source === "watch" ? schedule : undefined;
	if (wake && (target.kind !== "session" || !watch || wakeAddressSession(wake) !== target.parentSessionId))
		return "Only a watch of a session wakes an armer, and only one of that session.";
	if (workerScope && wake?.kind !== "worker") return "Only a worker's watch is observed under a worker's scope.";
	if (
		wake?.kind === "worker" &&
		!workerScope &&
		(watch?.condition.type === "command" || watch?.condition.type === "http")
	)
		return "A worker's command or page watch requires the scope its runtime armed it under.";
	return undefined;
}
