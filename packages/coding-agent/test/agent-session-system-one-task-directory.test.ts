import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { registerFauxProvider } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { projectCanonicalTruth } from "../src/core/system-one/canonical-truth.ts";
import { SystemOneController } from "../src/core/system-one/controller.ts";
import { ExecutionStore } from "../src/core/system-one/execution-state.ts";
import { committedRepo } from "./git-fixture.ts";
import { createHarness } from "./suite/harness.ts";

describe("System One task-directory projection", () => {
	it("keeps task-directory repair available without a System One controller", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory"],
			settings: { modelCapability: { mode: "off" } },
		});
		const missing = join(harness.tempDir, "workspace");
		const repaired = join(harness.tempDir, "workspace-repaired");
		mkdirSync(missing);
		mkdirSync(repaired);
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "repair", path: missing })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "repair" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Workspace selected"),
			]);
			await harness.session.prompt("Select the repair fixture workspace.");
			rmSync(missing, { recursive: true, force: true });
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "reattach", workspaceId: "repair", path: repaired })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Workspace repaired"),
			]);
			await harness.session.prompt("Repair the selected task directory attachment.");
			const errors = harness.session.agent.state.messages.filter(
				(message) => message.role === "toolResult" && message.isError,
			);
			expect(errors).toEqual([]);
			expect(harness.sessionManager.getLatestCustomEntryOnBranch("task_directory_state")?.data).toMatchObject({
				selectedWorkspaceId: "repair",
				workspaces: expect.arrayContaining([expect.objectContaining({ workspaceId: "repair", root: repaired })]),
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("defers semantic evaluation on a missing attachment, then verifies after task repair", async () => {
		const evaluatedRoots: string[] = [];
		const store = new ExecutionStore({
			run_id: "missing-task-directory",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: "/startup", baseline_revision: "startup-revision" },
		});
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async (input) => {
					evaluatedRoots.push(`${store.getRepo().root}:${Object.keys(input.questions).join(",")}`);
					return { model: "jev-test", answers: {}, latency_ms: 0 };
				},
			},
		});
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory"],
			settings: { modelCapability: { mode: "off" } },
			systemOneController: controller,
		});
		const selected = join(harness.tempDir, "selected");
		const repaired = join(harness.tempDir, "repaired");
		mkdirSync(selected);
		mkdirSync(repaired);
		let goal: ReturnType<typeof createGoalState> | undefined;
		controller.setTruthSource(() =>
			projectCanonicalTruth({
				goal,
				currentRevision: "fixture-revision",
				repository: { root: harness.session.taskCwd, baseline_revision: "fixture-baseline" },
			}),
		);
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "project", path: selected })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "project" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Workspace selected"),
			]);
			await harness.session.prompt("Select the semantic task workspace.");
			goal = createGoalState({ goalId: "repair-scope", userGoal: "Verify after repair", now: "T0" });
			controller.syncCanonicalTruth();
			evaluatedRoots.length = 0;
			rmSync(selected, { recursive: true, force: true });
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "reattach", workspaceId: "project", path: repaired })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Attachment repaired"),
			]);
			await harness.session.prompt("Repair the active task attachment before semantic verification.");

			expect(evaluatedRoots.length).toBeGreaterThan(0);
			expect(
				evaluatedRoots.every((entry) => entry.startsWith(`${repaired}:`)),
				JSON.stringify(evaluatedRoots),
			).toBe(true);
			const warnings = harness.eventsOfType("warning").map((event) => event.message);
			expect(
				warnings.some((message) =>
					message.includes(
						"System One verification was deferred because the active task directory is unavailable",
					),
				),
			).toBe(true);
			expect(warnings.some((message) => message.includes("ENOENT"))).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("captures the pinned task repository during real foreground preflight and postflight", async () => {
		const startupRoot = committedRepo("system-one-startup");
		const taskRoot = committedRepo("system-one-task");
		const startupRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: startupRoot, encoding: "utf8" }).trim();
		const taskRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: taskRoot, encoding: "utf8" }).trim();
		const store = new ExecutionStore({
			run_id: "task-directory-projection",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: startupRoot, baseline_revision: startupRevision, current_revision: startupRevision },
		});
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-test", answers: {}, latency_ms: 0 }) },
		});
		const harness = await createHarness({
			cwd: startupRoot,
			initialActiveToolNames: ["task_directory", "task_steps", "systemone", "peer"],
			settings: { modelCapability: { mode: "off" } },
			systemOneController: controller,
		});
		let goal: ReturnType<typeof createGoalState> | undefined;
		controller.setTruthSource(() => {
			const cwd = harness.session.taskCwd;
			const currentRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			return projectCanonicalTruth({
				goal,
				currentRevision,
				repository: { root: cwd, baseline_revision: cwd === taskRoot ? taskRevision : startupRevision },
			});
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "set",
							steps: [{ content: "Pinned task", status: "in_progress" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "startup", path: startupRoot })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "task", path: taskRoot })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "startup" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Task attachment ready"),
			]);
			await harness.session.prompt("Prepare a pinned task workspace.");
			goal = createGoalState({ goalId: "task-directory", userGoal: "Verify the pinned task", now: "T0" });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "task" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Continue"),
			]);
			await harness.session.prompt("Continue the task.");

			expect(store.getRepo()).toMatchObject({
				root: taskRoot,
				baseline_revision: taskRevision,
				current_revision: taskRevision,
			});
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_directory", {
							action: "bind",
							taskId: "step-1",
							workspaceId: "task",
							pinned: true,
						}),
						fauxToolCall("task_directory", { action: "select", workspaceId: "startup" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The pinned task stays on its own repository."),
			]);
			await harness.session.prompt("Pin the active task and move the selected workspace.");
			expect(harness.session.taskCwd).toBe(startupRoot);
			expect(store.getRepo()).toMatchObject({ root: taskRoot, current_revision: taskRevision });
			const review = harness.session.agent.state.tools.find((candidate) => candidate.name === "systemone")!;
			const reviewEvidence = async (path: string, id: string) => {
				const input = {
					action: "review" as const,
					review: {
						state: "Check the pinned task source.",
						questions: {
							claim: {
								instructions: "Does the evidence contain a README?",
								criteria: { supports: "Yes", contradicts: "No" },
								expected: "supports",
							},
						},
					},
					evidenceRefs: [`file:${path}`],
				};
				const invocation = await review.bindInvocation!(id, input);
				try {
					return await invocation.execute(id, input);
				} finally {
					invocation.release();
				}
			};
			const inScope = await reviewEvidence("README.md", "in-scope");
			expect(inScope.details).toMatchObject({
				sourceManifest: [expect.objectContaining({ canonicalPath: join(taskRoot, "README.md") })],
			});
			const outsideTask = await reviewEvidence(join(startupRoot, "README.md"), "outside-task");
			expect(outsideTask.isError).toBe(true);
			expect(JSON.stringify(outsideTask)).toContain("outside the task directory");
			for (const name of ["systemone", "peer"]) {
				const tool = harness.session.agent.state.tools.find((candidate) => candidate.name === name);
				expect(tool, `${name} is available in the foreground session`).toBeDefined();
				const invocation = await tool!.bindInvocation!("scope-check", {});
				try {
					expect(invocation.executionContext?.cwd).toBe(taskRoot);
				} finally {
					invocation.release();
				}
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("SDK truth source refreshes repository identity after workspace selection changes mid-turn", async () => {
		const startupRoot = committedRepo("sdk-system-one-startup");
		const taskRoot = committedRepo("sdk-system-one-task");
		const taskRepositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: taskRoot,
			encoding: "utf8",
		}).trim();
		const startupRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: startupRoot, encoding: "utf8" }).trim();
		const taskRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: taskRoot, encoding: "utf8" }).trim();
		const provider = registerFauxProvider();
		const model = provider.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: provider.api,
			models: provider.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				textToolCallProtocol: registered.textToolCallProtocol,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				baseUrl: registered.baseUrl,
				defaultThinkingLevel: registered.defaultThinkingLevel,
				thinkingLevelMap: registered.thinkingLevelMap,
			})),
		});
		const store = new ExecutionStore({
			run_id: "sdk-task-directory-projection",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: startupRoot, baseline_revision: startupRevision, current_revision: startupRevision },
		});
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-test", answers: {}, latency_ms: 0 }) },
		});
		const { session } = await createAgentSession({
			cwd: startupRoot,
			agentDir: startupRoot,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ modelCapability: { mode: "off" } }),
			sessionManager: SessionManager.inMemory(startupRoot),
			systemOneController: controller,
			tools: ["task_directory", "task_steps"],
		});
		try {
			provider.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "set",
							steps: [{ content: "Active task", status: "in_progress" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "task", path: taskRoot })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Task registered"),
			]);
			await session.prompt("Prepare the task workspace.");
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "task" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Continue"),
			]);
			await session.prompt("Select the task workspace during this turn.");

			expect(store.getRepo()).toMatchObject({
				root: taskRepositoryRoot,
				baseline_revision: taskRevision,
				current_revision: taskRevision,
			});
		} finally {
			await session.disposeAndWait();
			provider.unregister();
		}
	});

	it("SDK completion attributes only the selected task repository's goal-owned change", async () => {
		const startupRoot = committedRepo("sdk-work-evidence-startup");
		const taskRoot = committedRepo("sdk-work-evidence-task");
		const taskRepositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: taskRoot,
			encoding: "utf8",
		}).trim();
		const startupRepositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: startupRoot,
			encoding: "utf8",
		}).trim();
		const taskDirectory = join(taskRoot, "nested");
		mkdirSync(taskDirectory);
		writeFileSync(join(startupRoot, "README.md"), "startup pre-existing tracked dirt\n");
		writeFileSync(join(startupRoot, "startup-before-goal.txt"), "startup pre-existing untracked dirt\n");
		writeFileSync(join(taskRoot, "README.md"), "task pre-existing tracked dirt\n");
		writeFileSync(join(taskRoot, "task-before-goal.txt"), "task pre-existing untracked dirt\n");
		const startupRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: startupRoot, encoding: "utf8" }).trim();
		const provider = registerFauxProvider();
		const model = provider.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: provider.api,
			models: provider.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				textToolCallProtocol: registered.textToolCallProtocol,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				baseUrl: registered.baseUrl,
				defaultThinkingLevel: registered.defaultThinkingLevel,
				thinkingLevelMap: registered.thinkingLevelMap,
			})),
		});
		const store = new ExecutionStore({
			run_id: "sdk-work-evidence-task-directory",
			objective: {
				request: "Write one goal-owned file",
				normalized_goal: "Write one goal-owned file",
				acceptance_criteria: [],
			},
			repo: { root: startupRoot, baseline_revision: startupRevision, current_revision: startupRevision },
		});
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-test", answers: {}, latency_ms: 0 }) },
		});
		const { session } = await createAgentSession({
			cwd: startupRoot,
			agentDir: startupRoot,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ modelCapability: { mode: "off" } }),
			sessionManager: SessionManager.inMemory(startupRoot),
			systemOneController: controller,
			tools: ["task_directory", "task_steps", "write"],
		});
		try {
			provider.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "set",
							steps: [{ content: "Task repo work", status: "in_progress" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Task started"),
			]);
			await session.prompt("Start the task in its task directory.");
			provider.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("task_directory", { action: "register", workspaceId: "task", path: taskDirectory })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Task registered"),
			]);
			await session.prompt("Register the task workspace.");
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "task" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Task selected"),
			]);
			await session.prompt("Select the task workspace.");
			provider.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_directory", {
							action: "bind",
							taskId: "step-1",
							workspaceId: "task",
							pinned: true,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Task workspace bound"),
			]);
			await session.prompt("Bind the active task to its workspace.");
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "session" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "task" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Task workspace reselected"),
			]);
			await session.prompt("Reselect the task workspace after visiting the startup workspace.");
			session.saveGoalStateSnapshot(
				createGoalState({
					goalId: "task-repository-work",
					userGoal: "Write a goal-owned file in the selected task repository",
					now: "T0",
				}),
			);
			const nestedAbsoluteTarget = join(taskDirectory, "new-parent", "deeper", "goal-owned.txt");
			provider.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: nestedAbsoluteTarget, content: "only this goal's change\n" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Goal-owned file written"),
			]);
			await session.prompt("Write the requested goal-owned file.");
			expect(existsSync(nestedAbsoluteTarget)).toBe(true);
			expect(existsSync(join(taskRoot, "new-parent", "deeper", "goal-owned.txt"))).toBe(false);
			expect(existsSync(join(startupRoot, "new-parent", "deeper", "goal-owned.txt"))).toBe(false);

			const completion = controller.completionView();
			expect(completion.repositoryOutcome, JSON.stringify(session.getGoalWorkEvidence())).toBe(true);
			const finalDiff = completion.view.final_diff as {
				patch: string;
				new_untracked_files: string[];
				repositories: { root: string; base: string }[];
			};
			expect(finalDiff.patch).toContain("only this goal's change");
			expect(finalDiff.patch).not.toContain("startup pre-existing");
			expect(finalDiff.patch).not.toContain("task pre-existing");
			expect(finalDiff.patch).not.toContain(startupRepositoryRoot);
			expect(finalDiff.new_untracked_files).toEqual([
				`${taskRepositoryRoot}:nested/new-parent/deeper/goal-owned.txt`,
			]);
			expect(finalDiff.repositories.map((repository) => repository.root)).toEqual([taskRepositoryRoot]);
			expect(JSON.stringify(finalDiff)).not.toContain("startup-before-goal.txt");
			expect(JSON.stringify(finalDiff)).not.toContain("task-before-goal.txt");
		} finally {
			await session.disposeAndWait();
			provider.unregister();
		}
	});

	it("does not treat pre-existing startup dirt as planning-only goal outcome", async () => {
		const startupRoot = committedRepo("sdk-planning-only-dirty-startup");
		writeFileSync(join(startupRoot, "README.md"), "unrelated tracked dirt before the goal\n");
		writeFileSync(join(startupRoot, "before-goal.txt"), "unrelated untracked dirt before the goal\n");
		const startupRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: startupRoot, encoding: "utf8" }).trim();
		const provider = registerFauxProvider();
		const model = provider.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: provider.api,
			models: provider.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				textToolCallProtocol: registered.textToolCallProtocol,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				baseUrl: registered.baseUrl,
				defaultThinkingLevel: registered.defaultThinkingLevel,
				thinkingLevelMap: registered.thinkingLevelMap,
			})),
		});
		const store = new ExecutionStore({
			run_id: "sdk-planning-only-dirty-startup",
			objective: { request: "Plan the work", normalized_goal: "Plan the work", acceptance_criteria: [] },
			repo: { root: startupRoot, baseline_revision: startupRevision, current_revision: startupRevision },
		});
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-test", answers: {}, latency_ms: 0 }) },
		});
		const { session } = await createAgentSession({
			cwd: startupRoot,
			agentDir: startupRoot,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ modelCapability: { mode: "off" } }),
			sessionManager: SessionManager.inMemory(startupRoot),
			systemOneController: controller,
		});
		try {
			session.saveGoalStateSnapshot(
				createGoalState({
					goalId: "planning-only",
					userGoal: "Plan a change without modifying the repository",
					now: "T0",
				}),
			);
			const completion = controller.completionView();
			expect(completion.repositoryOutcome).toBe(false);
			expect(JSON.stringify(completion.view)).not.toContain("unrelated tracked dirt");
			expect(JSON.stringify(completion.view)).not.toContain("before-goal.txt");
		} finally {
			await session.disposeAndWait();
			provider.unregister();
		}
	});
});
