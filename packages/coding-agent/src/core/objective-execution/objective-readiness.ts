/**
 * Which running attempts an objective's next route must join before it proceeds.
 *
 * An objective joins every running attempt of its own tasks (task dependencies and verifier tasks
 * always belong to the objective they serve), and every other running attempt that may change the
 * objective's repository. Another objective's work is independent only on admitted evidence, read
 * through the canonical repository-effect classes: authority proven not to change a repository, or
 * typed path writes confined to canonical scopes that do not overlap this repository. A missing
 * authority, an opaque capability or tool, an unresolvable scope, or an unknown repository can
 * mutate anywhere as far as readiness can prove, so that attempt is joined.
 */

import { isAbsolute } from "node:path";
import { pathScopesOverlap, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { HarnessCapability } from "../capability-contract.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { discoverWorkRepository } from "../system-one/work-diff.ts";
import { capabilityRepositoryEffect, strongestRepositoryEffect, toolRepositoryEffect } from "./repository-effect.ts";

/** One admitted authority an attempt runs under, from its execution contract or its compiled grant. */
interface AdmittedAuthority {
	readonly capabilities: readonly HarnessCapability[];
	readonly toolNames: readonly string[];
	readonly writePaths: readonly string[];
}

/**
 * The repository an objective's work mutates: the git top level of `workspace`, or `workspace`
 * itself when it is not inside a repository. `undefined` when neither can be established.
 */
function objectiveRepositoryScope(workspace: string | undefined): string | undefined {
	if (!workspace) return undefined;
	const discovery = discoverWorkRepository(workspace);
	if (discovery.diagnostic) return undefined;
	return canonicalScope(discovery.root ?? workspace);
}

function canonicalScope(scope: string): string | undefined {
	try {
		return safeRealpathSync(scope);
	} catch {
		return undefined;
	}
}

function admittedAuthorities(attempt: AttemptRuntimeState): AdmittedAuthority[] {
	const contract = attempt.dispatch.executionContract;
	const authorities: AdmittedAuthority[] = [];
	for (const profile of [contract?.worker, contract?.verifier]) {
		if (!profile) continue;
		const { authority } = profile;
		authorities.push({
			capabilities: authority.capabilities,
			toolNames: authority.toolNames,
			writePaths: authority.writePaths,
		});
	}
	if (attempt.grant) {
		authorities.push({
			capabilities: attempt.grant.capabilities,
			toolNames: attempt.grant.allowedTools,
			writePaths: attempt.grant.writePaths,
		});
	}
	return authorities;
}

function authorityMayMutateRepository(authority: AdmittedAuthority, repository: string | undefined): boolean {
	const effect = strongestRepositoryEffect([
		...authority.capabilities.map(capabilityRepositoryEffect),
		...authority.toolNames.map((toolName) => toolRepositoryEffect(toolName)),
	]);
	if (effect === "none") return false;
	if (effect === "opaque" || !repository) return true;
	if (authority.writePaths.length === 0) return true;
	// Contracts admit only absolute scopes; a relative one (a grant carries no base) cannot be resolved.
	return authority.writePaths.some((writePath) => {
		const scope = isAbsolute(writePath) ? canonicalScope(writePath) : undefined;
		return scope === undefined || pathScopesOverlap(scope, repository);
	});
}

function attemptMayMutateRepository(attempt: AttemptRuntimeState, repository: string | undefined): boolean {
	const authorities = admittedAuthorities(attempt);
	return (
		authorities.length === 0 || authorities.some((authority) => authorityMayMutateRepository(authority, repository))
	);
}

/**
 * The running attempts `objectiveId`'s next route joins. `workspace` is the directory the
 * objective's work runs in; without it only read-only authority is independent.
 */
export function objectiveJoinAttempts(
	runtime: TaskRuntimeProjection,
	objectiveId: string,
	workspace: string | undefined,
): AttemptRuntimeState[] {
	const running = Object.values(runtime.attempts).filter((attempt) => attempt.status === "running");
	let repository: string | undefined;
	let repositoryResolved = false;
	return running.filter((attempt) => {
		const task = runtime.tasks[attempt.taskId];
		if (!task) throw new Error(`Running attempt '${attempt.attemptId}' has no task in the runtime projection.`);
		if (task.task.objectiveId === objectiveId) return true;
		if (!repositoryResolved) {
			repository = objectiveRepositoryScope(workspace);
			repositoryResolved = true;
		}
		return attemptMayMutateRepository(attempt, repository);
	});
}
