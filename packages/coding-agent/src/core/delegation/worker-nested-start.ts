/**
 * The typed nested-start port a delegation runtime (a leader) uses to start its own children, and the pure rules it rests
 * on. A worker is a leaf unless its compiled contract grants children (`profile.delegationLimits`); a leaf's start
 * never names a parent. A granted runtime admits a child only through `WorkerDelegationController.admitNested`, which
 * narrows the child to the parent's contract: depth, child count and nested-session bounds are intersected with the
 * parent's, and every write path the child names must lie inside the parent's write roots (its envelope grant).
 */

import { isAbsolute, relative } from "node:path";

import { isDeepStrictEqual } from "node:util";
import type {
	OrchestrationDelegationLimits,
	ResourcePointer,
	WorkerExecutionContract,
} from "../orchestration/contracts.ts";
import type { WorkerDelegationAuthorityRequest } from "./worker-delegation-request.ts";
import { intersectWorkerDelegationLimits, resolveWorkerFleetLimits } from "./worker-fleet-limits.ts";
import type { ResolvedWorkerProfile } from "./worker-profile-resolver.ts";

/**
 * What a leader asks the controller to start as its child. Host-owned: no field here reaches the model-facing schemas.
 * `delegationObjectiveId` is the delegation the child's task belongs to, so its outcome routes back to that delegation.
 */
export interface NestedWorkerStart {
	/** The leader's logical agent id: the parent every child is narrowed against. */
	readonly parentAgentId: string;
	/** The leader's delegation objective the child's task belongs to (never the foreground goal). */
	readonly delegationObjectiveId: string;
	readonly instructions: string;
	/** Write roots the child may add beside the leader's own; each must lie inside the leader's write roots. */
	readonly writePaths?: readonly string[];
	/** Caller-chosen replay key: a repeated call with the same key starts nothing new. */
	readonly messageReplayKey?: string;
	/**
	 * A bot's own start: its persisted soul, model authority, write permission, thinking and profile, forwarded to `start()`
	 * exactly as a top-level bot start forwards them. Admission still narrows the child to the leader's contract.
	 */
	readonly bot?: NestedBotStart;
}

/** The bot-owned fields of a nested start (host-owned, never model-settable). */
export interface NestedBotStart {
	readonly botSoul?: string;
	readonly profileId?: string;
	readonly preferredAgentId?: string;
	readonly forkTurns?: string;
	/** Model, thinking, read-only and write-path authority the bot runs under; a bot that cannot write is `readOnly`. */
	readonly authority?: WorkerDelegationAuthorityRequest;
	/** The bot is a leader: its runtime's model follows `modelPins.leader`. */
	readonly leaderRuntime?: boolean;
	/** The explicit `authority.model` is the bot record's own; the default pin steps aside for it. */
	readonly modelFromBotRecord?: boolean;
}

/** The controller's answer for one nested start: started (queued or running) with its lane, or refused with a reason. */
export type NestedWorkerStartOutcome =
	| { readonly started: true; readonly laneId: string; readonly queued: boolean }
	| { readonly started: false; readonly skipReason: string };

/**
 * The delegation limits a compiled runtime carries: the host ceilings applied to the requested limits. Without a request
 * the runtime is a leaf (all zero).
 */
export function workerDelegationLimitsOf(
	requested: Readonly<OrchestrationDelegationLimits> | undefined,
): OrchestrationDelegationLimits {
	const limits = resolveWorkerFleetLimits(requested);
	return {
		maxDepth: limits.maxDepth,
		maxChildrenPerAgent: limits.maxChildrenPerAgent,
		maxNestedAgentsPerSession: limits.maxNestedAgentsPerSession,
	};
}

/** Whether a set of delegation limits grants children at all: at least one child and one level below the runtime. */
export function delegationLimitsGrantChildren(limits: Readonly<OrchestrationDelegationLimits> | undefined): boolean {
	const resolved = resolveWorkerFleetLimits(limits);
	return resolved.maxChildrenPerAgent > 0 && resolved.maxDepth > 0;
}

/** Whether a parent's compiled contract grants it children (the one rule every leaf-or-runtime decision reads). */
export function contractGrantsChildren(contract: WorkerExecutionContract | undefined): boolean {
	return delegationLimitsGrantChildren(contract?.worker.profile.delegationLimits);
}

/**
 * The write roots a parent's contract grants its children: its cwd and the write paths it was given. A child's write
 * paths must each lie inside one of these; an empty list leaves the child no write root beyond the parent's cwd.
 */
export function childWriteRoots(contract: WorkerExecutionContract["worker"]): readonly string[] {
	const roots = [...(contract.profile.writePaths ?? []), ...contract.authority.writePaths];
	if (contract.authority.cwd !== undefined) roots.push(contract.authority.cwd);
	return roots;
}

/** Whether `path` is one of `roots` or lies beneath one (both absolute; compared by path segments, so `/a/bc` is not under `/a/b`). */
export function pathWithinRoots(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const inside = relative(root, path);
		return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
	});
}

/**
 * A child cannot widen its parent's contract, whether a leader starts it now or a recovered nested dispatch
 * returns with another routing profile. Pointer ids alone are insufficient authority: retain only pointers whose
 * complete metadata matches, require the parent's exact profile soul (a bot's own soul is not inherited and is
 * not compared), keep write paths inside the parent's write roots and intersect the lineage limits.
 */
export function narrowWorkerShipmentContext(
	shipment: ResolvedWorkerProfile,
	boundary: WorkerExecutionContract["worker"],
): { ok: true; shipment: ResolvedWorkerProfile } | { ok: false; skipReason: string } {
	const boundaryPointers = new Map(boundary.resourcePointers.map((pointer) => [pointer.id, pointer]));
	const resourcePointers: ResourcePointer[] = [];
	for (const pointer of shipment.resourcePointers) {
		const inherited = boundaryPointers.get(pointer.id);
		if (!inherited || !isDeepStrictEqual(inherited, pointer)) {
			return { ok: false, skipReason: "orchestration_context_authority_exceeded" };
		}
		resourcePointers.push(structuredClone(inherited));
	}
	if (shipment.soul !== undefined && shipment.soul !== boundary.soul) {
		return { ok: false, skipReason: "orchestration_context_authority_exceeded" };
	}
	// A child may name write paths only inside the parent's write roots: the parent's envelope grant is never widened.
	const roots = childWriteRoots(boundary);
	if (shipment.profile.writePaths?.some((path) => !pathWithinRoots(path, roots)))
		return { ok: false, skipReason: "orchestration_context_authority_exceeded" };
	const delegationLimits = intersectWorkerDelegationLimits(
		shipment.profile.delegationLimits,
		boundary.profile.delegationLimits,
	);
	return {
		ok: true,
		shipment: {
			...shipment,
			profile: {
				...shipment.profile,
				...(delegationLimits ? { delegationLimits } : {}),
			},
			resourcePointers,
		},
	};
}
