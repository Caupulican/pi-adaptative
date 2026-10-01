import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type {
	RepositoryWorkEvidenceJournal,
	RepositoryWorkEvidenceScope,
} from "../objective-execution/repository-mutation-observer.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	captureWorkBaseline,
	discoverWorkRepository,
	readWorkDiff,
	retainWorkBaseline,
	WORK_DIFF_PATCH_LIMIT,
	WORK_DIFF_UNTRACKED_LIMIT,
	type WorkBaseline,
	type WorkDiff,
} from "./work-diff.ts";

export const WORK_EVIDENCE_CUSTOM_TYPE = "pi_repository_work_evidence";

interface WorkEvidenceRecord {
	readonly version: 1;
	readonly objectiveId: string;
	readonly scopes: readonly RepositoryWorkEvidenceScope[];
}

function canRecoverSnapshotDiagnostic(diagnostic: string | undefined): boolean {
	return (
		diagnostic === undefined ||
		diagnostic === "repository_fingerprint_unavailable" ||
		diagnostic === "repository_fingerprint_unstable"
	);
}

function validBaseline(value: unknown, root: string): value is WorkBaseline {
	return (
		isPlainRecord(value) &&
		value.root === root &&
		typeof value.revision === "string" &&
		(value.revision === "unborn" || /^[0-9a-f]{40,64}$/.test(value.revision)) &&
		typeof value.tree === "string" &&
		/^[0-9a-f]{40,64}$/.test(value.tree)
	);
}

function validRecord(value: unknown): value is WorkEvidenceRecord {
	return (
		isPlainRecord(value) &&
		value.version === 1 &&
		typeof value.objectiveId === "string" &&
		Array.isArray(value.scopes) &&
		value.scopes.every(
			(scope: unknown) =>
				isPlainRecord(scope) &&
				typeof scope.repositoryRoot === "string" &&
				Array.isArray(scope.changedPaths) &&
				scope.changedPaths.every((path: unknown) => typeof path === "string") &&
				(scope.baseline === undefined || validBaseline(scope.baseline, scope.repositoryRoot)) &&
				(scope.pathScope === undefined || scope.pathScope === "repository") &&
				(scope.pendingObservationIds === undefined ||
					(Array.isArray(scope.pendingObservationIds) &&
						scope.pendingObservationIds.every((id: unknown) => typeof id === "string" && id.length > 0))) &&
				(scope.observedMutation === undefined || scope.observedMutation === true) &&
				(scope.diagnostic === undefined || typeof scope.diagnostic === "string"),
		)
	);
}

/** Branch journal adapter; the mutation observer is the sole producer of scope and change evidence. */
export function createSessionWorkEvidenceJournal(getManager: () => SessionManager): RepositoryWorkEvidenceJournal {
	const anchor = (): string =>
		JSON.stringify({ sessionId: getManager().getSessionId(), leafId: getManager().getLeafId() });
	const isCurrentBranchAnchor = (branchAnchor: string | undefined): boolean => {
		if (branchAnchor === undefined) return false;
		try {
			const value: unknown = JSON.parse(branchAnchor);
			return (
				isPlainRecord(value) &&
				typeof value.sessionId === "string" &&
				(value.leafId === null || typeof value.leafId === "string") &&
				isSessionAppendAnchorCurrent(getManager(), { sessionId: value.sessionId, leafId: value.leafId })
			);
		} catch {
			return false;
		}
	};
	const assertCurrent = (branchAnchor: string | undefined): void => {
		if (branchAnchor === undefined) throw new Error("Repository outcome evidence has no owning branch anchor");
		if (!isCurrentBranchAnchor(branchAnchor))
			throw new Error("Repository outcome evidence belongs to a stale session branch");
	};
	const read = (objectiveId: string): readonly RepositoryWorkEvidenceScope[] => {
		let fromId: string | undefined;
		for (;;) {
			const entry = getManager().getLatestCustomEntryOnBranch(WORK_EVIDENCE_CUSTOM_TYPE, fromId);
			if (!entry) return [];
			if (!validRecord(entry.data))
				return [
					{
						repositoryRoot: "unknown",
						changedPaths: [],
						observedMutation: true,
						diagnostic: "repository_work_journal_invalid",
					},
				];
			if (entry.data.objectiveId === objectiveId) return structuredClone(entry.data.scopes);
			if (entry.parentId === null) return [];
			fromId = entry.parentId;
		}
	};
	const save = (objectiveId: string, scope: RepositoryWorkEvidenceScope) => {
		const scopes = read(objectiveId).filter((item) => item.repositoryRoot !== scope.repositoryRoot);
		scopes.push(scope);
		getManager().appendCustomEntry(WORK_EVIDENCE_CUSTOM_TYPE, {
			version: 1,
			objectiveId,
			scopes,
		} satisfies WorkEvidenceRecord);
	};
	return {
		isCurrentBranchAnchor,
		async ensureBaseline(objectiveId, cwd) {
			const repository = discoverWorkRepository(cwd);
			if (repository.diagnostic)
				throw new Error("Repository outcome repository discovery is unavailable; retry after Git recovers");
			const repositoryRoot = repository.root;
			if (!repositoryRoot)
				return { repositoryRoot: cwd, created: false, baselineStatus: "unversioned", branchAnchor: anchor() };
			const existing = read(objectiveId).find((scope) => scope.repositoryRoot === repositoryRoot);
			if (existing?.baseline && !existing.diagnostic)
				return { repositoryRoot, created: false, baselineStatus: "captured", branchAnchor: anchor() };
			if (existing?.baseline && existing.observedMutation && canRecoverSnapshotDiagnostic(existing.diagnostic)) {
				const recovered = readWorkDiff(repositoryRoot, existing.baseline);
				if (!recovered.diagnostic) {
					// The failed observation did not establish a complete path set. Recover the whole
					// outcome against the original baseline; delivery ownership remains a separate gate.
					const { diagnostic: _diagnostic, ...scope } = existing;
					save(objectiveId, { ...scope, changedPaths: [], pathScope: "repository" });
					return { repositoryRoot, created: false, baselineStatus: "captured", branchAnchor: anchor() };
				}
			}
			if (existing?.observedMutation)
				throw new Error("Recover the original repository baseline before further mutation");
			const baseline = captureWorkBaseline(repositoryRoot);
			if (baseline) {
				try {
					retainWorkBaseline(baseline, `${getManager().getSessionId()}\0${objectiveId}\0${repositoryRoot}`);
					save(objectiveId, { repositoryRoot, baseline, changedPaths: [] });
					return { repositoryRoot, created: true, baselineStatus: "captured", branchAnchor: anchor() };
				} catch {
					// Failure to retain a baseline is missing infrastructure evidence, never an empty patch.
				}
			}
			save(objectiveId, { repositoryRoot, changedPaths: [], diagnostic: "repository_work_baseline_unavailable" });
			throw new Error("Repository baseline capture is unavailable; retry after the host recovers");
		},
		async recordBaselineDiagnostic(objectiveId, repositoryRoot, diagnostic, branchAnchor) {
			assertCurrent(branchAnchor);
			const scope = read(objectiveId).find((item) => item.repositoryRoot === repositoryRoot);
			if (!scope) return;
			save(objectiveId, { ...scope, diagnostic });
		},
		async openObservation(objectiveId, repositoryRoot, observationId, input) {
			assertCurrent(input.branchAnchor);
			const scope = read(objectiveId).find((item) => item.repositoryRoot === repositoryRoot);
			if (!scope?.baseline) throw new Error("Repository observation has no retained baseline in its owning branch");
			save(objectiveId, {
				...scope,
				pendingObservationIds: [...new Set([...(scope.pendingObservationIds ?? []), observationId])],
			});
		},
		async closeObservation(objectiveId, repositoryRoot, observationId, branchAnchor) {
			assertCurrent(branchAnchor);
			const scope = read(objectiveId).find((item) => item.repositoryRoot === repositoryRoot);
			if (!scope?.baseline) throw new Error("Repository observation has no retained baseline in its owning branch");
			if (!scope.pendingObservationIds?.includes(observationId)) return;
			save(objectiveId, {
				...scope,
				pendingObservationIds: scope.pendingObservationIds.filter((id) => id !== observationId),
			});
		},
		async recordObservedChange(objectiveId, repositoryRoot, changedPaths, input) {
			assertCurrent(input.branchAnchor);
			const scope = read(objectiveId).find((item) => item.repositoryRoot === repositoryRoot);
			if (!scope?.baseline)
				throw new Error("Repository mutation evidence has no retained baseline in its owning branch");
			save(objectiveId, {
				...scope,
				changedPaths: [...new Set([...scope.changedPaths, ...changedPaths])],
				observedMutation: true,
				...(input.observationId
					? {
							pendingObservationIds: (scope.pendingObservationIds ?? []).filter(
								(id) => id !== input.observationId,
							),
						}
					: {}),
				...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
			});
		},
		async recoverObservations(objectiveId, activeObservationIds) {
			const branchAnchor = anchor();
			const active = new Set(activeObservationIds);
			for (const scope of read(objectiveId)) {
				const interrupted = scope.pendingObservationIds?.filter((id) => !active.has(id));
				if (!interrupted?.length || !scope.baseline) continue;
				const outcome = readWorkDiff(scope.repositoryRoot, scope.baseline);
				assertCurrent(branchAnchor);
				if (outcome.diagnostic) continue;
				const { diagnostic: _diagnostic, ...recovered } = scope;
				save(objectiveId, {
					...(canRecoverSnapshotDiagnostic(scope.diagnostic) ? recovered : scope),
					pendingObservationIds: scope.pendingObservationIds!.filter((id) => active.has(id)),
					...(scope.observedMutation || outcome.patch.length || outcome.untracked.length
						? { observedMutation: true, pathScope: "repository" }
						: {}),
				});
			}
		},
		getWorkEvidence(objectiveId) {
			return read(objectiveId).map((scope) =>
				scope.pendingObservationIds?.length
					? {
							...scope,
							observedMutation: true,
							pathScope: "repository",
							diagnostic: scope.diagnostic ?? "repository_observation_terminal_missing",
						}
					: scope,
			);
		},
	};
}

/** Bounded completion evidence across every repository the objective actually mutated. */
export function readGoalWorkDiff(scopes: readonly RepositoryWorkEvidenceScope[]): WorkDiff | undefined {
	const changed = scopes.filter((scope) => scope.observedMutation);
	if (!changed.length) return undefined;
	const repositories = changed.map((scope) => ({
		root: scope.repositoryRoot,
		base: scope.baseline?.revision ?? "unknown",
	}));
	let patch = "";
	let omittedChars = 0;
	const untracked: string[] = [];
	const diagnostics: string[] = [];
	for (const scope of changed) {
		if (!scope.baseline || scope.diagnostic) {
			diagnostics.push(`${scope.repositoryRoot}: ${scope.diagnostic ?? "repository_work_baseline_unavailable"}`);
			continue;
		}
		const work = readWorkDiff(
			scope.repositoryRoot,
			scope.baseline,
			scope.pathScope === "repository" ? undefined : scope.changedPaths,
		);
		if (work.diagnostic) diagnostics.push(`${scope.repositoryRoot}: ${work.diagnostic}`);
		const section = work.patch.length ? `Repository ${JSON.stringify(scope.repositoryRoot)}\n${work.patch}` : "";
		const available = Math.max(0, WORK_DIFF_PATCH_LIMIT - patch.length);
		patch += section.slice(0, available);
		omittedChars += work.omittedChars + Math.max(0, section.length - available);
		for (const path of work.untracked) {
			if (untracked.length < WORK_DIFF_UNTRACKED_LIMIT) untracked.push(`${scope.repositoryRoot}:${path}`);
		}
	}
	return {
		base: repositories.length === 1 ? repositories[0]!.base : "multiple repositories",
		patch,
		omittedChars,
		untracked,
		repositories,
		...(diagnostics.length ? { diagnostic: diagnostics.join("\n").slice(0, 2048) } : {}),
	};
}
