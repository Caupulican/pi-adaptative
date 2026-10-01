import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import {
	RepositoryMutationObserver,
	type RepositoryWorkEvidenceJournal,
	type RepositoryWorkEvidenceScope,
	RepositoryWorkEvidenceUnavailableError,
} from "../../src/core/objective-execution/repository-mutation-observer.ts";
import { captureWorkBaseline, readWorkRepositoryRoot } from "../../src/core/system-one/work-diff.ts";
import { committedRepo } from "../git-fixture.ts";
import { tempDir } from "../temp-dir.ts";

function repo(): string {
	const root = committedRepo("pi-work-evidence-");
	const repositoryRoot = readWorkRepositoryRoot(root);
	if (!repositoryRoot) throw new Error("Expected committed test fixture to have a Git repository root");
	return repositoryRoot;
}

function write(path: string, text: string): void {
	const fd = openSync(path, "w");
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

function fastWorkEvidenceJournal(repositoryRoot: string): RepositoryWorkEvidenceJournal & {
	branchAnchor: string;
	nextBranchAnchor?: string;
	setCurrentBranchAnchor(branchAnchor: string): void;
} {
	let branchAnchor = "branch-1";
	let nextBranchAnchor: string | undefined;
	const currentBranchAnchors = new Set<string>();
	return {
		get branchAnchor() {
			return branchAnchor;
		},
		set branchAnchor(value: string) {
			branchAnchor = value;
			currentBranchAnchors.clear();
		},
		get nextBranchAnchor() {
			return nextBranchAnchor;
		},
		set nextBranchAnchor(value: string | undefined) {
			nextBranchAnchor = value;
		},
		setCurrentBranchAnchor(value: string) {
			currentBranchAnchors.add(value);
		},
		isCurrentBranchAnchor: (candidate) =>
			candidate === branchAnchor || Boolean(candidate && currentBranchAnchors.has(candidate)),
		ensureBaseline: async () => {
			const admittedAnchor = nextBranchAnchor ?? branchAnchor;
			if (nextBranchAnchor) currentBranchAnchors.add(nextBranchAnchor);
			nextBranchAnchor = undefined;
			return { repositoryRoot, created: false, branchAnchor: admittedAnchor, baselineStatus: "captured" };
		},
		recordBaselineDiagnostic: async () => {},
		openObservation: async () => {},
		closeObservation: async () => {},
		recordObservedChange: async () => {},
		recoverObservations: async () => {},
		getWorkEvidence: () => [],
	};
}

class MemoryWorkEvidenceJournal implements RepositoryWorkEvidenceJournal {
	private readonly scopes = new Map<string, RepositoryWorkEvidenceScope>();
	readonly events: string[] = [];
	private activeBranchAnchor = "branch-1";
	private readonly currentBranchAnchors = new Set<string>();
	nextBranchAnchor: string | undefined;
	failObservedChange = false;
	throwAfterOpen = false;

	get branchAnchor(): string {
		return this.activeBranchAnchor;
	}

	set branchAnchor(branchAnchor: string) {
		this.activeBranchAnchor = branchAnchor;
		this.currentBranchAnchors.clear();
	}

	isCurrentBranchAnchor(branchAnchor: string | undefined): boolean {
		return (
			branchAnchor === this.activeBranchAnchor ||
			Boolean(branchAnchor && this.currentBranchAnchors.has(branchAnchor))
		);
	}

	async ensureBaseline(
		objectiveId: string,
		cwd: string,
	): Promise<{
		readonly repositoryRoot: string;
		readonly created: boolean;
		readonly branchAnchor: string;
		readonly baselineStatus: "captured" | "unversioned";
	}> {
		const baseline = captureWorkBaseline(cwd);
		const repositoryRoot = baseline?.root ?? cwd;
		const branchAnchor = this.nextBranchAnchor ?? this.activeBranchAnchor;
		if (this.nextBranchAnchor) {
			this.currentBranchAnchors.add(this.nextBranchAnchor);
			this.nextBranchAnchor = undefined;
		}
		const key = this.key(objectiveId, repositoryRoot);
		this.events.push(`baseline:${repositoryRoot}`);
		if (!baseline) return { repositoryRoot, created: false, branchAnchor, baselineStatus: "unversioned" };
		const created = !this.scopes.has(key);
		if (created) {
			this.scopes.set(key, { repositoryRoot, baseline, changedPaths: [] });
		}
		return { repositoryRoot, created, branchAnchor, baselineStatus: "captured" };
	}

	async recordBaselineDiagnostic(
		objectiveId: string,
		repositoryRoot: string,
		reason: string,
		_branchAnchor?: string,
	): Promise<void> {
		const current = this.scopes.get(this.key(objectiveId, repositoryRoot));
		this.scopes.set(this.key(objectiveId, repositoryRoot), {
			repositoryRoot,
			baseline: current?.baseline,
			changedPaths: current?.changedPaths ?? [],
			diagnostic: reason,
			...(current?.observedMutation ? { observedMutation: true } : {}),
		});
		this.events.push(`diagnostic:${reason}`);
	}

	async openObservation(
		objectiveId: string,
		repositoryRoot: string,
		observationId: string,
		input: { readonly effect: "typed_owned_write" | "observe" | "none"; readonly branchAnchor?: string },
	): Promise<void> {
		if (!this.isCurrentBranchAnchor(input.branchAnchor)) throw new Error("stale branch");
		const key = this.key(objectiveId, repositoryRoot);
		const scope = this.scopes.get(key);
		if (!scope?.baseline) throw new Error("missing baseline");
		this.scopes.set(key, {
			...scope,
			pendingObservationIds: [...new Set([...(scope.pendingObservationIds ?? []), observationId])],
		});
		this.events.push(`open:${observationId}`);
		if (this.throwAfterOpen) {
			this.throwAfterOpen = false;
			throw new Error("journal append completed before reporting failure");
		}
	}

	async closeObservation(
		objectiveId: string,
		repositoryRoot: string,
		observationId: string,
		branchAnchor?: string,
	): Promise<void> {
		if (!this.isCurrentBranchAnchor(branchAnchor)) throw new Error("stale branch");
		const key = this.key(objectiveId, repositoryRoot);
		const scope = this.scopes.get(key);
		if (!scope) return;
		this.scopes.set(key, {
			...scope,
			pendingObservationIds: (scope.pendingObservationIds ?? []).filter((id) => id !== observationId),
		});
		this.events.push(`close:${observationId}`);
	}

	async recordObservedChange(
		objectiveId: string,
		repositoryRoot: string,
		changedPaths: readonly string[],
		input: {
			readonly observationId?: string;
			readonly branchAnchor?: string;
			readonly operationSucceeded: boolean;
			readonly effect: "typed_owned_write" | "observe" | "none";
			readonly observedMutation: true;
			readonly diagnostic?: string;
		},
	): Promise<void> {
		if (this.failObservedChange) throw new Error("journal write failed");
		if (!this.isCurrentBranchAnchor(input.branchAnchor)) throw new Error("stale branch");
		const current = this.scopes.get(this.key(objectiveId, repositoryRoot));
		if (!current?.baseline) throw new Error("missing baseline");
		this.scopes.set(this.key(objectiveId, repositoryRoot), {
			repositoryRoot,
			baseline: current.baseline,
			changedPaths: [...new Set([...current.changedPaths, ...changedPaths])],
			observedMutation: true,
			diagnostic: input.diagnostic ?? current.diagnostic,
			pendingObservationIds: (current.pendingObservationIds ?? []).filter((id) => id !== input.observationId),
		});
		this.events.push(`change:${input.operationSucceeded ? "success" : "failure"}`);
	}

	async recoverObservations(objectiveId: string, activeObservationIds: readonly string[]): Promise<void> {
		const active = new Set(activeObservationIds);
		for (const [key, scope] of this.scopes) {
			if (!key.startsWith(`${objectiveId}\0`)) continue;
			const abandoned = (scope.pendingObservationIds ?? []).filter((id) => !active.has(id));
			if (abandoned.length === 0) continue;
			this.scopes.set(key, {
				...scope,
				changedPaths: [],
				pathScope: "repository",
				observedMutation: true,
				diagnostic: "repository_observation_recovered",
				pendingObservationIds: (scope.pendingObservationIds ?? []).filter((id) => active.has(id)),
			});
		}
	}

	getWorkEvidence(objectiveId: string): readonly RepositoryWorkEvidenceScope[] {
		const prefix = `${objectiveId}\0`;
		return [...this.scopes]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, scope]) =>
				(scope.pendingObservationIds?.length ?? 0) > 0
					? {
							...scope,
							pathScope: "repository" as const,
							observedMutation: true as const,
							diagnostic: "repository_observation_recovery_pending",
						}
					: scope,
			);
	}

	private key(objectiveId: string, repositoryRoot: string): string {
		return `${objectiveId}\0${repositoryRoot}`;
	}
}

describe("repository mutation work evidence", () => {
	it("records an absolute typed target against the canonical repository root from nested cwd", async () => {
		const root = repo();
		const nested = join(root, "nested", "working");
		mkdirSync(nested, { recursive: true });
		const target = join(root, "other", "created.txt");
		mkdirSync(dirname(target), { recursive: true });
		const ledger = new ObjectiveMutationLedger();
		const observer = new RepositoryMutationObserver(ledger);
		const token = await observer.begin({
			callId: "nested-absolute-target",
			objectiveId: "goal-nested-root",
			cwd: nested,
			effect: "typed_owned_write",
		});

		write(target, "typed write from nested cwd\n");
		await observer.finish({ token, declaredOwnedPaths: [target], operationSucceeded: true });

		expect(ledger.provenOwnedPaths("goal-nested-root")).toEqual(["other/created.txt"]);
	});

	it("attributes overlapping typed writes to their group and preserves serial and observe controls", async () => {
		const root = repo();
		const ledger = new ObjectiveMutationLedger();
		const observer = new RepositoryMutationObserver(ledger);
		const journal = fastWorkEvidenceJournal(root);
		observer.setWorkEvidenceJournal(journal);
		const runId = randomUUID();
		const firstPath = join(root, `${runId}-first.txt`);
		const secondPath = join(root, `${runId}-second.txt`);
		const first = await observer.begin({
			callId: "overlap-first",
			objectiveId: "goal-overlap",
			cwd: root,
			effect: "typed_owned_write",
		});
		journal.nextBranchAnchor = "branch-descendant";
		const second = await observer.begin({
			callId: "overlap-second",
			objectiveId: "goal-overlap",
			cwd: root,
			effect: "typed_owned_write",
		});

		write(firstPath, "first typed write\n");
		write(secondPath, "second typed write\n");
		await observer.finish({ token: first, declaredOwnedPaths: [firstPath], operationSucceeded: true });
		await observer.finish({ token: second, declaredOwnedPaths: [secondPath], operationSucceeded: true });

		expect([...ledger.provenOwnedPaths("goal-overlap")].sort()).toEqual([
			`${runId}-first.txt`,
			`${runId}-second.txt`,
		]);
		expect(observer.deliveryBlockReason("goal-overlap")).toBeUndefined();

		const undeclaredFirst = await observer.begin({
			callId: "overlap-undeclared-first",
			objectiveId: "goal-overlap-undeclared",
			cwd: root,
			effect: "typed_owned_write",
		});
		const undeclaredSecond = await observer.begin({
			callId: "overlap-undeclared-second",
			objectiveId: "goal-overlap-undeclared",
			cwd: root,
			effect: "typed_owned_write",
		});
		const undeclaredPath = join(root, `${runId}-genuinely-unowned.txt`);
		write(undeclaredPath, "unclaimed third path\n");
		await observer.finish({ token: undeclaredFirst, declaredOwnedPaths: [firstPath], operationSucceeded: true });
		await observer.finish({ token: undeclaredSecond, declaredOwnedPaths: [secondPath], operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-overlap-undeclared")).toBe("shell_mutation_unattributed");

		const serialized = await observer.begin({
			callId: "serialized-first",
			objectiveId: "goal-serialized",
			cwd: root,
			effect: "typed_owned_write",
		});
		const serializedPath = join(root, `${runId}-serialized.txt`);
		write(serializedPath, "serialized typed write\n");
		await observer.finish({ token: serialized, declaredOwnedPaths: [serializedPath], operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-serialized")).toBeUndefined();

		const unowned = await observer.begin({
			callId: "observed-unowned",
			objectiveId: "goal-unowned-observe",
			cwd: root,
			effect: "observe",
		});
		write(join(root, `${runId}-unowned.txt`), "unowned observed mutation\n");
		await observer.finish({ token: unowned, operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-unowned-observe")).toBe("shell_mutation_unattributed");

		const stale = await observer.begin({
			callId: "stale-group-member",
			objectiveId: "goal-replaced-group",
			cwd: root,
			effect: "typed_owned_write",
		});
		journal.branchAnchor = "new-branch";
		const replacementPath = join(root, `${runId}-replacement.txt`);
		const replacement = await observer.begin({
			callId: "replacement-group-member",
			objectiveId: "goal-replaced-group",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(replacementPath, "new branch typed write\n");
		await observer.finish({ token: stale, declaredOwnedPaths: [replacementPath], operationSucceeded: true });
		await observer.finish({ token: replacement, declaredOwnedPaths: [replacementPath], operationSucceeded: true });
		expect(ledger.provenOwnedPaths("goal-replaced-group")).toEqual([`${runId}-replacement.txt`]);
	});

	it("aggregates many completed writes while an overlapping observation remains active", async () => {
		const root = repo();
		const objectiveId = "goal-long-overlap";
		const ledger = new ObjectiveMutationLedger();
		const observer = new RepositoryMutationObserver(ledger);
		const keeper = await observer.begin({
			callId: "long-overlap-keeper",
			objectiveId,
			cwd: root,
			effect: "typed_owned_write",
		});
		const ownedPaths: string[] = [];
		for (let index = 0; index < 24; index++) {
			const fileName = `${randomUUID()}-${index}.txt`;
			const absolutePath = join(root, fileName);
			const token = await observer.begin({
				callId: `long-overlap-${index}`,
				objectiveId,
				cwd: root,
				effect: "typed_owned_write",
			});
			write(absolutePath, `typed write ${index}\n`);
			await observer.finish({ token, declaredOwnedPaths: [absolutePath], operationSucceeded: true });
			ownedPaths.push(fileName);
		}
		await observer.finish({ token: keeper, operationSucceeded: true });

		expect(observer.hasInFlight(objectiveId)).toBe(false);
		expect(observer.deliveryBlockReason(objectiveId)).toBeUndefined();
		expect([...ledger.provenOwnedPaths(objectiveId)].sort()).toEqual(ownedPaths.sort());
	});

	it("does not grant ownership for a failed partial write followed by a successful no-op", async () => {
		const root = repo();
		const ledger = new ObjectiveMutationLedger();
		const observer = new RepositoryMutationObserver(ledger);
		const failedTarget = join(root, `${randomUUID()}-failed-partial.txt`);
		const failedKeeper = await observer.begin({
			callId: "failed-write-keeper",
			objectiveId: "goal-failed-then-noop",
			cwd: root,
			effect: "typed_owned_write",
		});
		const failedWrite = await observer.begin({
			callId: "failed-partial-write",
			objectiveId: "goal-failed-then-noop",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(failedTarget, "partial bytes from failed call\n");
		await observer.finish({ token: failedWrite, declaredOwnedPaths: [failedTarget], operationSucceeded: false });
		const successfulNoOp = await observer.begin({
			callId: "successful-no-op",
			objectiveId: "goal-failed-then-noop",
			cwd: root,
			effect: "typed_owned_write",
		});
		await observer.finish({ token: successfulNoOp, declaredOwnedPaths: [failedTarget], operationSucceeded: true });
		await observer.finish({ token: failedKeeper, operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-failed-then-noop")).toBeUndefined();
		expect(ledger.provenOwnedPaths("goal-failed-then-noop")).toEqual([]);

		const successfulTarget = join(root, `${randomUUID()}-successful.txt`);
		const successfulKeeper = await observer.begin({
			callId: "successful-write-keeper",
			objectiveId: "goal-successful-overlap",
			cwd: root,
			effect: "typed_owned_write",
		});
		const successfulWrite = await observer.begin({
			callId: "successful-overlap-write",
			objectiveId: "goal-successful-overlap",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(successfulTarget, "ordinary successful typed mutation\n");
		await observer.finish({
			token: successfulWrite,
			declaredOwnedPaths: [successfulTarget],
			operationSucceeded: true,
		});
		await observer.finish({ token: successfulKeeper, operationSucceeded: true });
		expect(ledger.provenOwnedPaths("goal-successful-overlap")).toEqual([successfulTarget.slice(root.length + 1)]);
	});

	it("captures a dirty-tree baseline first and records failed partial changes without granting delivery", async () => {
		const root = repo();
		write(join(root, "README.md"), "pre-existing dirty bytes\n");
		write(join(root, "pre-existing.txt"), "pre-existing untracked bytes\n");
		const journal = new MemoryWorkEvidenceJournal();
		const ledger = new ObjectiveMutationLedger();
		const observer = new RepositoryMutationObserver(ledger);
		observer.setWorkEvidenceJournal(journal);

		const token = await observer.begin({ callId: "partial", objectiveId: "goal-a", cwd: root, effect: "observe" });
		expect(journal.events[0]).toBe(`baseline:${root}`);
		write(join(root, "README.md"), "partial failed change\n");
		write(join(root, "after-begin.txt"), "new partial file\n");
		await observer.finish({ token, operationSucceeded: false });

		const evidence = observer.getWorkEvidence("goal-a");
		expect(evidence).toHaveLength(1);
		expect(evidence[0]).toMatchObject({
			repositoryRoot: root,
			observedMutation: true,
			changedPaths: ["README.md", "after-begin.txt"],
		});
		expect(evidence[0]?.baseline).toBeDefined();
		expect(ledger.provenOwnedPaths("goal-a")).toEqual([]);
		expect(ledger.deliveryBlockReason("goal-a")).toBe("shell_mutation_unattributed");
	});

	it("marks a baseline capture that races a moving worktree as diagnostic evidence", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal({
			isCurrentBranchAnchor: (branchAnchor) => journal.isCurrentBranchAnchor(branchAnchor),
			openObservation: (...args) => journal.openObservation(...args),
			closeObservation: (...args) => journal.closeObservation(...args),
			recoverObservations: (...args) => journal.recoverObservations(...args),
			ensureBaseline: async (objectiveId, cwd) => {
				const baseline = await journal.ensureBaseline(objectiveId, cwd);
				write(join(root, "README.md"), "moved during baseline capture\n");
				return baseline;
			},
			recordBaselineDiagnostic: (objectiveId, repoRoot, reason) =>
				journal.recordBaselineDiagnostic(objectiveId, repoRoot, reason),
			recordObservedChange: (objectiveId, repoRoot, paths, input) =>
				journal.recordObservedChange(objectiveId, repoRoot, paths, input),
			getWorkEvidence: (objectiveId) => journal.getWorkEvidence(objectiveId),
		});

		await expect(
			observer.begin({ callId: "racing-baseline", objectiveId: "goal-race", cwd: root, effect: "observe" }),
		).rejects.toBeInstanceOf(RepositoryWorkEvidenceUnavailableError);
		expect(observer.getWorkEvidence("goal-race")[0]?.diagnostic).toBe("baseline_capture_unstable");
		expect(observer.hasInFlight("goal-race")).toBe(false);
	});

	it("replays an after-effect journal failure before the next mutation and preserves its original evidence", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		let failChange = true;
		observer.setWorkEvidenceJournal({
			isCurrentBranchAnchor: (branchAnchor) => journal.isCurrentBranchAnchor(branchAnchor),
			openObservation: (...args) => journal.openObservation(...args),
			closeObservation: (...args) => journal.closeObservation(...args),
			recoverObservations: (...args) => journal.recoverObservations(...args),
			ensureBaseline: (objectiveId, cwd) => journal.ensureBaseline(objectiveId, cwd),
			recordBaselineDiagnostic: (objectiveId, repoRoot, reason) =>
				journal.recordBaselineDiagnostic(objectiveId, repoRoot, reason),
			recordObservedChange: async (objectiveId, repositoryRoot, changedPaths, input) => {
				if (failChange) throw new Error("journal write failed");
				await journal.recordObservedChange(objectiveId, repositoryRoot, changedPaths, input);
			},
			getWorkEvidence: (objectiveId) => journal.getWorkEvidence(objectiveId),
		});
		const token = await observer.begin({
			callId: "journal-failure",
			objectiveId: "goal-journal-failure",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(join(root, "observed.txt"), "visible filesystem mutation\n");
		const quiescence = observer.waitForQuiescence("goal-journal-failure");
		await observer.finish({ token, declaredOwnedPaths: ["observed.txt"], operationSucceeded: false });
		await expect(quiescence).resolves.toBeUndefined();
		expect(observer.hasInFlight("goal-journal-failure")).toBe(false);
		expect(observer.deliveryBlockReason("goal-journal-failure")).toBe("work_evidence_persistence_failed");
		expect(observer.getWorkEvidence("goal-journal-failure")[0]).toMatchObject({
			repositoryRoot: root,
			observedMutation: true,
			diagnostic: expect.stringContaining("work_evidence_persistence_failed"),
		});

		const originalBaseline = observer.getWorkEvidence("goal-journal-failure")[0]?.baseline;
		await expect(
			observer.begin({ callId: "blocked-retry", objectiveId: "goal-journal-failure", cwd: root, effect: "observe" }),
		).rejects.toBeInstanceOf(RepositoryWorkEvidenceUnavailableError);
		failChange = false;
		const recovered = await observer.begin({
			callId: "recovered-retry",
			objectiveId: "goal-journal-failure",
			cwd: root,
			effect: "observe",
		});
		await observer.finish({ token: recovered, operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-journal-failure")).toBeUndefined();
		expect(journal.getWorkEvidence("goal-journal-failure")).toMatchObject([
			{
				repositoryRoot: root,
				baseline: originalBaseline,
				changedPaths: ["observed.txt"],
				observedMutation: true,
			},
		]);
		expect(journal.events).toContain("change:failure");
	});

	it("discards a failed finish handoff after the session moves to a sibling branch", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal({
			isCurrentBranchAnchor: (branchAnchor) => journal.isCurrentBranchAnchor(branchAnchor),
			openObservation: (...args) => journal.openObservation(...args),
			closeObservation: (...args) => journal.closeObservation(...args),
			recoverObservations: async () => {},
			ensureBaseline: (objectiveId, cwd) => journal.ensureBaseline(objectiveId, cwd),
			recordBaselineDiagnostic: (objectiveId, repositoryRoot, reason, branchAnchor) =>
				journal.recordBaselineDiagnostic(objectiveId, repositoryRoot, reason, branchAnchor),
			recordObservedChange: async () => {
				throw new Error("journal write failed");
			},
			getWorkEvidence: () => [],
		});
		const token = await observer.begin({
			callId: "stale-finish",
			objectiveId: "goal-stale",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(join(root, "sibling-only.txt"), "old branch output\n");
		await observer.finish({ token, declaredOwnedPaths: ["sibling-only.txt"], operationSucceeded: false });
		expect(observer.deliveryBlockReason("goal-stale")).toBe("work_evidence_persistence_failed");

		journal.branchAnchor = "sibling-branch";
		expect(observer.getWorkEvidence("goal-stale")).toEqual([]);
		expect(observer.deliveryBlockReason("goal-stale")).toBeUndefined();
		const sibling = await observer.begin({
			callId: "sibling",
			objectiveId: "goal-stale",
			cwd: root,
			effect: "observe",
		});
		await observer.finish({ token: sibling, operationSucceeded: true });
		expect(journal.events).not.toContain("change:failure");

		const staleToken = await observer.begin({
			callId: "late-stale-finish",
			objectiveId: "goal-stale-finish",
			cwd: root,
			effect: "typed_owned_write",
		});
		write(join(root, "late-stale-output.txt"), "belongs to the branch that just ended\n");
		journal.branchAnchor = "third-branch";
		await observer.finish({
			token: staleToken,
			declaredOwnedPaths: ["late-stale-output.txt"],
			operationSucceeded: false,
		});
		expect(observer.getWorkEvidence("goal-stale-finish")).toEqual([]);
		expect(observer.deliveryBlockReason("goal-stale-finish")).toBeUndefined();
	});

	it("recovers an effect whose terminal evidence append failed after observer restart", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const firstObserver = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		firstObserver.setWorkEvidenceJournal(journal);
		const token = await firstObserver.begin({
			callId: "restart-gap",
			objectiveId: "goal-restart-gap",
			cwd: root,
			effect: "observe",
		});
		write(join(root, "effect-before-restart.txt"), "effect survives observer process restart\n");
		journal.failObservedChange = true;
		await firstObserver.finish({ token, operationSucceeded: true });
		expect(journal.getWorkEvidence("goal-restart-gap")[0]?.pendingObservationIds).toContain(token.observationId);

		journal.failObservedChange = false;
		const restartedObserver = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		restartedObserver.setWorkEvidenceJournal(journal);
		await restartedObserver.recoverWorkEvidence("goal-restart-gap");
		expect(journal.getWorkEvidence("goal-restart-gap")).toMatchObject([
			{
				repositoryRoot: root,
				observedMutation: true,
				pathScope: "repository",
				pendingObservationIds: [],
				diagnostic: "repository_observation_recovered",
			},
		]);
	});

	it("closes only the canceled or completed observation's durable marker", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal(journal);
		const first = await observer.begin({
			callId: "parallel-a",
			objectiveId: "goal-parallel-markers",
			cwd: root,
			effect: "observe",
		});
		const second = await observer.begin({
			callId: "parallel-b",
			objectiveId: "goal-parallel-markers",
			cwd: root,
			effect: "observe",
		});
		await observer.abort(first);
		expect(journal.getWorkEvidence("goal-parallel-markers")[0]?.pendingObservationIds).toEqual([
			second.observationId,
		]);
		await observer.finish({ token: second, operationSucceeded: false });
		expect(journal.getWorkEvidence("goal-parallel-markers")[0]).toMatchObject({
			pendingObservationIds: [],
		});
		expect(journal.getWorkEvidence("goal-parallel-markers")[0]?.observedMutation).toBeUndefined();
	});

	it("closes a marker when its open append persisted before throwing", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal(journal);
		journal.throwAfterOpen = true;
		await expect(
			observer.begin({
				callId: "open-append-then-throw",
				objectiveId: "goal-open-append-then-throw",
				cwd: root,
				effect: "observe",
			}),
		).rejects.toBeInstanceOf(RepositoryWorkEvidenceUnavailableError);
		expect(journal.getWorkEvidence("goal-open-append-then-throw")[0]?.pendingObservationIds).toEqual([]);
		expect(journal.getWorkEvidence("goal-open-append-then-throw")[0]?.observedMutation).toBeUndefined();
	});

	it("does not let an old token's abort or late finish remove its call-id replacement", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal(journal);
		const first = await observer.begin({
			callId: "reused-call-id",
			objectiveId: "goal-reused-call-id",
			cwd: root,
			effect: "observe",
		});
		const replacement = await observer.begin({
			callId: "reused-call-id",
			objectiveId: "goal-reused-call-id",
			cwd: root,
			effect: "observe",
		});
		await observer.abort(first);
		expect(observer.hasInFlight("goal-reused-call-id")).toBe(true);
		await observer.finish({ token: first, operationSucceeded: false });
		expect(journal.getWorkEvidence("goal-reused-call-id")[0]?.pendingObservationIds).toEqual([
			replacement.observationId,
		]);
		await observer.finish({ token: replacement, operationSucceeded: false });
		expect(observer.hasInFlight("goal-reused-call-id")).toBe(false);
	});

	it("leaves unversioned machine-only work outside repository-outcome evidence", async () => {
		const cwd = tempDir("pi-work-evidence-no-repo-");
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal(journal);
		const token = await observer.begin({
			callId: "unknown-baseline",
			objectiveId: "goal-unknown",
			cwd,
			effect: "observe",
		});
		write(join(cwd, "changed.txt"), "machine-only change without a Git repository\n");
		await observer.finish({ token, operationSucceeded: false });

		expect(observer.getWorkEvidence("goal-unknown")).toEqual([]);
		expect(observer.deliveryBlockReason("goal-unknown")).toBeUndefined();
	});

	it("releases pre-effect waiters after a journal outage without poisoning a later retry", async () => {
		const root = repo();
		const journal = new MemoryWorkEvidenceJournal();
		let failFirstBaseline = true;
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal({
			isCurrentBranchAnchor: (branchAnchor) => journal.isCurrentBranchAnchor(branchAnchor),
			openObservation: (...args) => journal.openObservation(...args),
			closeObservation: (...args) => journal.closeObservation(...args),
			recoverObservations: (...args) => journal.recoverObservations(...args),
			ensureBaseline: async (objectiveId, cwd) => {
				if (failFirstBaseline) {
					failFirstBaseline = false;
					throw new Error("session journal temporarily unavailable");
				}
				return journal.ensureBaseline(objectiveId, cwd);
			},
			recordBaselineDiagnostic: (objectiveId, repositoryRoot, reason) =>
				journal.recordBaselineDiagnostic(objectiveId, repositoryRoot, reason),
			recordObservedChange: (objectiveId, repositoryRoot, paths, input) =>
				journal.recordObservedChange(objectiveId, repositoryRoot, paths, input),
			getWorkEvidence: (objectiveId) => journal.getWorkEvidence(objectiveId),
		});
		await expect(
			observer.begin({ callId: "outage", objectiveId: "goal-retry", cwd: root, effect: "observe" }),
		).rejects.toBeInstanceOf(RepositoryWorkEvidenceUnavailableError);
		expect(observer.hasInFlight("goal-retry")).toBe(false);
		expect(observer.deliveryBlockReason("goal-retry")).toBeUndefined();

		const recovered = await observer.begin({
			callId: "retry",
			objectiveId: "goal-retry",
			cwd: root,
			effect: "observe",
		});
		await observer.finish({ token: recovered, operationSucceeded: true });
		expect(observer.deliveryBlockReason("goal-retry")).toBeUndefined();
		expect(observer.getWorkEvidence("goal-retry")).toHaveLength(1);
	});

	it("keeps repository scopes separate and does not create a baseline for no-effect calls", async () => {
		const first = repo();
		const second = repo();
		const journal = new MemoryWorkEvidenceJournal();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		observer.setWorkEvidenceJournal(journal);
		const noEffect = await observer.begin({ callId: "read", objectiveId: "goal-multi", cwd: first, effect: "none" });
		await observer.finish({ token: noEffect, operationSucceeded: true });
		const firstToken = await observer.begin({
			callId: "first",
			objectiveId: "goal-multi",
			cwd: first,
			effect: "observe",
		});
		await observer.finish({ token: firstToken, operationSucceeded: true });
		const secondToken = await observer.begin({
			callId: "second",
			objectiveId: "goal-multi",
			cwd: second,
			effect: "observe",
		});
		await observer.finish({ token: secondToken, operationSucceeded: true });

		expect(
			observer
				.getWorkEvidence("goal-multi")
				.map((scope) => scope.repositoryRoot)
				.sort(),
		).toEqual([first, second].sort());
		expect(journal.events.filter((event) => event.startsWith("baseline:")).sort()).toEqual(
			[`baseline:${first}`, `baseline:${second}`].sort(),
		);
		expect(observer.getWorkEvidence("another-goal")).toEqual([]);
	});
});
