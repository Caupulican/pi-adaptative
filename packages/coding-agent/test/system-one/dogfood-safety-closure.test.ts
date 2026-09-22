import { execFileSync } from "node:child_process";
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
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import { captureRepoDeliveryFingerprint } from "../../src/core/objective-execution/repo-delivery-fingerprint.ts";
import { RepositoryMutationObserver } from "../../src/core/objective-execution/repository-mutation-observer.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";
import { createTestResourceLoader } from "../utilities.ts";

for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
	delete process.env[key];
}

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const path = cleanups.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const path = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
	cleanups.push(path);
	return path;
}

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitRepo(): string {
	const root = tempDir("pi-df-");
	git(root, ["init"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	git(root, ["config", "tag.gpgsign", "false"]);
	writeFileSync(join(root, ".gitignore"), "*.log\n");
	writeFileSync(join(root, "README.md"), "one\n");
	git(root, ["add", ".gitignore", "README.md"]);
	git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
	return root;
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

function gateFor(cwd: string): { gate: ToolGateController; observer: RepositoryMutationObserver } {
	const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
	const gate = new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => cwd,
		getCapabilityEnvelope: () => undefined,
		recordGateOutcome: () => undefined,
		getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
		repositoryObserver: observer,
		getObjectiveId: () => "obj",
		deliveryActive: () => true,
	});
	return { gate, observer };
}

async function settle(
	gate: ToolGateController,
	id: string,
	name: string,
	args: Record<string, unknown>,
	between: () => void,
): Promise<void> {
	const context = {
		toolCall: { type: "toolCall" as const, id, name, arguments: args },
		args,
		assistantMessage: { provider: "test", model: "test" } as never,
		context: {} as never,
	};
	await gate.beforeToolCall(context as Parameters<ToolGateController["beforeToolCall"]>[0], undefined);
	between();
	await gate.afterToolCall({
		...context,
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	} as Parameters<ToolGateController["afterToolCall"]>[0]);
}

describe("dogfood safety closure", () => {
	it("keeps lane WIP git quote-aware and does not ban ordinary git", () => {
		expect(classifyDangerousGitBash('git commit -m "wip"').refused).toBe(false);
		expect(classifyDangerousGitBash("git add README.md").refused).toBe(false);
		expect(classifyDangerousGitBash("git log").refused).toBe(false);
		expect(classifyDangerousGitBash("git push origin main").refused).toBe(true);
		expect(classifyDangerousGitBash('git commit "-a"').refused).toBe(true);
		expect(classifyDangerousGitBash("git commit '--no-verify'").refused).toBe(true);
		expect(classifyDangerousGitBash('git add "--all"').refused).toBe(true);
		expect(classifyDangerousGitBash('git commit "').refused).toBe(true);
	});

	it("fingerprints HEAD, index, tracked bytes, and untracked candidates, not ignored output", async () => {
		const root = gitRepo();
		const first = await captureRepoDeliveryFingerprint(root);
		const second = await captureRepoDeliveryFingerprint(root);
		expect(first.ok).toBe(true);
		expect(second).toEqual(first);
		writeFileSync(join(root, "noise.log"), "build\n");
		expect(await captureRepoDeliveryFingerprint(root)).toEqual(first);
		writeFileSync(join(root, "README.md"), "two\n");
		const tracked = await captureRepoDeliveryFingerprint(root);
		expect(tracked.ok && first.ok && tracked.digest !== first.digest).toBe(true);
		git(root, ["add", "README.md"]);
		const staged = await captureRepoDeliveryFingerprint(root);
		expect(staged.ok && tracked.ok && staged.digest !== tracked.digest).toBe(true);
		git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "next"]);
		const committed = await captureRepoDeliveryFingerprint(root);
		expect(committed.ok && staged.ok && committed.digest !== staged.digest).toBe(true);
		writeFileSync(join(root, "extra.txt"), "candidate\n");
		const untracked = await captureRepoDeliveryFingerprint(root);
		expect(untracked.ok && committed.ok && untracked.digest !== committed.digest).toBe(true);
		expect((await captureRepoDeliveryFingerprint(tempDir("pi-df-norepo-"))).ok).toBe(false);
	});

	it("marks shell unsafe only when the checkout fingerprint changes or cannot be read", async () => {
		const root = gitRepo();
		const clean = gateFor(root);
		await settle(clean.gate, "npm", "bash", { command: "npm test" }, () => undefined);
		await settle(clean.gate, "cargo", "bash", { command: "cargo check" }, () => undefined);
		await settle(clean.gate, "proc", "run_process", { executable: "npm", args: ["test"] }, () => undefined);
		expect(clean.observer.deliveryBlockReason("obj")).toBeUndefined();
		const tracked = gateFor(root);
		await settle(tracked.gate, "edit", "bash", { command: "npm test" }, () => {
			writeFileSync(join(root, "README.md"), "changed\n");
		});
		expect(tracked.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const created = gateFor(root);
		await settle(created.gate, "new", "bash", { command: "npm test" }, () => {
			writeFileSync(join(root, "extra.txt"), "x\n");
		});
		expect(created.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const indexed = gateFor(root);
		await settle(indexed.gate, "idx", "run_process", { executable: "git", args: ["add", "README.md"] }, () => {
			git(root, ["add", "README.md"]);
		});
		expect(indexed.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const moved = gateFor(root);
		await settle(moved.gate, "head", "bash", { command: "true" }, () => {
			git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "moved"]);
		});
		expect(moved.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const ignored = gateFor(root);
		await settle(ignored.gate, "log", "bash", { command: "npm test" }, () => {
			writeFileSync(join(root, "out.log"), "log\n");
		});
		expect(ignored.observer.deliveryBlockReason("obj")).toBeUndefined();
		const blind = gateFor(tempDir("pi-df-norepo-"));
		await settle(blind.gate, "bad", "bash", { command: "npm test" }, () => undefined);
		expect(blind.observer.deliveryBlockReason("obj")).toBe("repository_fingerprint_unavailable");
		const read = gateFor(root);
		await settle(read.gate, "status", "bash", { command: "git status" }, () => undefined);
		expect(read.observer.deliveryBlockReason("obj")).toBeUndefined();
		await settle(read.gate, "commit", "bash", { command: "git commit -m x -- README.md" }, () => undefined);
		expect(read.observer.deliveryBlockReason("obj")).toBeUndefined();
	});

	it("commits the owned file after a harmless test and rejects a bash write at delivery", async () => {
		const fixOnly = compileExecutionCharter({
			objectiveId: "fix-only",
			prompt: "fix the file, run the targeted test",
		});
		expect(fixOnly.git.commit).toBe(false);
		expect(fixOnly.git.push).toBe(false);

		const root = gitRepo();
		const bare = tempDir("pi-df-remote-");
		execFileSync("git", ["init", "--bare"], { cwd: bare });
		execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
		const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
		git(root, ["config", `branch.${branch}.remote`, "origin"]);
		git(root, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
		const admitted = git(root, ["rev-parse", "HEAD"]);
		const objectiveId = "obj-dogfood";
		const agentDir = tempDir("pi-df-agent-");
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
		const prompt = "fix the file, run the targeted test, commit and push when complete";
		const charter = compileExecutionCharter({
			objectiveId,
			prompt,
			admission: {
				upstream: { remote: "origin", ref: `refs/heads/${branch}` },
				baselineDirty: false,
				detached: false,
			},
		});
		expect(charter.git.commit).toBe(true);
		expect(charter.git.push).toBe(true);
		const store = new ExecutionStore({
			run_id: "run-dogfood",
			objective: { request: prompt, normalized_goal: prompt, acceptance_criteria: [] },
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
		const beforeToolCall = session.agent.beforeToolCall;
		const afterToolCall = session.agent.afterToolCall;
		if (!beforeToolCall || !afterToolCall) throw new Error("session tool gate is not installed");
		const gitCommit = "git commit -m x -- README.md";
		const admittedGit = await beforeToolCall(
			{
				toolCall: {
					type: "toolCall",
					id: "git1",
					name: "bash",
					arguments: { command: gitCommit },
				},
				args: { command: gitCommit },
				assistantMessage: { provider: "test", model: "test" } as never,
				context: {} as never,
			} as Parameters<typeof beforeToolCall>[0],
			undefined,
		);
		expect(admittedGit?.block).toBeUndefined();
		await afterToolCall({
			toolCall: { type: "toolCall", id: "git1", name: "bash", arguments: { command: gitCommit } },
			args: { command: gitCommit },
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		expect(git(root, ["rev-parse", "HEAD"])).toBe(admitted);

		writeFileSync(join(root, "README.md"), "fixed\n");
		await afterToolCall({
			toolCall: { type: "toolCall", id: "w1", name: "write", arguments: { path: "README.md" } },
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "wrote" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		const testCommand =
			"node -e \"process.exit(require('node:fs').readFileSync('README.md','utf8')==='fixed\\n'?0:1)\"";
		await beforeToolCall(
			{
				toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: testCommand } },
				args: { command: testCommand },
				assistantMessage: { provider: "test", model: "test" } as never,
				context: {} as never,
			} as Parameters<typeof beforeToolCall>[0],
			undefined,
		);
		execFileSync(
			"node",
			["-e", "process.exit(require('node:fs').readFileSync('README.md','utf8')==='fixed\\n'?0:1)"],
			{
				cwd: root,
			},
		);
		await afterToolCall({
			toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: testCommand } },
			args: { command: testCommand },
			result: { content: [{ type: "text", text: "passed" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		const result = await controller.run(objectiveId);
		expect(result.status).toBe("complete");
		expect(seen.indexOf("JEV-024")).toBeGreaterThanOrEqual(0);
		expect(seen.indexOf("JEV-024")).toBeLessThan(seen.indexOf("JEV-027"));
		expect(store.phase).toBe("complete");
		const committed = git(root, ["rev-parse", "HEAD"]);
		expect(committed).not.toBe(admitted);
		const stat = git(root, ["show", "--stat", "--oneline", "HEAD"]);
		expect(stat).toContain("README.md");
		expect(stat).not.toContain("other.txt");
		expect(git(bare, ["rev-parse", `refs/heads/${branch}`])).toBe(committed);
		expect(readFileSync(join(root, "README.md"), "utf8")).toBe("fixed\n");
		await session.disposeAndWait();

		const dirtyRoot = gitRepo();
		const dirtyAdmitted = git(dirtyRoot, ["rev-parse", "HEAD"]);
		const dirtyObjective = "obj-dogfood-dirty";
		const dirtyAgent = tempDir("pi-df-agent-");
		const dirtyAgentModel = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
		});
		const dirtySession = new AgentSession({
			agent: dirtyAgentModel,
			sessionManager: SessionManager.inMemory(dirtyRoot),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			cwd: dirtyRoot,
			agentDir: dirtyAgent,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});
		const dirtyCharter = compileExecutionCharter({
			objectiveId: dirtyObjective,
			prompt,
			admission: { upstream: null, baselineDirty: false, detached: true },
		});
		const dirtyController = new ObjectiveExecutionController({
			mode: "start_only",
			executionCharter: dirtyCharter,
			repoRoot: dirtyRoot,
			runtime: { reconcileObjective: async () => runtime(dirtyObjective) },
			steeringPlane: {
				policy: { mode: "system_one_optional" },
				requireCertificate: async (checkpoint: string) => certificate(checkpoint),
			} as never,
			systemOne: {
				adapter: { provenance: "native_calibrated" },
				executeCompletionTransaction: async () => ({ verdict: "complete", failed_gates: [] }) as never,
			},
		});
		dirtySession.attachAdaptiveRuntime({ charter: dirtyCharter, objectiveController: dirtyController });
		const dirtyBefore = dirtySession.agent.beforeToolCall;
		const dirtyAfter = dirtySession.agent.afterToolCall;
		if (!dirtyBefore || !dirtyAfter) throw new Error("session tool gate is not installed");
		writeFileSync(join(dirtyRoot, "README.md"), "fixed\n");
		await dirtyAfter({
			toolCall: { type: "toolCall", id: "w2", name: "write", arguments: { path: "README.md" } },
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "wrote" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		const mutate = "printf x > other.txt";
		await dirtyBefore(
			{
				toolCall: { type: "toolCall", id: "b2", name: "bash", arguments: { command: mutate } },
				args: { command: mutate },
				assistantMessage: { provider: "test", model: "test" } as never,
				context: {} as never,
			} as Parameters<typeof dirtyBefore>[0],
			undefined,
		);
		execFileSync("bash", ["-lc", mutate], { cwd: dirtyRoot });
		await dirtyAfter({
			toolCall: { type: "toolCall", id: "b2", name: "bash", arguments: { command: mutate } },
			args: { command: mutate },
			result: { content: [{ type: "text", text: "wrote" }], details: {} },
			isError: false,
			assistantMessage: {} as never,
			context: {} as never,
		});
		const refusedDelivery = await dirtyController.run(dirtyObjective);
		expect(refusedDelivery.status).toBe("unrecoverable");
		expect(refusedDelivery.reasonCodes).toContain("shell_mutation_unattributed");
		expect(git(dirtyRoot, ["rev-parse", "HEAD"])).toBe(dirtyAdmitted);
		expect(git(dirtyRoot, ["status", "--porcelain"])).toContain("other.txt");
		await dirtySession.disposeAndWait();
	});
});
