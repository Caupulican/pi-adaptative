import { execFileSync } from "node:child_process";

for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
	delete process.env[key];
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { resolveEffectiveCompletionProfile } from "../../src/core/decision/completion-profile.ts";
import { createRepoGitDelivery } from "../../src/core/objective-execution/delivery-proof.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { createRepoReleaseDelivery } from "../../src/core/objective-execution/release-delivery.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import { serializeEvaluation } from "../../src/core/review/typesafe-contract.ts";
import {
	SteeringJudgmentUnavailableError,
	SystemOneSteeringPlane,
} from "../../src/core/steering/system-one-steering-plane.ts";
import { SteeringSemanticFailedError, type SteeringSemanticOutcome } from "../../src/core/steering/types.ts";
import { requestsBugFix } from "../../src/core/system-one/bug-fix.ts";
import { SystemOneController, TerminalCompletionConflictError } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { IntegrityHookCoordinator } from "../../src/core/system-one/integrity-hooks.ts";

function trackUpstream(root: string, remote: string): string {
	const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["config", `branch.${branch}.remote`, remote], { cwd: root });
	execFileSync("git", ["config", `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: root });
	return branch;
}

function gitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-final-completion-"));
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: root });
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

function passingAdapter() {
	return {
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
}

function certificate(checkpoint: string, failed?: string, outcome: "fail" | "gather_more" = "fail") {
	const semanticOutcome: SteeringSemanticOutcome = checkpoint === failed ? outcome : "pass";
	return {
		certificate_id: `c-${checkpoint}`,
		semantic_outcome: semanticOutcome,
		answers: {
			work_remaining: { boolean: false },
			missing_work_class: { choice: "none" },
		},
		directive: checkpoint === "JEV-024" && checkpoint !== failed ? "completion_candidate" : "allow",
		failed_semantic_predicates: checkpoint === failed ? [`${failed}_rejected`] : undefined,
	};
}

async function deliver(options?: {
	readonly fail?: "JEV-025" | "JEV-026" | "JEV-027";
	/** How the failing checkpoint fails: a judged fail (default), an ambiguity, or System One down. */
	readonly failAs?: "fail" | "gather_more" | "unavailable";
	readonly commitSha?: string;
	readonly head?: string;
	readonly observedSha?: string;
	readonly reportedRemote?: string;
	readonly observedRemote?: string;
	readonly residue?: readonly string[];
	readonly push?: "ok" | "throw";
	readonly grants?: boolean | "missing";
	readonly wireTerminal?: boolean;
	readonly calibrated?: boolean;
	readonly profile?: "mechanical" | "semantic_enhanced" | "mechanical_plus_reviewer" | "system_one_required";
	readonly steeringMode?: "system_one_required" | "system_one_optional";
	readonly boundSystemOne?: boolean;
	readonly objectiveId?: string;
}) {
	const sha = options?.commitSha ?? "abc1234deadbeef";
	const head = options?.head ?? sha;
	const observedSha = options?.observedSha ?? sha;
	const store = new ExecutionStore({
		run_id: "run-final",
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
	let terminalHooks = 0;
	const hooks = new IntegrityHookCoordinator([
		{
			id: "terminal-counter",
			onHook: async (hook) => {
				if (hook === "terminal") terminalHooks += 1;
				return { decision: "allow", reasonCodes: [], validationRefs: [] };
			},
		},
	]);
	const adapter = passingAdapter();
	const systemOne = new SystemOneController({ store, adapter, hookCoordinator: hooks });
	const objectiveId = options?.objectiveId ?? "obj-1";
	let seenBugFix: boolean | undefined;
	const grants = options?.grants !== false;
	const controller = new ObjectiveExecutionController({
		mode: "objective_primary",
		...(options?.profile ? { completionProfile: options.profile } : {}),
		runtime: { reconcileObjective: async () => runtime(objectiveId) },
		...(grants
			? {
					executionCharter: compileExecutionCharter({
						objectiveId,
						prompt: "ship",
						initialGrants: {
							git: { commit: true, push: true, push_remote: "origin", push_ref: "refs/heads/main" },
						},
					}),
					...(options?.grants === "missing"
						? {}
						: {
								gitExecutor: {
									inspectCandidate: async () => ({
										parent: "parent-approved",
										tree: "tree-approved",
										digest: "unused",
									}),
									commit: async () => ({ sha }),
									push: async () => {
										if (options?.push === "throw") throw new Error("rejected");
										return { ref: "refs/heads/main", remote: options?.reportedRemote ?? "origin" };
									},
									proveDelivery: async () => ({
										head,
										parent: "parent-approved",
										tree: "tree-approved",
										remote: options?.observedRemote ?? "origin",
										ref: "refs/heads/main",
										observedSha,
										attributableResidue: options?.residue ?? [],
									}),
								},
							}),
				}
			: {}),
		...(options?.boundSystemOne === false
			? {}
			: {
					systemOne: {
						adapter: options?.calibrated === false ? { provenance: "synthetic_self_report" as const } : adapter,
						snapshot: () => store.snapshot(),
						evaluateObjectiveRoute: async () => ({
							workRemaining: false as const,
							missingWorkClass: "none" as const,
						}),
						executeCompletionTransaction: (
							isBugFix: boolean,
							callOptions?: { signal?: AbortSignal; persistTerminal?: boolean },
						) => {
							seenBugFix = isBugFix;
							return systemOne.executeCompletionTransaction(isBugFix, callOptions);
						},
						...(options?.wireTerminal === false
							? {}
							: {
									commitTerminalCompletion: (
										input: {
											objectiveId: string;
											candidateDigest: string;
											deliveryCertificateId?: string;
											finalCommit?: string;
											pushRefs?: readonly string[];
										},
										callOptions?: { signal?: AbortSignal },
									) => systemOne.commitTerminalCompletion(input, callOptions),
								}),
					},
				}),
		...(options?.steeringMode
			? {
					steeringPlane: {
						policy: { mode: options.steeringMode },
						// The real plane's contract: an outage throws; a non-pass throws unless requirePass is false.
						requireCertificate: async (
							checkpoint: string,
							_state: unknown,
							callOptions?: { requirePass?: boolean },
						) => {
							if (checkpoint === options.fail && options.failAs === "unavailable") {
								throw new SteeringJudgmentUnavailableError(
									checkpoint,
									"objective_transition",
									new Error("engine down"),
								);
							}
							const cert = certificate(
								checkpoint,
								options.fail,
								options.failAs === "gather_more" ? "gather_more" : "fail",
							);
							if ((callOptions?.requirePass ?? true) && cert.semantic_outcome !== "pass") {
								throw new SteeringSemanticFailedError(
									checkpoint,
									cert.semantic_outcome,
									cert.failed_semantic_predicates ?? [],
								);
							}
							return cert;
						},
					} as never,
				}
			: {}),
		repoRoot: gitRepo(),
	});
	const result = await controller.run(objectiveId);
	return { result, store, systemOne, terminalHooks: () => terminalHooks, seenBugFix: () => seenBugFix };
}

describe("FC-01 terminal complete", () => {
	it("outer success persists complete once and runs the terminal hook once", async () => {
		const { result, store, systemOne, terminalHooks, seenBugFix } = await deliver({
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(seenBugFix()).toBe(false);
		expect(result?.status).toBe("complete");
		expect(store.phase).toBe("complete");
		expect(terminalHooks()).toBe(1);

		const refs = result?.deliveryBundle?.steering_certificate_refs ?? [];
		await systemOne.commitTerminalCompletion({
			objectiveId: "obj-1",
			candidateDigest: result?.deliveryBundle?.diff_digest ?? "",
			deliveryCertificateId: refs[refs.length - 1],
			finalCommit: result?.deliveryBundle?.final_commit,
			pushRefs: result?.deliveryBundle?.push_refs,
		});
		expect(terminalHooks()).toBe(1);
		expect(store.phase).toBe("complete");

		await expect(
			systemOne.commitTerminalCompletion({
				objectiveId: "obj-1",
				candidateDigest: "different-candidate",
			}),
		).rejects.toBeInstanceOf(TerminalCompletionConflictError);
		expect(terminalHooks()).toBe(1);
		expect(store.phase).toBe("complete");
	});

	it("inner semantic pass with persistTerminal false does not set store complete", async () => {
		const store = new ExecutionStore({
			run_id: "run-inner",
			objective: {
				request: "do it",
				normalized_goal: "do it",
				acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
			},
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["c1"] });
		const systemOne = new SystemOneController({ store, adapter: passingAdapter() });
		const verdict = await systemOne.executeCompletionTransaction(false, { persistTerminal: false });
		expect(verdict.verdict).toBe("complete");
		expect(store.phase).not.toBe("complete");
	});

	it("JEV-025 fail leaves the store not complete", async () => {
		const { result, store } = await deliver({
			fail: "JEV-025",
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
	});

	it("JEV-026 fail returns unrecoverable and leaves the store not complete", async () => {
		const { result, store } = await deliver({
			fail: "JEV-026",
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(result?.status).toBe("unrecoverable");
		expect(result?.reasonCodes).toContain("adversarial_completion_failed");
		expect(store.phase).not.toBe("complete");
	});

	it.each([
		["JEV-025", "unavailable", "jev_025_unavailable"],
		["JEV-026", "gather_more", "jev_026_ambiguous"],
		["JEV-027", "unavailable", "jev_027_unavailable"],
	] as const)(
		"a %s that cannot settle (%s) holds the objective open and says why",
		async (checkpoint, failAs, reason) => {
			const { result, store } = await deliver({
				fail: checkpoint,
				failAs,
				profile: "system_one_required",
				steeringMode: "system_one_required",
			});
			expect(result?.status).toBe("semantic_gate_unavailable");
			expect(result?.reasonCodes).toContain(reason);
			expect(store.phase).not.toBe("complete");
		},
	);

	it("required receipt fail leaves the store not complete", async () => {
		const { result, store } = await deliver({
			push: "throw",
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
	});

	it("JEV-027 fail leaves the store not complete", async () => {
		const { result, store } = await deliver({
			fail: "JEV-027",
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
	});

	it("required commit and push without an executor do not throw and are not complete", async () => {
		const { result, store } = await deliver({
			profile: "mechanical",
			steeringMode: "system_one_optional",
			grants: "missing",
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
		expect(result?.deliveryBundle?.side_effects?.commit?.state).toBe("failed");
		expect(result?.deliveryBundle?.side_effects?.push?.state).toBe("failed");
	});

	it("rejects terminal completion from an invalid phase", async () => {
		const store = new ExecutionStore({
			run_id: "run-invalid",
			objective: {
				request: "do it",
				normalized_goal: "do it",
				acceptance_criteria: [],
			},
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		store.transitionPhase("aborted", true);
		const systemOne = new SystemOneController({ store, adapter: passingAdapter() });
		await expect(
			systemOne.commitTerminalCompletion({ objectiveId: "obj-1", candidateDigest: "digest" }),
		).rejects.toThrow(/invalid_phase/);
		expect(store.phase).toBe("aborted");
	});
});

describe("FC-01b completion evidence is JSON", () => {
	it("JEV-024 judges an objective with no git delivery or repository snapshot on transportable evidence", async () => {
		const judged: Array<{ checkpoint: string; state: Record<string, unknown> }> = [];
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: { reconcileObjective: async () => runtime("obj-1") },
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string, state: Record<string, unknown>) => {
					judged.push({ checkpoint, state });
					return certificate(checkpoint);
				},
			} as never,
			// Not a repository: no candidate snapshot, and no charter asks for a commit.
			repoRoot: mkdtempSync(join(tmpdir(), "pi-final-completion-plain-")),
		});
		await controller.run("obj-1");
		const completion = judged.find((entry) => entry.checkpoint === "JEV-024");
		expect(completion).toBeDefined();
		// The System One transport refuses `undefined`; absent evidence must be absent, not undefined.
		expect(() => serializeEvaluation({ state: completion?.state })).not.toThrow();
		expect(completion?.state).not.toHaveProperty("deliveryCandidate");
		expect(completion?.state).not.toHaveProperty("candidateSnapshot");
	});
});

describe("FC-02 effective completion profile", () => {
	it("required steering wins, optional semantic_enhanced stays, and no plane stays mechanical", () => {
		const rows: ReadonlyArray<{
			readonly requested?: "mechanical" | "semantic_enhanced" | "mechanical_plus_reviewer" | "reviewer";
			readonly steering?: "system_one_required" | "system_one_optional";
			readonly bound: boolean;
			readonly expected: string;
		}> = [
			{ requested: "mechanical", steering: "system_one_required", bound: true, expected: "system_one_required" },
			{
				requested: "semantic_enhanced",
				steering: "system_one_required",
				bound: true,
				expected: "system_one_required",
			},
			{ requested: "reviewer", steering: "system_one_required", bound: true, expected: "system_one_required" },
			{
				requested: "mechanical_plus_reviewer",
				steering: "system_one_required",
				bound: true,
				expected: "system_one_required",
			},
			{
				requested: "semantic_enhanced",
				steering: "system_one_optional",
				bound: true,
				expected: "semantic_enhanced",
			},
			{ bound: false, expected: "mechanical" },
		];
		for (const row of rows) {
			expect(
				resolveEffectiveCompletionProfile({
					requestedProfile: row.requested,
					steeringMode: row.steering,
					systemOneBound: row.bound,
				}),
			).toBe(row.expected);
		}
	});

	it("controller fallback does not let semantic_enhanced downgrade required steering", async () => {
		const { result } = await deliver({
			profile: "semantic_enhanced",
			steeringMode: "system_one_required",
			calibrated: false,
			grants: false,
		});
		expect(result?.status).toBe("semantic_gate_unavailable");
		expect(result?.reasonCodes).toContain("system_one_required_but_unavailable");
	});

	it("optional steering keeps an explicit semantic_enhanced profile", async () => {
		const { result } = await deliver({
			profile: "semantic_enhanced",
			steeringMode: "system_one_optional",
			grants: false,
			wireTerminal: false,
		});
		expect(result?.status).toBe("complete");
		expect(result?.deliveryBundle?.assurance_profile_requested).toBe("semantic_enhanced");
		expect(result?.deliveryBundle?.assurance_profile_used).toBe("semantic_enhanced");
	});

	it("no semantic plane keeps the effective profile mechanical", async () => {
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime("obj-1") },
		});
		vi.spyOn(controller, "evaluateRouteOnce").mockResolvedValue({
			schema_version: "1.0",
			cycle_id: "c1",
			objective_id: "obj-1",
			route: "completion_candidate",
			reason_codes: ["work_complete"],
		});
		const result = await controller.run("obj-1");
		expect(result.status).toBe("complete");
		expect(result.deliveryBundle?.assurance_profile_requested).toBe("mechanical");
		expect(result.deliveryBundle?.assurance_profile_used).toBe("mechanical");
	});
});

describe("FC-03 receipt binding", () => {
	it("a fake commit sha is not complete", async () => {
		const { result, store } = await deliver({
			commitSha: "fake-sha",
			head: "real-head",
			observedSha: "real-head",
			profile: "mechanical",
			steeringMode: "system_one_optional",
			wireTerminal: false,
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
		expect(result?.deliveryBundle?.side_effects?.commit?.state).toBe("failed");
	});

	it("a push whose reported remote differs from the observed remote is not complete", async () => {
		const sha = "abc1234deadbeef";
		const { result, store } = await deliver({
			commitSha: sha,
			head: sha,
			observedSha: sha,
			reportedRemote: "origin",
			observedRemote: "upstream",
			profile: "mechanical",
			steeringMode: "system_one_optional",
			wireTerminal: false,
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
		expect(result?.deliveryBundle?.side_effects?.push?.state).toBe("failed");
		if (result?.deliveryBundle?.side_effects?.push?.state === "failed") {
			expect(result.deliveryBundle.side_effects.push.error).toBe("push_remote_mismatch");
		}
	});

	it("a push whose observed sha differs from the commit sha is not complete", async () => {
		const { result, store } = await deliver({
			commitSha: "abc1234deadbeef",
			head: "abc1234deadbeef",
			observedSha: "ffffffffffffffff",
			profile: "mechanical",
			steeringMode: "system_one_optional",
			wireTerminal: false,
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
		expect(result?.deliveryBundle?.side_effects?.push?.state).toBe("failed");
	});

	it("matching head and observed remote sha are proven on the receipt and the final bundle", async () => {
		const sha = "abc1234deadbeef";
		const { result, store } = await deliver({
			commitSha: sha,
			head: sha,
			observedSha: sha,
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(result?.status).toBe("complete");
		expect(store.phase).toBe("complete");
		expect(result?.deliveryBundle?.final_commit).toBe(sha);
		expect(result?.deliveryBundle?.side_effects?.commit?.state).toBe("proven");
		expect(result?.deliveryBundle?.side_effects?.push).toEqual({
			state: "proven",
			detail: { remote: "origin", ref: "refs/heads/main", observedSha: sha },
		});
		expect(result?.deliveryBundle?.push_refs).toEqual(["refs/heads/main"]);
	});

	it("required commit with candidate residue is not complete", async () => {
		const sha = "abc1234deadbeef";
		const { result, store } = await deliver({
			commitSha: sha,
			head: sha,
			observedSha: sha,
			residue: ["leftover.ts"],
			profile: "mechanical",
			steeringMode: "system_one_optional",
			wireTerminal: false,
		});
		expect(result?.status).not.toBe("complete");
		expect(store.phase).not.toBe("complete");
		expect(result?.deliveryBundle?.side_effects?.commit?.state).toBe("failed");
	});

	it("a tag whose observed commit differs from the proven commit is not complete", async () => {
		const sha = "abc1234deadbeef";
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: { reconcileObjective: async () => runtime("obj-1") },
			executionCharter: compileExecutionCharter({
				objectiveId: "obj-1",
				prompt: "ship",
				initialGrants: { git: { commit: true, create_tag: true, tag_name: "v1" } },
			}),
			gitExecutor: {
				inspectCandidate: async () => ({
					parent: "parent-approved",
					tree: "tree-approved",
					digest: "unused",
				}),
				commit: async () => ({ sha }),
				tag: async () => ({ tag: "v1" }),
				proveDelivery: async () => ({
					head: sha,
					parent: "parent-approved",
					tree: "tree-approved",
					remote: "origin",
					ref: "refs/heads/main",
					observedSha: sha,
					attributableResidue: [],
				}),
				proveTag: async () => ({ tag: "v1", commitSha: "other-sha" }),
			},
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string) => certificate(checkpoint),
			} as never,
			repoRoot: gitRepo(),
		});
		const result = await controller.run("obj-1");
		expect(result.status).not.toBe("complete");
		expect(result.deliveryBundle?.side_effects?.tag?.state).toBe("failed");
	});

	it("a publish id the proof port does not observe is not complete", async () => {
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: { reconcileObjective: async () => runtime("obj-1") },
			executionCharter: compileExecutionCharter({
				objectiveId: "obj-1",
				prompt: "ship",
				initialGrants: {
					release: { package_publish: true, package_name: "pkg", package_version: "1.0.0" },
				},
			}),
			releaseExecutor: {
				publish: async () => ({ id: "pub-1" }),
				provePublish: async () => ({ publicationId: "pub-other" }),
			},
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string) => certificate(checkpoint),
			} as never,
			repoRoot: gitRepo(),
		});
		const result = await controller.run("obj-1");
		expect(result.status).not.toBe("complete");
		expect(result.deliveryBundle?.side_effects?.publish?.state).toBe("failed");
	});

	it("a deploy id the proof port does not observe is not complete", async () => {
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			completionProfile: "mechanical",
			runtime: { reconcileObjective: async () => runtime("obj-1") },
			executionCharter: compileExecutionCharter({
				objectiveId: "obj-1",
				prompt: "ship",
				initialGrants: { release: { deploy_targets: ["production"] } },
			}),
			releaseExecutor: {
				deploy: async () => ({ id: "dep-1" }),
				proveDeploy: async () => ({ target: "production", deploymentId: "dep-other" }),
			},
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string) => certificate(checkpoint),
			} as never,
			repoRoot: gitRepo(),
		});
		const result = await controller.run("obj-1");
		expect(result.status).not.toBe("complete");
		expect(result.deliveryBundle?.side_effects?.deploy?.[0]?.state).toBe("failed");
	});

	it("the session git delivery port commits owned paths, pushes the frozen upstream, and proves that tree", async () => {
		const root = gitRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-final-remote-"));
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
		const delivery = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		const committed = await delivery.commit({
			message: "two",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expect(committed.sha).toBe(head);
		expect(committed.tree).toBe(certified.tree);
		expect(committed.parent).toBe(certified.parent);
		const branch = trackUpstream(root, "origin");
		const pushed = await delivery.push({ remote: "origin", ref: `refs/heads/${branch}` });
		const proof = await delivery.proveDelivery({
			candidateDigest: certified.digest,
			candidateRevision: certified.parent,
			approvedTreeOid: certified.tree,
			approvedParent: certified.parent,
			candidateUntrackedPaths: ["leftover.txt"],
			remote: pushed.remote,
			ref: pushed.ref,
		});
		expect(proof.head).toBe(committed.sha);
		expect(proof.tree).toBe(certified.tree);
		expect(proof.parent).toBe(certified.parent);
		expect(proof.observedSha).toBe(committed.sha);
		expect(proof.remote).toBe("origin");
		expect(proof.ref).toBe(pushed.ref);
		expect(proof.attributableResidue).toEqual([]);
		writeFileSync(join(root, "leftover.txt"), "still\n");
		const residue = await delivery.proveDelivery({
			candidateDigest: certified.digest,
			candidateRevision: certified.parent,
			candidateUntrackedPaths: ["leftover.txt"],
			remote: pushed.remote,
			ref: pushed.ref,
		});
		expect(residue.attributableResidue).toContain("leftover.txt");
		const tagged = await delivery.tag("v1");
		expect(await delivery.proveTag(tagged.tag)).toEqual({ tag: "v1", commitSha: committed.sha });
	});

	it("a detached HEAD push fails and does not write refs/heads/main", async () => {
		const root = gitRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-final-detached-"));
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
		const delivery = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		await delivery.commit({
			message: "two",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		const branch = trackUpstream(root, "origin");
		const frozen = { remote: "origin", ref: `refs/heads/${branch}` };
		await delivery.push(frozen);
		execFileSync("git", ["checkout", "--detach"], { cwd: root });
		await expect(delivery.push(frozen)).rejects.toThrow("Detached HEAD cannot be pushed");
		const remote = execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare, encoding: "utf8" }).trim();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expect(remote).toBe(head);
		if (branch !== "main") {
			expect(() => execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: bare })).toThrow();
		}
	});

	it("a push uses the branch upstream and does not invent origin", async () => {
		const root = gitRepo();
		const bare = mkdtempSync(join(tmpdir(), "pi-final-upstream-"));
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		execFileSync("git", ["remote", "add", "upstream", bare], { cwd: root });
		const delivery = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		await delivery.commit({
			message: "two",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		await expect(delivery.push({ remote: "upstream", ref: "refs/heads/main" })).rejects.toThrow(/no upstream/);
		const before = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
			cwd: bare,
			encoding: "utf8",
		}).trim();
		expect(before).toBe("");
		const branch = trackUpstream(root, "upstream");
		const pushed = await delivery.push({ remote: "upstream", ref: `refs/heads/${branch}` });
		expect(pushed.remote).toBe("upstream");
		expect(pushed.ref).toBe(`refs/heads/${branch}`);
		const remote = execFileSync("git", ["rev-parse", pushed.ref], { cwd: bare, encoding: "utf8" }).trim();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expect(remote).toBe(head);
	});

	it("tag.gpgsign failure does not create an unsigned tag", async () => {
		const root = gitRepo();
		execFileSync("git", ["config", "tag.gpgsign", "true"], { cwd: root });
		execFileSync("git", ["config", "user.signingkey", "0000000000000000"], { cwd: root });
		const delivery = createRepoGitDelivery(root);
		writeFileSync(join(root, "README.md"), "two\n");
		const certified = await delivery.certifyOwnedCandidate(["README.md"]);
		await delivery.commit({
			message: "two",
			paths: ["README.md"],
			approvedParent: certified.parent,
			approvedTreeOid: certified.tree,
		});
		await expect(delivery.tag("v-sign")).rejects.toThrow(/sign/i);
		const listed = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" });
		expect(listed).not.toContain("v-sign");
	});
});

describe("completion catalog thresholds and release binding", () => {
	const directive = { action: "continue_current_work" as const, reasonCodes: [] };
	const plane = new SystemOneSteeringPlane();
	const strong = {
		implementation_matches_goal: { noul: 0.96 },
		root_cause_addressed: { noul: 0.5 },
		required_behavior_unverified: { noul: 0.05 },
		material_claim_unsupported: { noul: 0.05 },
		out_of_scope_change_present: { noul: 0.05 },
		duplicate_responsibility_introduced: { noul: 0.05 },
		completion_verdict: { choice: "complete", confidence: 0.96, probabilities: { complete: 0.96, rework: 0.04 } },
	};

	it("a bug-fix objective passes isBugFix into the inner completion transaction", async () => {
		const { seenBugFix, result } = await deliver({
			objectiveId: "bug-obj",
			profile: "system_one_required",
			steeringMode: "system_one_required",
		});
		expect(seenBugFix()).toBe(true);
		expect(result?.status).toBe("complete");
	});

	it("JEV-025 requires the completion policy hard pass, not a 0.5 noul", () => {
		const weak = plane.evaluateSemanticOutcome(
			"JEV-025",
			{ ...strong, implementation_matches_goal: { noul: 0.9 } },
			directive,
		);
		expect(weak.semantic_outcome).toBe("repair");
		expect(weak.failed_semantic_predicates).toContain("implementation_matches_goal");
		expect(plane.evaluateSemanticOutcome("JEV-025", strong, directive).semantic_outcome).toBe("pass");
		const bug = plane.evaluateSemanticOutcome("JEV-025", strong, directive, { bugFix: true });
		expect(bug.failed_semantic_predicates).toContain("root_cause_addressed");
	});

	it("JEV-026 requires a confident no on the challenge pack", () => {
		const passed = plane.evaluateSemanticOutcome(
			"JEV-026",
			{
				missing_requirement: { noul: 0.05 },
				hidden_assumption: { noul: 0.05 },
				plausible_regression_not_tested: { noul: 0.05 },
				conclusion_overstates_evidence: { noul: 0.05 },
			},
			directive,
		);
		expect(passed.semantic_outcome).toBe("pass");
		const challenged = plane.evaluateSemanticOutcome(
			"JEV-026",
			{
				missing_requirement: { noul: 0.2 },
				hidden_assumption: { noul: 0.05 },
				plausible_regression_not_tested: { noul: 0.05 },
				conclusion_overstates_evidence: { noul: 0.05 },
			},
			directive,
		);
		expect(challenged.failed_semantic_predicates).toContain("missing_requirement");
	});

	it("names bug and bugfix, and does not treat debug as a bug fix", () => {
		expect(requestsBugFix("bug-obj", "t")).toBe(true);
		expect(requestsBugFix("obj", "fix the bugs")).toBe(true);
		expect(requestsBugFix("obj", "bugfix the parser")).toBe(true);
		expect(requestsBugFix("debug-obj", "run the debugger")).toBe(false);
		expect(requestsBugFix("obj", "debugging notes")).toBe(false);
	});

	it("binds npm publish only for a public package and does not promote a deploy script", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-release-"));
		expect(createRepoReleaseDelivery(root)).toBeUndefined();
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", private: true }));
		expect(createRepoReleaseDelivery(root)).toBeUndefined();
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
		expect(createRepoReleaseDelivery(root)?.publish).toBeUndefined();
		const publishOnly = createRepoReleaseDelivery(root, {
			packageIntent: { packageName: "pkg", version: "1.0.0", registry: "https://registry.example.test" },
		});
		expect(typeof publishOnly?.publish).toBe("function");
		expect(typeof publishOnly?.provePublish).toBe("function");
		expect(publishOnly?.deploy).toBeUndefined();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "pkg",
				version: "1.0.0",
				private: true,
				scripts: { deploy: "node danger.js", "deploy:status": "node status.js" },
			}),
		);
		expect(createRepoReleaseDelivery(root)?.deploy).toBeUndefined();
		expect(createRepoReleaseDelivery(root)?.publish).toBeUndefined();
		const trusted = createRepoReleaseDelivery(root, {
			adapters: [
				{
					id: "trusted-staging",
					targets: ["staging"],
					deploy: async () => ({ id: "claimed" }),
					observe: async () => ({ deploymentId: "observed" }),
				},
			],
		});
		await expect(trusted?.deploy?.("staging")).resolves.toEqual({ id: "claimed" });
		await expect(trusted?.proveDeploy?.("staging")).resolves.toEqual({
			target: "staging",
			deploymentId: "observed",
		});
	});
});
