import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentContext, AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { PI_WORKER_ALLOWED_PATHS_ENV } from "../src/core/autonomy/worker-session-private-scope.ts";
import { ExtensionRunner } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RuntimeBuilder, type RuntimeBuilderDeps } from "../src/core/runtime-builder.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import type { LoadExtensionsResult, ResourceLoader } from "../src/index.ts";

/**
 * D2: the worker UAC ceiling (WORKER_FORBIDDEN_TOOLS, session-role.ts) must win even when an
 * allow-list EXPLICITLY grants an agent-launching or root-owned durable-state tool by name. The
 * same policy gates construction and activation: a forbidden override tool must never be
 * inspected/wrapped, not merely omitted from the final registry. Ordinary capabilities inherit.
 *
 * Constructs RuntimeBuilder DIRECTLY (same rationale as
 * runtime-builder-reload-reconcile.test.ts: this repo bans cast-wired private access) and drives
 * `buildRuntime()` with a `getBaseToolsOverride` supplying minimal fake tools -- this skips
 * the entire real built-in tool-factory block (goal/task-steps/delegate/model-fitness/scout/
 * toolkit-script/worktree-sync), which is irrelevant to the ceiling itself: the ceiling gates on
 * NAME alone, regardless of which factory produced the definition.
 */

function fakeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `fake ${name} for the worker-ceiling test`,
		parameters: { type: "object", properties: {} } as never,
		execute: async () => ({ content: [], details: undefined }),
	};
}

const WORKER_ROOT_ONLY_OR_AGENT_LAUNCHING_TOOLS = [
	"goal",
	"secret_store",
	"memory",
	"delegate",
	"improvement_loop",
	"model_fitness",
	"tmux_agent_manager",
	"context_scout",
] as const;

const WORKER_INHERITED_TOOLS = [
	"create_goal",
	"get_goal",
	"update_goal",
	"task_steps",
	"pipeline",
	"tool_task",
	"worktree_sync",
	"ask_question",
	"skill",
	"skill_audit",
	"extensionify",
	"skillify",
	"run_toolkit_script",
	"fetch",
	"web_search",
	"artifact_retrieve",
	"python",
	"bash",
	"run_process",
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
] as const;

const WORKER_CEILING_TEST_TOOLS = [...WORKER_ROOT_ONLY_OR_AGENT_LAUNCHING_TOOLS, ...WORKER_INHERITED_TOOLS];

function fakeTools(names: readonly string[], observe?: (tool: AgentTool) => AgentTool): Record<string, AgentTool> {
	return Object.fromEntries(
		names.map((name) => {
			const tool = fakeTool(name);
			return [name, observe ? observe(tool) : tool];
		}),
	);
}

function unreachable(name: string): never {
	throw new Error(`${name} should not be called by a buildRuntime() with getBaseToolsOverride set`);
}

function makeDeps(
	cwd: string,
	getBaseToolsOverride: () => Record<string, AgentTool> = () => fakeTools(WORKER_CEILING_TEST_TOOLS),
	agentDir = cwd,
): RuntimeBuilderDeps {
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory();
	const model = { provider: "faux", id: "faux-model", contextWindow: 100_000 } as unknown as Model<Api>;
	const agent = {
		state: { model, thinkingLevel: "medium", tools: [], systemPrompt: "" },
	} as unknown as Agent;

	let extensionRunner = new ExtensionRunner([], createExtensionRuntime(), cwd, sessionManager, modelRegistry);
	let baseSystemPrompt = "";
	let requestedActiveToolNames: string[] | undefined;
	let unboundToolGrantWarnings: string[] = [];
	const extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const resourceLoader: ResourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getActiveSkills: () => [],
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getActivePrompts: () => [],
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getActiveThemes: () => [],
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getAgentsDiagnostics: () => [],
		getDiscoverableSkillPaths: () => [],
		getDiscoverablePromptPaths: () => [],
		getDiscoverableAgentsFilePaths: () => [],
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getLoadedExtension: () => undefined,
		removeLoadedExtension: () => undefined,
		loadSingleExtension: async () => ({ extension: null, error: "Not implemented" }),
		extendResources: () => {},
		reload: async () => unreachable("resourceLoader.reload"),
		getDiscoverableExtensionPaths: async () => [],
	};
	const skillVault = new SkillVaultController({ getSkills: () => resourceLoader.getActiveSkills() });

	return {
		getAgent: () => agent,
		getCwd: () => cwd,
		getShellSessionKey: () => "test-shell-session",
		getAgentDir: () => agentDir,
		getLaneWorkerRefusal: () => undefined,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => settingsManager,
		getModelRegistry: () => modelRegistry,
		isModelExhausted: () => false,
		getResourceLoader: () => resourceLoader,
		getSkillVault: () => skillVault,
		getExtensionRunner: () => extensionRunner,
		setExtensionRunner: (runner) => {
			extensionRunner = runner;
		},
		getBaseSystemPrompt: () => baseSystemPrompt,
		setBaseSystemPrompt: (prompt) => {
			baseSystemPrompt = prompt;
		},
		getCustomTools: () => [],
		// Truthy override skips the entire built-in diagnostics/goal/task-steps/delegate/model-
		// fitness/scout/toolkit-script/worktree-sync tool creation block -- irrelevant to a ceiling
		// that gates purely on tool NAME. Fake tools cover every deliberately forbidden category and
		// capabilities that must inherit from the orchestrator.
		getBaseToolsOverride,
		getRequestedActiveToolNames: () => requestedActiveToolNames,
		setRequestedActiveToolNames: (names) => {
			requestedActiveToolNames = names;
		},
		getToolProfileFilter: () => undefined,
		setToolProfileFilter: () => {},
		// The allow-list EXPLICITLY grants every fake tool. The categorical worker ceiling wins only
		// for agent launchers and root-owned durable state; every other capability must inherit.
		getAllowedToolNames: () => new Set(WORKER_CEILING_TEST_TOOLS),
		getExcludedToolNames: () => undefined,
		deriveToolProfileFilter: () => unreachable("deriveToolProfileFilter"),
		isToolOrCommandAllowedByProfile: () => false,
		isExtensionPathAllowed: (_path, authority) => authority === "explicit",
		filterExtensionsForRuntime: (extensions) => extensions,
		setUnboundToolGrantWarnings: (warnings) => {
			unboundToolGrantWarnings = warnings;
		},
		getUnboundToolGrantWarnings: () => unboundToolGrantWarnings,
		createProfileFilterReloadSnapshot: () => unreachable("createProfileFilterReloadSnapshot"),
		restoreProfileFilterReloadSnapshot: () => unreachable("restoreProfileFilterReloadSnapshot"),
		getActiveToolNames: () => [],
		setActiveToolsByName: () => {},
		normalizePromptSnippet: (text) => text,
		normalizePromptGuidelines: (guidelines) => guidelines ?? [],
		bindExtensionCore: () => {},
		applyExtensionBindings: () => {},
		extendResourcesFromExtensions: () => unreachable("extendResourcesFromExtensions"),
		reapplyActiveProfileModelSettings: async () => unreachable("reapplyActiveProfileModelSettings"),
		notifyExtensionsChanged: () => unreachable("notifyExtensionsChanged"),
		getToolArtifactStore: () => unreachable("getToolArtifactStore"),
		getSessionImageStore: () => undefined,
		getMemoryManager: () => ({ getToolDefinitions: () => [] }) as unknown as MemoryManager,
		getMemoryAuditDiagnostics: () => unreachable("getMemoryAuditDiagnostics"),
		clearPendingMemoryProviders: () => unreachable("clearPendingMemoryProviders"),
		createMemoryReloadSnapshot: () => unreachable("createMemoryReloadSnapshot"),
		restoreMemoryReloadSnapshot: () => unreachable("restoreMemoryReloadSnapshot"),
		initializeMemory: async () => unreachable("initializeMemory"),
		getGoalStateSnapshot: () => unreachable("getGoalStateSnapshot"),
		saveGoalStateSnapshot: () => unreachable("saveGoalStateSnapshot"),
		getTaskStepsStateSnapshot: () => unreachable("getTaskStepsStateSnapshot"),
		saveTaskStepsStateSnapshot: () => unreachable("saveTaskStepsStateSnapshot"),
		getPipelineRunSnapshot: () => undefined,
		savePipelineRunSnapshot: () => unreachable("savePipelineRunSnapshot"),
		getContextGcReport: () => unreachable("getContextGcReport"),
		startWorkerDelegation: () => unreachable("startWorkerDelegation"),
		getOrchestrationProfileCatalog: () => [],
		getWorkerLaneRecords: () => unreachable("getWorkerLaneRecords"),
		getWorkerClaimSnapshots: () => unreachable("getWorkerClaimSnapshots"),
		resolveManagedLaneId: () => unreachable("resolveManagedLaneId"),
		runWorkerDelegationOnce: () => unreachable("runWorkerDelegationOnce"),
		runModelFitness: () => unreachable("runModelFitness"),
		resolveCurationModelIfFit: () => unreachable("resolveCurationModelIfFit"),
		runIsolatedCompletion: () => unreachable("runIsolatedCompletion"),
		addSpawnedUsage: () => unreachable("addSpawnedUsage"),
		createAgentContextSnapshot: () => ({}) as unknown as AgentContext,
		getContextUsage: () => undefined,
		isStreaming: () => false,
		isCompacting: () => false,
		getExtensionUIContext: () => undefined,
		getExtensionCommandContextActions: () => undefined,
		getExtensionShutdownHandler: () => undefined,
		getExtensionErrorListener: () => undefined,
	} satisfies RuntimeBuilderDeps;
}

const PI_SESSION_ROLE_ENV = "PI_SESSION_ROLE";
const PI_WORKTREE_LANE_ENV = "PI_WORKTREE_LANE";

describe("RuntimeBuilder worker UAC ceiling (D2)", () => {
	const originalRole = process.env[PI_SESSION_ROLE_ENV];
	const originalWorkerAllowedPaths = process.env[PI_WORKER_ALLOWED_PATHS_ENV];
	const originalWorktreeLane = process.env[PI_WORKTREE_LANE_ENV];

	afterEach(() => {
		if (originalRole === undefined) delete process.env[PI_SESSION_ROLE_ENV];
		else process.env[PI_SESSION_ROLE_ENV] = originalRole;
		if (originalWorkerAllowedPaths === undefined) delete process.env[PI_WORKER_ALLOWED_PATHS_ENV];
		else process.env[PI_WORKER_ALLOWED_PATHS_ENV] = originalWorkerAllowedPaths;
		if (originalWorktreeLane === undefined) delete process.env[PI_WORKTREE_LANE_ENV];
		else process.env[PI_WORKTREE_LANE_ENV] = originalWorktreeLane;
	});

	it("removes only agent-launching and root-owned durable-state tools while inheriting ordinary capabilities", () => {
		process.env[PI_SESSION_ROLE_ENV] = "worker";
		try {
			let forbiddenToolReads = 0;
			const observeReads = (tool: AgentTool): AgentTool =>
				new Proxy(tool, {
					get(target, property, receiver) {
						forbiddenToolReads += 1;
						return Reflect.get(target, property, receiver);
					},
				});
			const runtimeBuilder = new RuntimeBuilder(
				makeDeps("/tmp/pi-worker-ceiling-test", () => ({
					...fakeTools(WORKER_ROOT_ONLY_OR_AGENT_LAUNCHING_TOOLS, observeReads),
					...fakeTools(WORKER_INHERITED_TOOLS),
				})),
			);
			runtimeBuilder.buildRuntime({
				activeToolNames: WORKER_CEILING_TEST_TOOLS,
			});
			expect(forbiddenToolReads).toBe(0);

			for (const name of WORKER_ROOT_ONLY_OR_AGENT_LAUNCHING_TOOLS) {
				expect(runtimeBuilder.getToolDefinition(name)).toBeUndefined();
				expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).not.toContain(name);
			}
			for (const name of WORKER_INHERITED_TOOLS) {
				expect(runtimeBuilder.getToolDefinition(name)).toBeDefined();
			}
			expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).toEqual(
				expect.arrayContaining([...WORKER_INHERITED_TOOLS]),
			);
		} finally {
			if (originalRole === undefined) delete process.env[PI_SESSION_ROLE_ENV];
			else process.env[PI_SESSION_ROLE_ENV] = originalRole;
		}
	});

	it("keeps every explicitly allowed fake tool for a main session", () => {
		delete process.env[PI_SESSION_ROLE_ENV];
		const runtimeBuilder = new RuntimeBuilder(makeDeps("/tmp/pi-worker-ceiling-test-main"));
		runtimeBuilder.buildRuntime({
			activeToolNames: WORKER_CEILING_TEST_TOOLS,
		});

		for (const name of WORKER_CEILING_TEST_TOOLS) {
			expect(runtimeBuilder.getToolDefinition(name)).toBeDefined();
		}
		expect(runtimeBuilder.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining([...WORKER_CEILING_TEST_TOOLS]),
		);
	});

	it("keeps inherited process tools available for a worktree-bound worker", () => {
		process.env[PI_SESSION_ROLE_ENV] = "worker";
		process.env[PI_WORKTREE_LANE_ENV] = "assigned-lane";
		const runtimeBuilder = new RuntimeBuilder(
			makeDeps("/tmp/pi-worker-bound-lane", () => ({ bash: fakeTool("bash"), python: fakeTool("python") })),
		);
		expect(() => runtimeBuilder.buildRuntime({ activeToolNames: ["bash", "python"] })).not.toThrow();
		expect(runtimeBuilder.getRegisteredTool("bash")).toBeDefined();
		expect(runtimeBuilder.getRegisteredTool("python")).toBeDefined();
	});

	it("denies structural private-path access without pretending bash or python are path confined", async () => {
		process.env[PI_SESSION_ROLE_ENV] = "worker";
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-private-scope-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		const privateAuth = path.join(agentDir, "auth.json");
		const ordinarySibling = path.join(root, "other-project", "source.ts");
		const calls: Array<{ name: string; params: unknown }> = [];
		const observedTool = (name: string): AgentTool => ({
			...fakeTool(name),
			execute: async (_toolCallId, params) => {
				calls.push({ name, params });
				return { content: [], details: { executed: true } };
			},
		});
		try {
			const runtimeBuilder = new RuntimeBuilder(
				makeDeps(
					cwd,
					() => ({
						read: observedTool("read"),
						write: observedTool("write"),
						edit: observedTool("edit"),
						grep: observedTool("grep"),
						find: observedTool("find"),
						bash: observedTool("bash"),
						python: observedTool("python"),
						run_process: observedTool("run_process"),
					}),
					agentDir,
				),
			);
			runtimeBuilder.buildRuntime({
				activeToolNames: ["read", "write", "edit", "grep", "find", "bash", "python", "run_process"],
			});

			for (const name of ["read", "write", "edit", "grep", "find"] as const) {
				const result = await runtimeBuilder
					.getRegisteredTool(name)
					?.execute(`private-${name}`, { path: privateAuth }, new AbortController().signal);
				expect(result).toMatchObject({ isError: true, details: { outcome: "envelope_path_denied" } });
			}
			expect(calls).toHaveLength(0);

			const ordinaryRead = await runtimeBuilder
				.getRegisteredTool("read")
				?.execute("ordinary-read", { path: ordinarySibling }, new AbortController().signal);
			expect(ordinaryRead).toMatchObject({ details: { executed: true } });
			expect(calls).toContainEqual({ name: "read", params: { path: ordinarySibling } });

			await expect(
				runtimeBuilder
					.getRegisteredTool("bash")
					?.execute("process-trust-boundary", { command: `cat ${privateAuth}` }, new AbortController().signal),
			).rejects.toMatchObject({ failureCode: "credential_access_blocked" });
			expect(calls).not.toContainEqual({ name: "bash", params: { command: `cat ${privateAuth}` } });

			await expect(
				runtimeBuilder
					.getRegisteredTool("python")
					?.execute(
						"python-trust-boundary",
						{ code: `open(${JSON.stringify(privateAuth)}).read()` },
						new AbortController().signal,
					),
			).rejects.toMatchObject({ failureCode: "credential_access_blocked" });
			expect(calls).not.toContainEqual({
				name: "python",
				params: { code: `open(${JSON.stringify(privateAuth)}).read()` },
			});

			await expect(
				runtimeBuilder
					.getRegisteredTool("run_process")
					?.execute(
						"run-process-private",
						{ executable: process.execPath, args: ["-e", "read", privateAuth] },
						new AbortController().signal,
					),
			).rejects.toMatchObject({ failureCode: "credential_access_blocked" });
			expect(calls).not.toContainEqual({
				name: "run_process",
				params: { executable: process.execPath, args: ["-e", "read", privateAuth] },
			});

			const ordinaryProcess = await runtimeBuilder
				.getRegisteredTool("run_process")
				?.execute(
					"run-process-ordinary",
					{ executable: process.execPath, args: ["-e", "read", ordinarySibling] },
					new AbortController().signal,
				);
			expect(ordinaryProcess).toMatchObject({ details: { executed: true } });
			expect(calls).toContainEqual({
				name: "run_process",
				params: { executable: process.execPath, args: ["-e", "read", ordinarySibling] },
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not apply the worker private-path envelope to a main session", async () => {
		delete process.env[PI_SESSION_ROLE_ENV];
		const cwd = "/tmp/pi-main-private-scope-project";
		const agentDir = "/tmp/pi-main-private-scope-agent";
		let executed = false;
		const runtimeBuilder = new RuntimeBuilder(
			makeDeps(
				cwd,
				() => ({
					read: {
						...fakeTool("read"),
						execute: async () => {
							executed = true;
							return { content: [], details: { executed: true } };
						},
					},
				}),
				agentDir,
			),
		);
		runtimeBuilder.buildRuntime({ activeToolNames: ["read"] });
		const result = await runtimeBuilder
			.getRegisteredTool("read")
			?.execute("main-read", { path: path.join(agentDir, "auth.json") }, new AbortController().signal);
		expect(result).toMatchObject({ details: { executed: true } });
		expect(executed).toBe(true);
	});

	it("enforces an immutable explicit worker path for structural filesystem tools", async () => {
		process.env[PI_SESSION_ROLE_ENV] = "worker";
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-explicit-scope-"));
		const cwd = path.join(root, "assigned-project");
		const sibling = path.join(root, "other-project", "source.ts");
		fs.mkdirSync(cwd, { recursive: true });
		process.env[PI_WORKER_ALLOWED_PATHS_ENV] = JSON.stringify([cwd]);
		const calls: unknown[] = [];
		try {
			const runtimeBuilder = new RuntimeBuilder(
				makeDeps(cwd, () => ({
					read: {
						...fakeTool("read"),
						execute: async (_toolCallId, params) => {
							calls.push(params);
							return { content: [], details: { executed: true } };
						},
					},
				})),
			);
			runtimeBuilder.buildRuntime({ activeToolNames: ["read"] });

			const inside = await runtimeBuilder
				.getRegisteredTool("read")
				?.execute("inside", { path: path.join(cwd, "source.ts") }, new AbortController().signal);
			expect(inside).toMatchObject({ details: { executed: true } });

			const outside = await runtimeBuilder
				.getRegisteredTool("read")
				?.execute("outside", { path: sibling }, new AbortController().signal);
			expect(outside).toMatchObject({ isError: true, details: { outcome: "envelope_path_denied" } });
			expect(calls).toEqual([{ path: path.join(cwd, "source.ts") }]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["not-json", JSON.stringify(["relative/path"]), JSON.stringify(["/tmp/ok", 7])])(
		"fails closed on a malformed worker path channel: %s",
		(raw) => {
			process.env[PI_SESSION_ROLE_ENV] = "worker";
			process.env[PI_WORKER_ALLOWED_PATHS_ENV] = raw;
			expect(() => new RuntimeBuilder(makeDeps("/tmp/pi-worker-invalid-scope"))).toThrow(
				`${PI_WORKER_ALLOWED_PATHS_ENV} must be a JSON array of absolute paths.`,
			);
		},
	);
});
