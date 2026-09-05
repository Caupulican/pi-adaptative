import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type {
	CollaborationAgent,
	CollaborationBackend,
	CollaborationStart,
} from "../../src/core/collaboration/backend.ts";
import {
	type CollaborationExtensionOptions,
	piCollaborationExtension,
} from "../../src/core/collaboration/extension.ts";
import { type CollaborationJob, CollaborationJobStore } from "../../src/core/collaboration/job-store.ts";
import { NativeProviderRegistry } from "../../src/core/collaboration/native-provider.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

/** Native I/O is replaced at the backend port; durable turns and the packaged extension remain real. */
export async function collaborationFixture(options: Pick<CollaborationExtensionOptions, "watch"> = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-regression-"));
	const store = new CollaborationJobStore(root, "parent");
	const states = new Map<string, CollaborationAgent>();
	let sequence = 0;
	const pane = () => ({
		paneId: `pane-${++sequence}`,
		terminalId: `terminal-${sequence}`,
		workspaceId: "workspace",
		tabId: "tab",
	});
	const panes = new Map<string, ReturnType<typeof pane>>();
	const createPane = () => {
		const value = pane();
		panes.set(value.paneId, value);
		return value;
	};
	const backend = {
		id: "fixture",
		session: "fixture",
		createWorkspace: vi.fn(async (_input: Parameters<CollaborationBackend["createWorkspace"]>[0]) => ({
			workspaceId: "workspace",
			tabId: "tab",
			rootPane: createPane(),
		})),
		splitPane: vi.fn(async () => createPane()),
		startAgent: vi.fn(async (input: CollaborationStart) => {
			const target = panes.get(input.paneId);
			if (!target) throw new Error("Missing fixture pane");
			const state: CollaborationAgent = {
				...target,
				name: input.name,
				kind: input.kind,
				status: "idle",
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 1,
				revision: 1,
			};
			states.set(input.name, state);
			return state;
		}),
		getAgent: vi.fn(async (target: string) => {
			const state = states.get(target);
			if (!state) throw new Error("Agent unavailable");
			return state;
		}),
		listAgents: vi.fn(async () => [...states.values()]),
		prompt: vi.fn(async () => {
			throw new Error("Unexpected direct prompt: helper owns delivery");
		}),
		answerQuestion: vi.fn(async () => {
			throw new Error("Unexpected direct answer: helper owns delivery");
		}),
		readAgent: vi.fn(async () => ({ paneId: "pane-1", text: "", truncated: false, revision: 1 })),
		closePane: vi.fn(async () => {}),
		closeWorkspace: vi.fn(async () => {}),
		stopSession: vi.fn(async () => {}),
		notify: vi.fn(async () => {}),
		reportMetadata: vi.fn(async () => {}),
	} satisfies CollaborationBackend;
	const run = vi.fn(async (_executable: string, args: readonly string[]) => ({
		code: 0,
		reason: "exited" as const,
		stderr: "",
		stdout:
			args[0] === "login"
				? "Logged in using ChatGPT"
				: args[0] === "models"
					? "model\tFixture model"
					: JSON.stringify({
							loggedIn: true,
							providers: [{ provider: "fixture", configured: true, status: "valid" }],
						}),
	}));
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>();
	const report = vi.fn();
	const sendMessage = vi.fn();
	const reportSpawnedUsage = vi.fn();
	const confirm = vi.fn(async () => {
		throw new Error("Routine manual approval is forbidden");
	});
	const api = {
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
		registerCommand: vi.fn(),
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => Promise<void>) => {
			handlers.set(name, handler);
		},
		getActiveTools: () => [
			"read",
			"write",
			"edit",
			"bash",
			"grep",
			"find",
			"ls",
			"pipeline",
			"create_goal",
			"get_goal",
			"update_goal",
			"ask_question",
			"skill",
			"run_toolkit_script",
			"tool_task",
			"worktree_sync",
			"memory",
			"delegate",
			"pi_collaboration",
		],
		getThinkingLevel: () => "high",
		getEffectiveResourceProfile: () => ({}),
		reportManagedLane: report,
		reportSpawnedUsage,
		sendMessage,
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		hasUI: true,
		sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
		ui: { notify: vi.fn(), confirm },
	} as unknown as ExtensionContext;
	const launchTurn = vi.fn(async (_store: CollaborationJobStore, _job: CollaborationJob) => {});
	piCollaborationExtension(api, {
		watch: options.watch,
		stateDirectory: root,
		backend: async () => backend,
		providers: new NativeProviderRegistry(run, [], () => ({ executable: "pi", argsPrefix: [] })),
		launchTurn,
	});
	return {
		root,
		store,
		api,
		context,
		backend,
		run,
		launchTurn,
		report,
		reportSpawnedUsage,
		sendMessage,
		confirm,
		states,
		tool: () => {
			if (!tool) throw new Error("Tool not registered");
			return tool;
		},
		execute: (input: unknown) => {
			if (!tool) throw new Error("Tool not registered");
			return tool.execute("call", input, undefined, undefined, context);
		},
		start: () => handlers.get("session_start")?.({}, context),
		shutdown: () => handlers.get("session_shutdown")?.({}, context),
		cleanup: async () => {
			await handlers.get("session_shutdown")?.({}, context);
			await rm(root, { recursive: true, force: true });
		},
	};
}
