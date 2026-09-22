import { execFileSync } from "node:child_process";

for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
	delete process.env[key];
}

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { classifyDangerousGitBash } from "../../src/core/objective-execution/dangerous-git-bash.ts";
import {
	createRepoGitDelivery,
	proveCommitAndPush,
	proveDeployReceipt,
} from "../../src/core/objective-execution/delivery-proof.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import {
	createRepoReleaseDelivery,
	type TrustedDeployAdapter,
} from "../../src/core/objective-execution/release-delivery.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { IntegrityHookCoordinator } from "../../src/core/system-one/integrity-hooks.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";
import { createTestResourceLoader } from "../utilities.ts";

const agentDirs: string[] = [];

afterEach(() => {
	while (agentDirs.length > 0) {
		const agentDir = agentDirs.pop();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	}
});

function gitRepo(): string {
	const root = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-oc-"));
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

function head(root: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function track(root: string, bare: string): string {
	execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
	const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["config", `branch.${branch}.remote`, "origin"], { cwd: root });
	execFileSync("git", ["config", `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd: root });
	return branch;
}

function runtime(objectiveId: string): TaskRuntimeProjection {
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

function certificate(checkpoint: string) {
	return {
		certificate_id: `c-${checkpoint}`,
		semantic_outcome: "pass",
		answers: {
			work_remaining: { boolean: false },
			missing_work_class: { choice: "none" },
		},
		directive: checkpoint === "JEV-024" ? "completion_candidate" : "allow",
		failed_semantic_predicates: undefined,
	};
}

describe("delivery authority operational closure", () => {
	it("refuses broad and destructive git in root bash and keeps ordinary commands", () => {
		for (const command of [
			"git add -A",
			"git add --all",
			"git add .",
			"git add -u",
			"git commit -a",
			"git commit -am msg",
			"git commit --no-verify",
			"git stash",
			"git reset --hard",
			"git clean -fd",
			"git clean -xdf",
			"git checkout .",
			"git restore .",
			"git push --force origin main",
			"git push origin refs/tags/v1.2.3",
			"npm test && git add -A",
		]) {
			expect(classifyDangerousGitBash(command).refused, command).toBe(true);
		}
		expect(classifyDangerousGitBash("npm test && npm run lint").refused).toBe(false);
		expect(classifyDangerousGitBash("git add README.md").refused).toBe(false);
		expect(classifyDangerousGitBash('git commit -m "wip"').refused).toBe(false);
		expect(classifyDangerousGitBash("git status && git diff").readOnly).toBe(true);
		expect(classifyDangerousGitBash("echo hi").readOnly).toBe(false);
	});

	it("blocks git add -A in the root tool gate before the command runs", async () => {
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/tmp",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
		});
		const blocked = await gate.beforeToolCall(
			{
				toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "git add -A" } },
				args: { command: "git add -A" },
				assistantMessage: {} as never,
				context: {} as never,
			},
			undefined,
		);
		expect(blocked?.block).toBe(true);
	});

	it("does not grant branch push for push tag, and does grant it when branch push is separate", () => {
		const tagOnly = compileExecutionCharter({ objectiveId: "obj", prompt: "push tag v1.2.3" });
		expect(tagOnly.git.push).toBe(false);
		expect(tagOnly.git.create_tag).toBe(true);
		expect(tagOnly.delivery.git.tag).toMatchObject({ name: "v1.2.3", push: true });
		expect(tagOnly.delivery.git.push).toBe(false);
		const created = compileExecutionCharter({ objectiveId: "obj", prompt: "create and push tag v1.2.3" });
		expect(created.git.push).toBe(false);
		expect(created.delivery.git.tag).toMatchObject({ name: "v1.2.3", push: true });
		const both = compileExecutionCharter({
			objectiveId: "obj",
			prompt: "commit and push, and push tag v1.2.3",
			initialGrants: { git: { push_remote: "origin", push_ref: "refs/heads/main" } },
		});
		expect(both.git.push).toBe(true);
		expect(both.git.commit).toBe(true);
		expect(both.delivery.git.tag).toMatchObject({ name: "v1.2.3", push: true, remote: "origin" });
	});

	it("fails a clean push-only delivery when HEAD is no longer the semantic candidate", () => {
		const pushed = proveCommitAndPush({
			commitRequired: false,
			pushRequired: true,
			reportedPushRef: "refs/heads/main",
			reportedPushRemote: "origin",
			candidateRevision: "head-a",
			observation: {
				head: "head-b",
				parent: "head-a",
				tree: "tree",
				remote: "origin",
				ref: "refs/heads/main",
				observedSha: "head-b",
				attributableResidue: [],
			},
		});
		expect(pushed.push?.state).toBe("failed");
		if (pushed.push?.state === "failed") expect(pushed.push.error).toBe("stale_candidate");
	});

	it("blocks automatic commit after an unattributed shell command or a drifted owned file", () => {
		const root = gitRepo();
		const ledger = new ObjectiveMutationLedger();
		ledger.bindObjective("obj");
		writeFileSync(join(root, "README.md"), "two\n");
		ledger.recordOwnedWrite("obj", root, "README.md");
		expect(ledger.provenOwnedPaths("obj")).toEqual(["README.md"]);
		writeFileSync(join(root, "README.md"), "three\n");
		ledger.reconcile("obj", root);
		expect(ledger.deliveryBlockReason("obj")).toBe("ownership_drift");
		expect(ledger.provenOwnedPaths("obj")).toEqual([]);

		const shell = new ObjectiveMutationLedger();
		shell.recordOwnedWrite("obj", root, "README.md");
		shell.markShellUnsafe("obj");
		expect(shell.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		expect(shell.provenOwnedPaths("obj")).toEqual([]);
	});

	it("does not publish from a public manifest unless the charter intent matches, and freezes the tarball", async () => {
		const root = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-oc-pkg-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
		writeFileSync(join(root, "index.js"), "module.exports = 1;\n");
		expect(createRepoReleaseDelivery(root)).toBeUndefined();
		const delivery = createRepoReleaseDelivery(root, {
			packageIntent: { packageName: "pkg", version: "1.0.0", registry: "https://registry.example.test" },
		});
		const first = await delivery?.preparePublish?.();
		writeFileSync(join(root, "index.js"), "module.exports = 2;\n");
		const second = await delivery?.preparePublish?.();
		expect(second?.integrity).toBe(first?.integrity);
		expect(first?.integrity.startsWith("sha512-")).toBe(true);
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "2.0.0" }));
		await expect(delivery?.publish?.()).rejects.toThrow("package_identity_mismatch");
	});

	it("fails deploy proof when the observed revision is not the candidate", () => {
		const receipt = proveDeployReceipt({
			target: "staging",
			reportedId: "dep-1",
			expectedRevision: "sha-a",
			observation: { target: "staging", deploymentId: "dep-1", deployedRevision: "sha-b" },
		});
		expect(receipt.state).toBe("failed");
		if (receipt.state === "failed") expect(receipt.error).toBe("deploy_revision_mismatch");
		const missing = createRepoReleaseDelivery(gitRepo(), {
			adapters: [
				{
					id: "native",
					targets: ["staging"],
					deploy: async () => ({ id: "dep-1" }),
					observe: async () => ({ deploymentId: "dep-1", deployedRevision: "other" }),
				} satisfies TrustedDeployAdapter,
			],
		});
		expect(missing?.deploy).toBeTypeOf("function");
	});

	it("refuses a completion hook that asks to mutate after the candidate is frozen", async () => {
		const store = new ExecutionStore({
			run_id: "run-hook",
			objective: {
				request: "do it",
				normalized_goal: "do it",
				acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
			},
			repo: { root: "/workspace", baseline_revision: "r0" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["c1"] });
		let impact = "";
		const hooks = new IntegrityHookCoordinator([
			{
				id: "mutator",
				onHook: async (hook, context) => {
					if (hook === "completion_candidate") impact = context.impact;
					return { decision: "allow", reasonCodes: ["mutation_requested"], validationRefs: [] };
				},
			},
		]);
		const systemOne = new SystemOneController({
			store,
			adapter: {
				provenance: "native_calibrated",
				evaluate: async () => ({
					model: "m",
					answers: {
						implementation_matches_goal: { noul: 0.99 },
						root_cause_addressed: { noul: 0.99 },
						required_behavior_unverified: { noul: 0.01 },
						material_claim_unsupported: { noul: 0.01 },
						out_of_scope_change_present: { noul: 0.01 },
						duplicate_responsibility_introduced: { noul: 0.01 },
						missing_requirement: { noul: 0.01 },
						hidden_assumption: { noul: 0.01 },
						plausible_regression_not_tested: { noul: 0.01 },
						conclusion_overstates_evidence: { noul: 0.01 },
						completion_verdict: {
							choice: "complete",
							confidence: 0.99,
							probabilities: { complete: 0.99, rework: 0.01 },
						},
					},
					latency_ms: 1,
				}),
			},
			hookCoordinator: hooks,
		});
		const verdict = await systemOne.executeCompletionTransaction(false);
		expect(impact).toBe("read_only");
		expect(verdict.verdict).not.toBe("complete");
	});

	it("commits the frozen tree through the session binding and does not approve a later edit", async () => {
		const root = gitRepo();
		const bare = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-oc-remote-"));
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		const branch = track(root, bare);
		const admitted = head(root);
		const objectiveId = "obj-live";
		const agentDir = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-oc-agent-"));
		agentDirs.push(agentDir);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(root),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			cwd: root,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});
		const seen: string[] = [];
		const charter = compileExecutionCharter({
			objectiveId,
			prompt: "commit and push when done",
			admission: {
				upstream: { remote: "origin", ref: `refs/heads/${branch}` },
				baselineDirty: false,
				detached: false,
			},
		});
		const store = new ExecutionStore({
			run_id: "run-live",
			objective: { request: "ship", normalized_goal: "ship", acceptance_criteria: [] },
			repo: { root, baseline_revision: admitted },
		});
		const systemOne = new SystemOneController({
			store,
			adapter: {
				provenance: "native_calibrated",
				evaluate: async () => ({ model: "m", answers: {}, latency_ms: 1 }),
			},
		});
		const controller = new ObjectiveExecutionController({
			mode: "start_only",
			executionCharter: charter,
			repoRoot: root,
			runtime: { reconcileObjective: async () => runtime(objectiveId) },
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string, state: unknown) => {
					seen.push(checkpoint);
					if (checkpoint === "JEV-024") {
						const candidate = (state as { deliveryCandidate?: { approvedTreeOid?: string } }).deliveryCandidate;
						expect(candidate?.approvedTreeOid).toBeTruthy();
					}
					return certificate(checkpoint);
				},
			} as never,
			systemOne: {
				adapter: { provenance: "native_calibrated" },
				executeCompletionTransaction: async () => ({ verdict: "complete", failed_gates: [] }) as never,
				commitTerminalCompletion: (proof, options) => systemOne.commitTerminalCompletion(proof, options),
			},
		});
		session.attachAdaptiveRuntime({ charter, objectiveController: controller });
		writeFileSync(join(root, "README.md"), "owned\n");
		const afterToolCall = session.agent.afterToolCall;
		if (!afterToolCall) throw new Error("session tool gate is not installed");
		await afterToolCall({
			toolCall: { type: "toolCall", id: "w1", name: "write", arguments: { path: "README.md" } },
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "wrote" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		const result = await controller.run(objectiveId);
		expect(result.status).toBe("complete");
		expect(seen).toContain("JEV-024");
		expect(seen.indexOf("JEV-024")).toBeLessThan(seen.indexOf("JEV-027"));
		expect(store.phase).toBe("complete");
		const committed = head(root);
		expect(committed).not.toBe(admitted);
		expect(execFileSync("git", ["show", "--stat", "--oneline", "HEAD"], { cwd: root, encoding: "utf8" })).toContain(
			"README.md",
		);
		expect(execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: bare, encoding: "utf8" }).trim()).toBe(
			committed,
		);
		expect(readFileSync(join(root, "README.md"), "utf8")).toBe("owned\n");
		await session.disposeAndWait();

		const driftRoot = gitRepo();
		const driftAdmitted = head(driftRoot);
		const driftController = new ObjectiveExecutionController({
			mode: "start_only",
			executionCharter: compileExecutionCharter({ objectiveId: "obj-drift", prompt: "commit when done" }),
			repoRoot: driftRoot,
			runtime: { reconcileObjective: async () => runtime("obj-drift") },
			attributedMutationPaths: () => ["README.md"],
			gitExecutor: createRepoGitDelivery(driftRoot),
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string) => {
					if (checkpoint === "JEV-024") writeFileSync(join(driftRoot, "README.md"), "after-freeze\n");
					return certificate(checkpoint);
				},
			} as never,
			systemOne: {
				adapter: { provenance: "native_calibrated" },
				executeCompletionTransaction: async () => ({ verdict: "complete", failed_gates: [] }) as never,
			},
		});
		writeFileSync(join(driftRoot, "README.md"), "before-freeze\n");
		const drifted = await driftController.run("obj-drift");
		expect(drifted.status).not.toBe("complete");
		expect(head(driftRoot)).toBe(driftAdmitted);
	});
});
