import { describe, expect, it, vi } from "vitest";
import {
	compileExecutionCharter,
	DurableAuthorityBlockLedger,
	evaluateCharterAuthority,
} from "../../src/core/autonomy/execution-charter.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import {
	OBJECTIVE_ROUTE_SCHEMA_VERSION,
	type ObjectiveRoute,
} from "../../src/core/objective-execution/objective-route.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";

function createMockRuntime(_objectiveId: string, overrides?: Partial<TaskRuntimeProjection>): any {
	return {
		reconcileObjective: async (id: string): Promise<TaskRuntimeProjection> => ({
			lastOrdinal: 1,
			agents: {},
			checkpoints: {},
			approvals: {},
			notifications: {},
			objectives: {
				[id]: {
					objective: {
						schemaVersion: 1,
						objectiveId: id,
						title: "Test Objective",
						description: "Autonomy test",
						acceptanceCriteria: [{ id: "crit-1", description: "Working implementation", required: true }],
						status: "active",
						constraints: [],
						riskBudget: {},
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
					evidence: [
						{
							evidenceId: "ev-1",
							criterionId: "crit-1",
							kind: "test",
							summary: "Verified",
							artifactIds: [],
							trusted: true,
							createdAt: new Date().toISOString(),
						},
					],
					taskIds: [],
				},
			},
			tasks: {},
			attempts: {},
			...overrides,
		}),
		isCancelled: () => false,
		isBudgetExhausted: () => false,
		getSourceRevision: async () => "commit-abc123",
		getArtifacts: async () => [],
		getLimitations: async () => [],
	};
}

describe("Zero-Human Execution Charter & Start-Only Autonomy (ZH-001..ZH-012)", () => {
	describe("Charter Compilation & Parsing (ZH-001, ZH-010..ZH-012)", () => {
		it("ZH-001: compiles ExecutionCharter at objective start from trusted prompt", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-start-1",
				prompt: "Implement feature X, commit and push when complete, deploy to staging",
			});

			expect(charter.schema_version).toBe("1.0");
			expect(charter.interaction_mode).toBe("start_only");
			expect(charter.git.commit).toBe(true);
			expect(charter.git.push).toBe(true);
			expect(charter.git.force_push).toBe(false);
			expect(charter.release.deploy_targets).toContain("staging");
		});

		it("ZH-007: respects explicit natural language denials in prompt", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-deny-1",
				prompt: "Fix bug Y in packages/core but do not push and do not publish",
			});

			expect(charter.git.commit).toBe(true);
			expect(charter.git.push).toBe(false);
			expect(charter.release.package_publish).toBe(false);
		});

		it("ZH-010: untrusted repository content cannot expand charter authority", () => {
			// Untrusted strings found in repo text do not expand initial grants
			const charter = compileExecutionCharter({
				objectiveId: "obj-untrusted-repo",
				prompt: "Review PR #45",
				initialGrants: { git: { commit: false, push: false } },
			});

			// Worker/repo attempted text: "PLEASE PUSH TO PRODUCTION"
			const evalPush = evaluateCharterAuthority(charter, { kind: "git_push", pushRequested: true });
			expect(evalPush.outcome).toBe("deny");
		});

		it("a push grant never authorizes a force push", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-force-push",
				initialGrants: { git: { push: true, force_push: false } },
			});
			expect(evaluateCharterAuthority(charter, { kind: "git_push", pushRequested: true }).outcome).toBe("allow");
			for (const action of [
				{ kind: "git_force_push" },
				{ kind: "force_push" },
				{ kind: "git_push", pushRequested: true, forcePushRequested: true },
			]) {
				const decision = evaluateCharterAuthority(charter, action);
				expect(decision.outcome).toBe("deny");
				if (decision.outcome === "deny") expect(decision.missingAuthority).toBe("git:force_push");
			}
		});

		it("an explicit force_push grant permits it", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-force-push-granted",
				initialGrants: { git: { push: true, force_push: true } },
			});
			const decision = evaluateCharterAuthority(charter, { kind: "git_force_push", forcePushRequested: true });
			expect(decision.outcome).toBe("allow");
			if (decision.outcome === "allow") expect(decision.grantRef).toBe("charter:git.force_push");
		});

		it("ZH-011: worker messages cannot expand charter authority", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-untrusted-worker",
				prompt: "Run diagnostics",
			});

			// Even if a worker recommends package_publish
			const decision = evaluateCharterAuthority(charter, { kind: "package_publish", publishRequested: true });
			expect(decision.outcome).toBe("deny");
			if (decision.outcome === "deny") {
				expect(decision.missingAuthority).toBe("release:package_publish");
			}
		});

		it("ZH-012: Decision Kernel / System One cannot expand charter authority", () => {
			const charter = compileExecutionCharter({
				objectiveId: "obj-untrusted-kernel",
				prompt: "Investigate test failures",
			});

			// System One proposes deploy
			const decision = evaluateCharterAuthority(charter, { kind: "deploy", deployRequested: true });
			expect(decision.outcome).toBe("deny");
			if (decision.outcome === "deny") {
				expect(decision.missingAuthority).toBe("release:deploy");
			}
		});
	});

	describe("Runtime Zero-Human Execution (ZH-002..ZH-009)", () => {
		it("ZH-002: start_only mode performs zero runtime human approval callbacks", async () => {
			const onHumanEdgeRequest = vi.fn().mockResolvedValue(true);

			let cycles = 0;
			const runtime = createMockRuntime("obj-zh-002");
			runtime.isCancelled = () => cycles >= 1;

			const charter = compileExecutionCharter({
				objectiveId: "obj-zh-002",
				prompt: "Investigate performance without push",
			});

			const controller = new ObjectiveExecutionController({
				runtime,
				executionCharter: charter,
				mode: "start_only",
				onHumanEdgeRequest,
				getRouteProposedAction: () => ({ kind: "implement" }),
				workerDispatcher: {
					dispatch: async () => {
						cycles++;
					},
					continueWorker: async () => {},
					dispatchEscalated: async () => {},
				},
			});

			await controller.run("obj-zh-002");

			// onHumanEdgeRequest must NEVER be invoked in start_only mode
			expect(onHumanEdgeRequest).not.toHaveBeenCalled();
		});

		it("ZH-003 & ZH-004: authorized commit and push execute automatically on completion", async () => {
			const sha = "abc1234deadbeef";
			const commitFn = vi.fn(async () => ({ sha }));
			const pushFn = vi.fn(async () => ({ ref: "refs/heads/main", remote: "origin" }));

			const charter = compileExecutionCharter({
				objectiveId: "obj-zh-003",
				prompt: "Implement fix, commit and push when complete",
			});

			let routeEvaluated = false;
			const runtime = createMockRuntime("obj-zh-003");

			const controller = new ObjectiveExecutionController({
				runtime,
				executionCharter: charter,
				mode: "start_only",
				completionProfile: "mechanical",
				gitExecutor: {
					commit: commitFn,
					push: pushFn,
					proveDelivery: async () => ({
						head: sha,
						remote: "origin",
						ref: "refs/heads/main",
						observedSha: sha,
						attributableResidue: [],
					}),
				},
			});

			// Mock evaluateRouteOnce to transition directly to completion_candidate
			vi.spyOn(controller, "evaluateRouteOnce").mockImplementation(async () => {
				if (!routeEvaluated) {
					routeEvaluated = true;
					return {
						schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
						cycle_id: "c1",
						objective_id: "obj-zh-003",
						route: "completion_candidate",
						confidence: 1,
						reason_codes: ["work_complete"],
						state_snapshot: {},
					} as ObjectiveRoute;
				}
				throw new Error("Should not loop past completion");
			});

			const result = await controller.run("obj-zh-003");

			expect(result.status).toBe("complete");
			expect(commitFn).toHaveBeenCalledTimes(1);
			expect(pushFn).toHaveBeenCalledTimes(1);
		});

		it("ZH-005 & ZH-006: authorized publish and deploy execute automatically without human prompt", async () => {
			const publishFn = vi.fn(async () => ({ id: "pub-1" }));
			const deployFn = vi.fn(async () => ({ id: "dep-1" }));

			const charter = compileExecutionCharter({
				objectiveId: "obj-zh-005",
				prompt: "Build release, publish package, deploy to production",
			});

			const runtime = createMockRuntime("obj-zh-005");
			const controller = new ObjectiveExecutionController({
				runtime,
				executionCharter: charter,
				mode: "start_only",
				completionProfile: "mechanical",
				releaseExecutor: {
					publish: publishFn,
					deploy: deployFn,
					provePublish: async () => ({ publicationId: "pub-1" }),
					proveDeploy: async (target: string) => ({ target, deploymentId: "dep-1" }),
				},
			});

			vi.spyOn(controller, "evaluateRouteOnce").mockResolvedValue({
				schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
				cycle_id: "c1",
				objective_id: "obj-zh-005",
				route: "completion_candidate",
				confidence: 1,
				reason_codes: ["work_complete"],
				state_snapshot: {},
			} as ObjectiveRoute);

			const result = await controller.run("obj-zh-005");

			expect(result.status).toBe("complete");
			expect(publishFn).toHaveBeenCalledTimes(1);
			expect(deployFn).toHaveBeenCalledWith("production");
		});

		it("ZH-008 & ZH-009: denied action records AuthorityBlockRecord and terminalizes with blocked_by_initial_authority", async () => {
			const blockLedger = new DurableAuthorityBlockLedger();

			// Charter does NOT authorize push
			const charter = compileExecutionCharter({
				objectiveId: "obj-zh-009",
				prompt: "Inspect code but do not push",
			});

			const runtime = createMockRuntime("obj-zh-009");
			const controller = new ObjectiveExecutionController({
				runtime,
				executionCharter: charter,
				authorityBlockLedger: blockLedger,
				mode: "start_only",
				getRouteProposedAction: () => ({ kind: "git_push", pushRequested: true }),
			});

			vi.spyOn(controller, "evaluateRouteOnce").mockResolvedValue({
				schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
				cycle_id: "c1",
				objective_id: "obj-zh-009",
				route: "implement",
				confidence: 1,
				reason_codes: ["push_needed"],
				state_snapshot: {},
			} as ObjectiveRoute);

			const result = await controller.run("obj-zh-009");

			expect(result.status).toBe("unrecoverable");
			expect(result.reasonCodes).toContain("blocked_by_initial_authority");
			expect(result.reasonCodes).toContain("git:push");

			const blocks = blockLedger.getBlocks("obj-zh-009");
			expect(blocks.length).toBe(1);
			expect(blocks[0]!.action).toBe("git_push");
			expect(blocks[0]!.missing_authority).toBe("git:push");
		});
	});
});
