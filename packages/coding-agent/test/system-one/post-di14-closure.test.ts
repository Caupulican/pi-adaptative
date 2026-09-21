import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { CompletionCoordinator } from "../../src/core/objective-execution/completion-coordinator.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { projectBoundedCombinedState } from "../../src/core/objective-execution/objective-route-projector.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import type { LiveWorkerAttempt } from "../../src/core/supervision/types.ts";
import { WorkerSemanticSupervisor } from "../../src/core/supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "../../src/core/supervision/worker-supervision-coordinator.ts";
import { captureCandidateSnapshot } from "../../src/core/system-one/candidate-snapshot.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

function gitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-candidate-"));
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	writeFileSync(join(root, "README.md"), "one\n");
	execFileSync("git", ["add", "README.md"], { cwd: root });
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: root });
	return root;
}

function runtime(objectiveId = "obj-1"): TaskRuntimeProjection {
	return {
		lastOrdinal: 1,
		agents: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
		objectives: {
			[objectiveId]: {
				objective: {
					schemaVersion: 1 as const,
					objectiveId,
					title: "t",
					description: "t",
					acceptanceCriteria: [{ id: "c1", description: "c1", required: true }],
					status: "active",
					constraints: [],
					riskBudget: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				taskIds: [],
				evidence: [
					{
						evidenceId: "e1",
						criterionId: "c1",
						kind: "test",
						summary: "ok",
						artifactIds: [],
						trusted: true,
						createdAt: new Date().toISOString(),
					},
				],
			},
		},
		tasks: {},
		attempts: {},
	};
}

const PROVEN_SHA = "abc1234deadbeef";

function provenGit(options?: { push?: "ok" | "throw" }) {
	return {
		inspectCandidate: async () => ({ parent: "parent-approved", tree: "tree-approved", digest: "unused" }),
		commit: async () => ({ sha: PROVEN_SHA }),
		push: async () => {
			if (options?.push === "throw") throw new Error("rejected");
			return { ref: "refs/heads/main", remote: "origin" };
		},
		proveDelivery: async () => ({
			head: PROVEN_SHA,
			parent: "parent-approved",
			tree: "tree-approved",
			remote: "origin",
			ref: "refs/heads/main",
			observedSha: PROVEN_SHA,
			attributableResidue: [] as string[],
		}),
	};
}

function attempt(id = "a1"): LiveWorkerAttempt {
	return {
		objectiveId: "o",
		taskId: "t",
		attemptId: id,
		role: "worker",
		mission: "m",
		toolCalls: 4,
		elapsedMs: 10_000,
		outputTail: `${id}-${Date.now()}`,
	};
}

async function runWithFailedDeliveryCheckpoint(failedCheckpoint: "JEV-025" | "JEV-027"): Promise<{
	result: Awaited<ReturnType<ObjectiveExecutionController["run"]>>;
	store: ExecutionStore;
	persistFlags: Array<boolean | undefined>;
	innerVerdicts: string[];
}> {
	const store = new ExecutionStore({
		run_id: `run-${failedCheckpoint}`,
		objective: {
			request: "do it",
			normalized_goal: "do it",
			acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
		},
		repo: { root: "/workspace", baseline_revision: "r0" },
	});
	store.recordVerification({
		kind: "unit_test",
		status: "passed",
		covers_acceptance_ids: ["c1"],
	});
	const passingAdapter = {
		provenance: "native_calibrated" as const,
		evaluate: async (input: { questions?: Record<string, unknown> }) => {
			if (input.questions && Object.hasOwn(input.questions, "missing_requirement")) {
				return {
					model: "jev-1.13.0",
					answers: {
						missing_requirement: { noul: 0.01 },
						hidden_assumption: { noul: 0.01 },
						plausible_regression_not_tested: { noul: 0.01 },
						conclusion_overstates_evidence: { noul: 0.01 },
					},
					latency_ms: 1,
				};
			}
			return {
				model: "jev-1.13.0",
				answers: {
					implementation_matches_goal: { noul: 0.99 },
					root_cause_addressed: { noul: 0.99 },
					required_behavior_unverified: { noul: 0.01 },
					material_claim_unsupported: { noul: 0.01 },
					out_of_scope_change_present: { noul: 0.01 },
					duplicate_responsibility_introduced: { noul: 0.01 },
					completion_verdict: {
						choice: "complete",
						confidence: 0.99,
						probabilities: { complete: 0.99, rework: 0.01 },
					},
				},
				latency_ms: 1,
			};
		},
	};
	const systemOne = new SystemOneController({ store, adapter: passingAdapter });
	const persistFlags: Array<boolean | undefined> = [];
	const innerVerdicts: string[] = [];
	const controller = new ObjectiveExecutionController({
		mode: "objective_primary",
		completionProfile: "system_one_required",
		runtime: {
			reconcileObjective: async () => runtime("obj-1"),
		},
		executionCharter: compileExecutionCharter({
			objectiveId: "obj-1",
			prompt: "ship",
			initialGrants: { git: { commit: true, push: true, push_remote: "origin", push_ref: "refs/heads/main" } },
		}),
		gitExecutor: provenGit(),
		systemOne: {
			adapter: passingAdapter,
			snapshot: () => store.snapshot(),
			evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
			executeCompletionTransaction: async (isBugFix, options) => {
				persistFlags.push(options?.persistTerminal);
				const verdict = await systemOne.executeCompletionTransaction(isBugFix, options);
				innerVerdicts.push(verdict.verdict);
				return verdict;
			},
		},
		steeringPlane: {
			policy: { mode: "system_one_required" },
			requireCertificate: async (checkpoint: string) => ({
				certificate_id: `c-${checkpoint}`,
				semantic_outcome: checkpoint === failedCheckpoint ? "fail" : "pass",
				answers: {
					work_remaining: { boolean: false },
					missing_work_class: { choice: "none" },
				},
				directive: checkpoint === "JEV-024" ? "completion_candidate" : "allow",
				failed_semantic_predicates: checkpoint === failedCheckpoint ? [`${failedCheckpoint}_rejected`] : undefined,
			}),
		} as never,
		repoRoot: gitRepo(),
	});
	const result = await controller.run("obj-1");
	return { result, store, persistFlags, innerVerdicts };
}

describe("post-DI14 closure gates", () => {
	it("Gate 1: missing execution state fails closed without throw under system_one_required", async () => {
		const result = await CompletionCoordinator.evaluate("obj-1", "system_one_required", {
			runtime: runtime(),
			hasCalibratedEngine: () => true,
			semanticEvaluator: { evaluateCompletion: async () => ({ passed: true }) },
		});
		expect(result.verdict).toBe("semantic_gate_unavailable");
		expect(result.failedGates).toContain("execution_state_unavailable");
	});

	it("Gate 1: wired completion_candidate supplies ExecutionStore into CompletionProof", async () => {
		const store = new ExecutionStore({
			run_id: "run-1",
			objective: {
				request: "do it",
				normalized_goal: "do it",
				acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
			},
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		const result = await CompletionCoordinator.evaluate("obj-1", "mechanical", {
			runtime: runtime(),
			getExecutionState: () => store.snapshot(),
			repoRoot: gitRepo(),
		});
		expect(result.failedGates).not.toContain("execution_state_unavailable");
		expect(result.candidateSnapshot?.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.deterministicGateRecords.length).toBeGreaterThan(0);
	});

	it("Gate 3: inner semantic pass with persistTerminal false does not set store complete", async () => {
		const store = new ExecutionStore({
			run_id: "run-inner",
			objective: {
				request: "do it",
				normalized_goal: "do it",
				acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
			},
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			covers_acceptance_ids: ["c1"],
		});
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						implementation_matches_goal: { noul: 0.99 },
						root_cause_addressed: { noul: 0.99 },
						required_behavior_unverified: { noul: 0.01 },
						material_claim_unsupported: { noul: 0.01 },
						out_of_scope_change_present: { noul: 0.01 },
						duplicate_responsibility_introduced: { noul: 0.01 },
						completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 0.99 } },
						missing_requirement: { noul: 0.01 },
						hidden_assumption: { noul: 0.01 },
						plausible_regression_not_tested: { noul: 0.01 },
						conclusion_overstates_evidence: { noul: 0.01 },
					},
					latency_ms: 1,
				}),
			},
		});
		const verdict = await controller.executeCompletionTransaction(false, { persistTerminal: false });
		expect(verdict.verdict).toBe("complete");
		expect(store.phase).not.toBe("complete");
	});

	it("Gate 3: run() inner semantic pass then JEV-025 fail terminals unrecoverable without completing the store", async () => {
		const { result, store, persistFlags, innerVerdicts } = await runWithFailedDeliveryCheckpoint("JEV-025");
		expect(persistFlags).toEqual([false]);
		expect(innerVerdicts).toEqual(["complete"]);
		expect(store.phase).not.toBe("complete");
		expect(result.status).toBe("unrecoverable");
		expect(result.reasonCodes).toContain("primary_completion_failed");
	});

	it("Gate 3: run() inner semantic pass then JEV-027 fail leaves store and objective not complete", async () => {
		const { result, store, persistFlags, innerVerdicts } = await runWithFailedDeliveryCheckpoint("JEV-027");
		expect(persistFlags).toEqual([false]);
		expect(innerVerdicts).toEqual(["complete"]);
		expect(store.phase).not.toBe("complete");
		expect(result.status).not.toBe("complete");
		expect(result.reasonCodes).toContain("delivery_certificate_rejected");
	});

	it("Gate 4: same worktree digest is stable; tracked, untracked, rename, and revision mutate it", () => {
		const root = gitRepo();
		const first = captureCandidateSnapshot(root);
		const again = captureCandidateSnapshot(root);
		expect(again.digest).toBe(first.digest);
		expect(first.repoRoot).toBe(root);

		writeFileSync(join(root, "README.md"), "two\n");
		const tracked = captureCandidateSnapshot(root);
		expect(tracked.digest).not.toBe(first.digest);

		writeFileSync(join(root, "scratch.txt"), "u\n");
		const untracked = captureCandidateSnapshot(root);
		expect(untracked.digest).not.toBe(tracked.digest);

		mkdirSync(join(root, "moved"));
		writeFileSync(join(root, "moved", "scratch.txt"), "u\n");
		execFileSync("rm", ["scratch.txt"], { cwd: root });
		const renamed = captureCandidateSnapshot(root);
		expect(renamed.digest).not.toBe(untracked.digest);

		execFileSync("git", ["add", "README.md"], { cwd: root });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "two"], { cwd: root });
		const revised = captureCandidateSnapshot(root);
		expect(revised.digest).not.toBe(renamed.digest);
		expect(revised.candidateRevision).not.toBe(first.candidateRevision);
	});

	it("Gate 4: missing System One state is explicit unavailable, not a clean empty matrix", () => {
		const projection = projectBoundedCombinedState("obj-1", runtime(), {});
		expect(projection.integrity.state).toBe("unavailable");
		expect(projection.integrity.failed_verifications).toEqual(["integrity_state_unavailable"]);
		expect(projection.integrity.open_hypotheses).toEqual(["unknown"]);
		expect(projection.integrity.recent_changes).toEqual(["unknown"]);
	});

	it("Gate 5/6: failed push retains the receipt, omits push_refs, and is not complete", async () => {
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: {
				reconcileObjective: async () => runtime("obj-1"),
			},
			executionCharter: compileExecutionCharter({
				objectiveId: "obj-1",
				prompt: "ship",
				initialGrants: { git: { commit: true, push: true, push_remote: "origin", push_ref: "refs/heads/main" } },
			}),
			gitExecutor: provenGit({ push: "throw" }),
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
			},
			repoRoot: gitRepo(),
		});
		const result = await controller.run("obj-1");
		expect(result.status).not.toBe("complete");
		expect(result.deliveryBundle?.side_effects?.push?.state).toBe("failed");
		expect(result.deliveryBundle?.push_refs).toBeUndefined();
		expect(result.deliveryBundle?.side_effects?.commit?.state).toBe("proven");
	});

	it("Gate 6: JEV-027 payload includes the final push receipt", async () => {
		const payloads: { checkpoint: string; push?: string; digest?: string }[] = [];
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: {
				reconcileObjective: async () => runtime("obj-1"),
			},
			executionCharter: compileExecutionCharter({
				objectiveId: "obj-1",
				prompt: "ship",
				initialGrants: { git: { commit: true, push: true, push_remote: "origin", push_ref: "refs/heads/main" } },
			}),
			gitExecutor: provenGit(),
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
			},
			steeringPlane: {
				policy: { mode: "optional" },
				requireCertificate: async (checkpoint: string, payload: unknown) => {
					const bundle = payload as {
						push_refs?: string[];
						diff_digest?: string;
						side_effects?: { push?: { state: string } };
					};
					payloads.push({
						checkpoint,
						push: bundle.push_refs?.[0],
						digest: bundle.diff_digest,
					});
					return {
						certificate_id: `c-${checkpoint}`,
						semantic_outcome: "pass",
						answers: {
							work_remaining: { boolean: false },
							missing_work_class: { choice: "none" },
						},
						directive: checkpoint === "JEV-024" ? "completion_candidate" : "allow",
					};
				},
			} as never,
			repoRoot: gitRepo(),
		});
		const result = await controller.run("obj-1");
		expect(result.status).toBe("complete");
		const jev027 = payloads.find((entry) => entry.checkpoint === "JEV-027");
		expect(jev027?.push).toBe("refs/heads/main");
	});

	it("Gate 7: system_one_required semantic outage is not mechanical complete", async () => {
		const result = await CompletionCoordinator.evaluate("obj-1", "system_one_required", {
			runtime: runtime(),
			getExecutionState: () =>
				new ExecutionStore({
					run_id: "r",
					objective: {
						request: "do it",
						normalized_goal: "do it",
						acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
					},
					repo: { root: "/workspace", baseline_revision: "r0" },
				}).snapshot(),
			repoRoot: gitRepo(),
			hasCalibratedEngine: () => false,
		});
		expect(result.verdict).toBe("semantic_gate_unavailable");
		expect(result.assuranceProfileUsed).toBeUndefined();
	});

	it("Gate 8: open breaker issues one stop_and_reroute and then makes no further Jev calls", async () => {
		let calls = 0;
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			maxFailures: 3,
			decisionEngine: {
				evaluate: async () => {
					calls += 1;
					throw new Error("jev down");
				},
			},
		});
		await expect(supervisor.observe({ ...attempt("brk"), outputTail: "1" })).rejects.toThrow(/jev down/);
		await expect(supervisor.observe({ ...attempt("brk"), outputTail: "2" })).rejects.toThrow(/jev down/);
		const trip = await supervisor.observe({ ...attempt("brk"), outputTail: "3" });
		expect(trip?.action).toBe("stop_and_reroute");
		expect(calls).toBe(3);
		const after = await supervisor.observe({ ...attempt("brk"), outputTail: "4" });
		expect(after).toBeUndefined();
		expect(calls).toBe(3);
	});

	it("pending root requests include mark_external_block", async () => {
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor: new WorkerSemanticSupervisor({
				debounceMs: 0,
				minToolCalls: 0,
				minElapsedMs: 0,
				steering: {
					requireCertificate: async () => ({
						certificate_id: "c-ext",
						answers: {
							meaningful_progress: { type: "noul", noul: 0.9 },
							worker_stuck: { type: "noul", noul: 0.1 },
							work_off_track: { type: "noul", noul: 0.1 },
							strategy_repetition: { type: "noul", noul: 0.1 },
							needs_independent_verification: { type: "noul", noul: 0.1 },
							specialist_gap_present: { type: "noul", noul: 0.1 },
							capability_gap_present: { type: "noul", noul: 0.1 },
							external_block_present: { type: "noul", noul: 0.95 },
						},
					}),
				},
			}),
			control: {
				steerWorker: async () => {},
				cancelWorker: async () => {},
			},
		});
		await coordinator.observe({ ...attempt("ext"), agentId: "w1" });
		expect(coordinator.getPendingRootRequests().map((signal) => signal.action)).toEqual(["mark_external_block"]);
	});
});
