import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { expect, it } from "vitest";
import {
	createSessionWorkEvidenceJournal,
	readGoalWorkDiff,
	WORK_EVIDENCE_CUSTOM_TYPE,
} from "../../src/core/system-one/session-work-diff.ts";
import { hasRepositoryOutcome } from "../../src/core/system-one/work-diff.ts";
import { committedRepo } from "../git-fixture.ts";
import { tempDir } from "../temp-dir.ts";

const mutation = { operationSucceeded: true, effect: "typed_owned_write" as const, observedMutation: true as const };

it("keeps planning scope empty and excludes pre-existing work from a different launch repository", async () => {
	const startup = committedRepo("work-evidence-startup-");
	const task = committedRepo("work-evidence-task-");
	writeFileSync(join(startup, "owner.txt"), "startup owner work\n");
	writeFileSync(join(task, "README.md"), "task owner work\n");
	const manager = SessionManager.inMemory(startup);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	expect(readGoalWorkDiff(journal.getWorkEvidence("planning"))).toBeUndefined();
	const { branchAnchor } = await journal.ensureBaseline("implementation", task);
	expect(readGoalWorkDiff(journal.getWorkEvidence("implementation"))).toBeUndefined();
	writeFileSync(join(task, "README.md"), "task owner work\ngoal implementation\n");
	await journal.recordObservedChange("implementation", task, ["README.md"], { ...mutation, branchAnchor });
	const work = readGoalWorkDiff(journal.getWorkEvidence("implementation"))!;
	expect(work.patch).toContain("+goal implementation");
	expect(work.patch).not.toContain("+task owner work");
	expect(work.patch).not.toContain(startup);
	expect(work.repositories).toEqual([expect.objectContaining({ root: task })]);
	expect(journal.getWorkEvidence("planning")).toEqual([]);
});

it("preserves dirty baselines and partial failed writes across a journal adapter restart", async () => {
	const root = committedRepo("durable-work-evidence-");
	const manager = SessionManager.inMemory(root);
	let journal = createSessionWorkEvidenceJournal(() => manager);
	writeFileSync(join(root, "README.md"), "owner baseline\n");
	const { branchAnchor } = await journal.ensureBaseline("goal", root);
	const tree = journal.getWorkEvidence("goal")[0]!.baseline!.tree;
	writeFileSync(join(root, "README.md"), "owner baseline\npartial goal write\n");
	await journal.recordObservedChange("goal", root, ["README.md"], {
		...mutation,
		operationSucceeded: false,
		branchAnchor,
	});
	journal = createSessionWorkEvidenceJournal(() => manager);
	await journal.ensureBaseline("goal", root);
	expect(journal.getWorkEvidence("goal")[0]!.baseline!.tree).toBe(tree);
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.patch).toContain("+partial goal write");
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.patch).not.toContain("+owner baseline");
});

it("judges each mutated repository independently and keeps a reverted outcome empty", async () => {
	const first = committedRepo("multi-work-first-");
	const second = committedRepo("multi-work-second-");
	// A stable branch owns both repository scopes.
	const manager = SessionManager.inMemory(first);
	const stable = createSessionWorkEvidenceJournal(() => manager);
	const firstAdmission = await stable.ensureBaseline("goal", first);
	const secondAdmission = await stable.ensureBaseline("goal", second);
	writeFileSync(join(first, "README.md"), "first goal edit\n");
	writeFileSync(join(second, "README.md"), "second goal edit\n");
	await stable.recordObservedChange("goal", first, ["README.md"], {
		...mutation,
		branchAnchor: firstAdmission.branchAnchor,
	});
	await stable.recordObservedChange("goal", second, ["README.md"], {
		...mutation,
		branchAnchor: secondAdmission.branchAnchor,
	});
	const work = readGoalWorkDiff(stable.getWorkEvidence("goal"))!;
	expect(work.patch).toContain("+first goal edit");
	expect(work.patch).toContain("+second goal edit");
	expect(work.repositories).toHaveLength(2);
	writeFileSync(join(first, "README.md"), "one\n");
	writeFileSync(join(second, "README.md"), "one\n");
	expect(hasRepositoryOutcome(readGoalWorkDiff(stable.getWorkEvidence("goal")))).toBe(false);
	expect(stable.getWorkEvidence("unrelated")).toEqual([]);
});

it("does not borrow mutation evidence when the session branch is replaced", async () => {
	const root = committedRepo("branch-work-evidence-");
	let manager = SessionManager.inMemory(root);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	const { branchAnchor } = await journal.ensureBaseline("goal", root);
	writeFileSync(join(root, "README.md"), "first branch write\n");
	await journal.recordObservedChange("goal", root, ["README.md"], { ...mutation, branchAnchor });
	const prior = manager;
	manager = SessionManager.inMemory(root);
	expect(journal.getWorkEvidence("goal")).toEqual([]);
	manager = prior;
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.patch).toContain("+first branch write");
});

it("rejects a late mutation handoff after sibling navigation while accepting ordinary descendants", async () => {
	const root = committedRepo("late-branch-work-evidence-");
	const manager = SessionManager.inMemory(root);
	const parent = manager.appendCustomEntry("fixture-parent", {});
	const journal = createSessionWorkEvidenceJournal(() => manager);
	const { branchAnchor } = await journal.ensureBaseline("goal", root);
	manager.appendCustomEntry("ordinary-child", {});
	await journal.recordObservedChange("goal", root, ["README.md"], { ...mutation, branchAnchor });
	manager.branch(parent);
	manager.appendCustomEntry("sibling", {});
	await expect(
		journal.recordObservedChange("goal", root, ["README.md"], { ...mutation, branchAnchor }),
	).rejects.toThrow("stale session branch");
	expect(journal.getWorkEvidence("goal")).toEqual([]);
	await expect(journal.recordObservedChange("goal", root, [], mutation)).rejects.toThrow("no owning branch anchor");
});

it("keeps baseline tree objects reachable without changing HEAD", async () => {
	const root = committedRepo("retained-work-baseline-");
	const manager = SessionManager.inMemory(root);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	writeFileSync(join(root, "README.md"), "uncommitted owner baseline\n");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
	await journal.ensureBaseline("goal", root);
	const refs = execFileSync("git", ["for-each-ref", "--format=%(objectname)", "refs/pi/work-baselines/"], {
		cwd: root,
		encoding: "utf8",
	});
	expect(refs.trim()).toBe(journal.getWorkEvidence("goal")[0]!.baseline!.tree);
	expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(head);
});

it("does not invent repository evidence for machine-only work and fails closed on journal corruption", async () => {
	const root = committedRepo("invalid-work-evidence-");
	const manager = SessionManager.inMemory(root);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	await journal.ensureBaseline("machine", tempDir("machine-only-work-"));
	expect(journal.getWorkEvidence("machine")).toEqual([]);
	manager.appendCustomEntry(WORK_EVIDENCE_CUSTOM_TYPE, { version: 1, objectiveId: "goal", scopes: "broken" });
	const work = readGoalWorkDiff(journal.getWorkEvidence("goal"))!;
	expect(work.diagnostic).toContain("repository_work_journal_invalid");
	expect(hasRepositoryOutcome(work)).toBe(true);
});

it("does not classify a broken Git workspace as unversioned machine work", async () => {
	const root = tempDir("unavailable-work-repository-");
	writeFileSync(join(root, ".git"), "gitdir: missing-git-directory\n");
	const manager = SessionManager.inMemory(root);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	await expect(journal.ensureBaseline("goal", root)).rejects.toThrow("repository discovery");
	expect(journal.getWorkEvidence("goal")).toEqual([]);
	expect((await journal.ensureBaseline("machine", tempDir("discovery-machine-control-"))).baselineStatus).toBe(
		"unversioned",
	);
});

it("recovers a snapshot diagnostic against the retained pre-effect baseline", async () => {
	const root = committedRepo("recover-work-snapshot-");
	writeFileSync(join(root, "README.md"), "pre-existing owner bytes\n");
	const manager = SessionManager.inMemory(root);
	const journal = createSessionWorkEvidenceJournal(() => manager);
	const admission = await journal.ensureBaseline("goal", root);
	const baseline = journal.getWorkEvidence("goal")[0]!.baseline;
	writeFileSync(join(root, "goal.txt"), "actual goal effect\n");
	await journal.recordObservedChange("goal", root, [], {
		...mutation,
		branchAnchor: admission.branchAnchor,
		diagnostic: "repository_fingerprint_unavailable",
	});
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.diagnostic).toBeDefined();
	const recovered = await journal.ensureBaseline("goal", root);
	expect(recovered.created).toBe(false);
	expect(journal.getWorkEvidence("goal")[0]!.baseline).toEqual(baseline);
	const work = readGoalWorkDiff(journal.getWorkEvidence("goal"))!;
	expect(work.diagnostic).toBeUndefined();
	expect(work.patch).toContain("+actual goal effect");
	expect(work.patch).not.toContain("+pre-existing owner bytes");
	writeFileSync(join(root, "later.txt"), "subsequent goal effect\n");
	await journal.recordObservedChange("goal", root, ["later.txt"], {
		...mutation,
		branchAnchor: recovered.branchAnchor,
	});
	const subsequent = readGoalWorkDiff(journal.getWorkEvidence("goal"))!;
	expect(subsequent.patch).toContain("+actual goal effect");
	expect(subsequent.patch).toContain("+subsequent goal effect");
});

it("does not acknowledge a mutation handoff when its retained scope is missing", async () => {
	const manager = SessionManager.inMemory("/fixture/repository");
	const journal = createSessionWorkEvidenceJournal(() => manager);
	manager.appendCustomEntry("fixture-anchor", {});
	const branchAnchor = JSON.stringify({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
	await expect(
		journal.recordObservedChange("goal", "/fixture/repository", ["goal.txt"], { ...mutation, branchAnchor }),
	).rejects.toThrow("no retained baseline");
});

it("persists each pre-effect marker and closes only its own observation without storing the diagnostic projection", async () => {
	const root = "/fixture/repository";
	const manager = SessionManager.inMemory(root);
	manager.appendCustomEntry(WORK_EVIDENCE_CUSTOM_TYPE, {
		version: 1,
		objectiveId: "goal",
		scopes: [
			{ repositoryRoot: root, baseline: { root, revision: "a".repeat(40), tree: "b".repeat(40) }, changedPaths: [] },
		],
	});
	const journal = createSessionWorkEvidenceJournal(() => manager);
	const branchAnchor = JSON.stringify({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
	await journal.openObservation("goal", root, "first", { effect: mutation.effect, branchAnchor });
	await journal.openObservation("goal", root, "second", { effect: mutation.effect, branchAnchor });
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.diagnostic).toContain(
		"repository_observation_terminal_missing",
	);
	await journal.closeObservation("goal", root, "first", branchAnchor);
	expect(journal.getWorkEvidence("goal")[0]!.pendingObservationIds).toEqual(["second"]);
	await journal.recordObservedChange("goal", root, ["goal.txt"], {
		...mutation,
		branchAnchor,
		observationId: "second",
	});
	const scope = journal.getWorkEvidence("goal")[0]!;
	expect(scope.pendingObservationIds).toEqual([]);
	expect(scope.diagnostic).toBeUndefined();
	expect(scope.pathScope).toBeUndefined();
	expect(scope.changedPaths).toEqual(["goal.txt"]);
	expect(scope.observedMutation).toBe(true);
	manager.appendCustomEntry(WORK_EVIDENCE_CUSTOM_TYPE, {
		version: 1,
		objectiveId: "cancelled",
		scopes: [{ repositoryRoot: root, baseline: scope.baseline, changedPaths: [] }],
	});
	const cancelled = JSON.stringify({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
	await journal.openObservation("cancelled", root, "no-effect", { effect: mutation.effect, branchAnchor: cancelled });
	await journal.closeObservation("cancelled", root, "no-effect", cancelled);
	expect(readGoalWorkDiff(journal.getWorkEvidence("cancelled"))).toBeUndefined();
});

it("rejects markers without a retained baseline and fences cleanup to the owning branch", async () => {
	const root = "/fixture/repository";
	const manager = SessionManager.inMemory(root);
	const parent = manager.appendCustomEntry("parent", {});
	const journal = createSessionWorkEvidenceJournal(() => manager);
	let branchAnchor = JSON.stringify({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
	await expect(
		journal.openObservation("goal", root, "missing", { effect: mutation.effect, branchAnchor }),
	).rejects.toThrow("no retained baseline");
	manager.appendCustomEntry(WORK_EVIDENCE_CUSTOM_TYPE, {
		version: 1,
		objectiveId: "goal",
		scopes: [
			{ repositoryRoot: root, baseline: { root, revision: "a".repeat(40), tree: "b".repeat(40) }, changedPaths: [] },
		],
	});
	branchAnchor = JSON.stringify({ sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
	await journal.openObservation("goal", root, "owned", { effect: mutation.effect, branchAnchor });
	manager.branch(parent);
	manager.appendCustomEntry("sibling", {});
	await expect(journal.closeObservation("goal", root, "owned", branchAnchor)).rejects.toThrow("stale session branch");
	expect(journal.getWorkEvidence("goal")).toEqual([]);
});

it("recovers abandoned markers against the original baseline while preserving active siblings", async () => {
	const root = committedRepo("interrupted-work-observation-");
	writeFileSync(join(root, "README.md"), "pre-existing owner work\n");
	const manager = SessionManager.inMemory(root);
	let journal = createSessionWorkEvidenceJournal(() => manager);
	const { branchAnchor } = await journal.ensureBaseline("goal", root);
	const baseline = journal.getWorkEvidence("goal")[0]!.baseline;
	await journal.openObservation("goal", root, "abandoned", { effect: mutation.effect, branchAnchor });
	await journal.openObservation("goal", root, "live", { effect: mutation.effect, branchAnchor });
	writeFileSync(join(root, "goal.txt"), "interrupted goal write\n");
	journal = createSessionWorkEvidenceJournal(() => manager);
	expect(readGoalWorkDiff(journal.getWorkEvidence("goal"))!.diagnostic).toBeDefined();
	await journal.recoverObservations("goal", ["live"]);
	expect(journal.getWorkEvidence("goal")[0]!.pendingObservationIds).toEqual(["live"]);
	await journal.closeObservation("goal", root, "live", branchAnchor);
	const scope = journal.getWorkEvidence("goal")[0]!;
	expect(scope.baseline).toEqual(baseline);
	expect(scope.pathScope).toBe("repository");
	const work = readGoalWorkDiff([scope])!;
	expect(work.diagnostic).toBeUndefined();
	expect(work.patch).toContain("+interrupted goal write");
	expect(work.patch).not.toContain("+pre-existing owner work");
	const noEffect = await journal.ensureBaseline("no-effect", root);
	await journal.openObservation("no-effect", root, "cancelled", {
		effect: mutation.effect,
		branchAnchor: noEffect.branchAnchor,
	});
	await journal.recoverObservations("no-effect", []);
	expect(readGoalWorkDiff(journal.getWorkEvidence("no-effect"))).toBeUndefined();
});
