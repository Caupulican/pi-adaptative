import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	CollaborationAgent,
	CollaborationBackend,
	CollaborationEvent,
	CollaborationPane,
	CollaborationStart,
} from "../src/core/collaboration/backend.ts";
import { detectHerdrCallerContext, resolveCollaborationBackend } from "../src/core/collaboration/backend-resolver.ts";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { piCollaborationExtension } from "../src/core/collaboration/extension.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import { isSupportedHerdrProtocol } from "../src/core/collaboration/herdr-protocol.ts";
import { type CollaborationJob, CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { NativeProviderRegistry } from "../src/core/collaboration/native-provider.ts";
import type { CollaborationResultClaim } from "../src/core/collaboration/result-claim.ts";
import { reconcileCollaborationSessions } from "../src/core/collaboration/session-recovery.ts";
import { executeCollaborationTurn } from "../src/core/collaboration/turn-runner.ts";
import { waitForAgentEventCondition } from "../src/core/collaboration/turn-settlement.ts";
import type { ExtensionAPI, ExtensionContext, ManagedLaneEvent, ToolDefinition } from "../src/core/extensions/types.ts";

function createStubBackend(overrides: Partial<CollaborationBackend> = {}): CollaborationBackend {
	const unused = async (): Promise<never> => {
		throw new Error("Unexpected backend method called in test");
	};
	return {
		id: "herdr",
		session: "shared",
		createWorkspace: unused,
		splitPane: unused,
		getPane: unused,
		startAgent: unused,
		getAgent: unused,
		listAgents: unused,
		prompt: unused,
		answerQuestion: unused,
		readAgent: unused,
		closePane: unused,
		closeWorkspace: unused,
		stopSession: unused,
		notify: unused,
		reportMetadata: unused,
		...overrides,
	};
}

function createStubJob(overrides: Partial<CollaborationJob> = {}): CollaborationJob {
	return {
		id: "stub-job",
		parentSessionId: "parent",
		sessionName: "shared",
		cwd: "/tmp",
		title: "Stub Job",
		createdAt: Date.now(),
		deadlineSeconds: 1200,
		version: 1,
		variables: {},
		metadata: {},
		mailbox: { messages: [], receipts: [] },
		dismissed: false,
		agents: [],
		...overrides,
	};
}

function createMockBackend(initialPanes?: CollaborationPane[]) {
	let sequence = 100;
	const panes = new Map<string, CollaborationPane>();
	const states = new Map<string, CollaborationAgent>();

	for (const p of initialPanes ?? []) {
		panes.set(p.paneId, { ...p });
	}

	const pane = (_direction?: "right" | "down") => {
		const id = `pane-${++sequence}`;
		const entry: CollaborationPane = {
			paneId: id,
			terminalId: `term-${sequence}`,
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		panes.set(id, entry);
		return entry;
	};

	const backend = {
		id: "herdr",
		session: "",
		createWorkspace: vi.fn(async (_input: Parameters<CollaborationBackend["createWorkspace"]>[0]) => {
			const root = pane();
			return { workspaceId: "managed-w", tabId: "managed-t", rootPane: root };
		}),
		splitPane: vi.fn(async (input: Parameters<CollaborationBackend["splitPane"]>[0]) => {
			const target = panes.get(input.paneId);
			if (!target) throw new Error(`Target pane not found: ${input.paneId}`);
			const fresh = pane(input.direction);
			fresh.workspaceId = target.workspaceId;
			fresh.tabId = target.tabId;
			return fresh;
		}),
		getPane: vi.fn(async (paneId: string) => {
			const entry = panes.get(paneId);
			if (!entry) throw new Error(`Pane not found: ${paneId}`);
			return { ...entry };
		}),
		startAgent: vi.fn(async (input: CollaborationStart) => {
			const target = panes.get(input.paneId);
			if (!target) throw new Error(`Missing pane for startAgent: ${input.paneId}`);
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
			states.set(input.paneId, state);
			return state;
		}),
		getAgent: vi.fn(async (target: string) => {
			const state = states.get(target);
			if (!state) throw new Error(`Agent not found: ${target}`);
			return { ...state };
		}),
		listAgents: vi.fn(async () => [...states.values()]),
		prompt: vi.fn(async () => {
			throw new Error("Prompt directly not used in this test");
		}),
		answerQuestion: vi.fn(async () => {
			throw new Error("AnswerQuestion directly not used in this test");
		}),
		readAgent: vi.fn(async (target: string) => ({
			paneId: target,
			text: "sample output",
			truncated: false,
			revision: 1,
		})),
		closePane: vi.fn(async (paneId: string) => {
			panes.delete(paneId);
			states.delete(paneId);
		}),
		closeWorkspace: vi.fn(async (workspaceId: string) => {
			for (const [id, p] of panes) {
				if (p.workspaceId === workspaceId) {
					panes.delete(id);
					states.delete(id);
				}
			}
		}),
		stopSession: vi.fn(async () => {}),
		notify: vi.fn(async () => {}),
		reportMetadata: vi.fn(async () => {}),
	};

	return { backend, panes, states };
}

describe("Herdr panel orchestration", () => {
	it("detectHerdrCallerContext detects and validates environment variables", () => {
		const validEnv = {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w9:pA",
			HERDR_WORKSPACE_ID: "w9",
			HERDR_TAB_ID: "w9:tA",
			HERDR_SOCKET_PATH: "/home/caudev/.config/herdr/herdr.sock",
		};
		const detected = detectHerdrCallerContext(validEnv);
		expect(detected).toBeDefined();
		expect(detected?.paneId).toBe("w9:pA");
		expect(detected?.workspaceId).toBe("w9");
		expect(detected?.tabId).toBe("w9:tA");
		expect(detected?.socketPath).toBe("/home/caudev/.config/herdr/herdr.sock");

		// Missing HERDR_ENV
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_ENV: "0" })).toBeUndefined();
		// Invalid pane handle
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_PANE_ID: "" })).toBeUndefined();
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_PANE_ID: "invalid/handle" })).toBeUndefined();
		// Relative socket path
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_SOCKET_PATH: "herdr.sock" })).toBeUndefined();

		// HERDR_BIN_PATH validation
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_BIN_PATH: "/usr/local/bin/herdr" })?.binPath).toBe(
			"/usr/local/bin/herdr",
		);
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_BIN_PATH: "herdr" })?.binPath).toBeUndefined();
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_BIN_PATH: "/bin/herdr\0" })?.binPath).toBeUndefined();
		expect(detectHerdrCallerContext({ ...validEnv, HERDR_BIN_PATH: "   " })?.binPath).toBeUndefined();
	});

	it("managed standalone negative control creates private daemon/workspace and does not touch caller pane", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-neg-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend, panes } = createMockBackend([callerPane]);

		const events: ManagedLaneEvent[] = [];
		const coordinator = new CollaborationCoordinator({
			store,
			backend: async (target) => {
				if (typeof target === "object" && target.placement === "current-pane") {
					return backend as unknown as CollaborationBackend;
				}
				return backend as unknown as CollaborationBackend;
			},
			report: (e) => events.push(e),
			launchTurn: async () => {},
		});

		// Explicit managed-workspace placement
		const job = await coordinator.launch(
			{
				id: "job-managed",
				parentSessionId: "parent",
				sessionName: "pi-managed-test",
				cwd: root,
				title: "Managed Workspace Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "managed-workspace",
				agents: [
					{
						id: "agent-1",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: ["--effort", "high"],
						env: {},
						profile: {
							identity: "profile-1",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
				],
			},
			"Managed task",
		);

		expect(backend.createWorkspace).toHaveBeenCalledTimes(1);
		expect(job.workspaceId).toBe("managed-w");
		expect(job.placement).toBe("managed-workspace");
		// Caller pane was never modified or closed
		expect(panes.has("w9:pA")).toBe(true);

		await rm(root, { recursive: true, force: true });
	});

	it("inherited placement creates sibling panels with --no-focus, preserves cwd, no createWorkspace or new daemon", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-sibling-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend, panes } = createMockBackend([callerPane]);

		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {},
		});

		const job = await coordinator.launch(
			{
				id: "job-sibling",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Sibling Panel Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "current-pane",
				socketPath: "/home/caudev/.config/herdr/herdr.sock",
				callerPaneId: "w9:pA",
				callerWorkspaceId: "w9",
				callerTabId: "w9:tA",
				agents: [
					{
						id: "agent-1",
						name: "builder",
						task: "Implement feature in sibling panel",
						provider: "agy",
						cwd: root,
						args: ["--effort", "high", "--model", "gemini-3.8-flash-high"],
						env: {},
						profile: {
							identity: "profile-1",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
					{
						id: "agent-2",
						name: "validator",
						task: "Validate feature in sibling panel",
						provider: "agy",
						cwd: root,
						args: ["--effort", "high", "--model", "gemini-3.8-flash-high"],
						env: {},
						profile: {
							identity: "profile-2",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
				],
			},
			"Sibling task",
		);

		// No createWorkspace was called!
		expect(backend.createWorkspace).not.toHaveBeenCalled();
		// Sibling panes were split
		expect(backend.splitPane).toHaveBeenCalledTimes(2);
		// First split was from caller pane
		expect(backend.splitPane).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				paneId: "w9:pA",
				cwd: root,
			}),
		);
		// Second split was from first sibling pane
		expect(backend.splitPane).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				cwd: root,
			}),
		);

		// Both agents have distinct pane IDs, neither is caller pane
		expect(job.agents[0].paneId).toBeDefined();
		expect(job.agents[1].paneId).toBeDefined();
		expect(job.agents[0].paneId).not.toBe("w9:pA");
		expect(job.agents[1].paneId).not.toBe("w9:pA");
		expect(job.agents[0].paneId).not.toBe(job.agents[1].paneId);

		// Caller pane remains untouched
		expect(panes.has("w9:pA")).toBe(true);

		await rm(root, { recursive: true, force: true });
	});

	it("validates exact agy models catalog against requested model", async () => {
		const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
			if (args.includes("--version")) {
				return { code: 0, reason: "exited" as const, stdout: "agy 1.0.0", stderr: "" };
			}
			if (args.includes("models")) {
				return {
					code: 0,
					reason: "exited" as const,
					stdout: [
						"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
						"gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
					].join("\n"),
					stderr: "",
				};
			}
			return { code: 0, reason: "exited" as const, stdout: "", stderr: "" };
		});

		const registry = new NativeProviderRegistry(runner);

		// Requested model exists in catalog -> admitted
		const ready = await registry.inspect("agy", { model: "gemini-3.8-flash-high" });
		expect(ready.authenticated).toBe(true);
		expect(ready.status).toBe("ready");

		// Requested model does NOT exist in catalog -> rejected
		const unready = await registry.inspect("agy", { model: "nonexistent-model" });
		expect(unready.authenticated).toBe(false);
		expect(unready.status).toBe("login-required");
	});

	it("rejects launch when caller handles are stale, moved or replaced before mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-stale-"));
		const store = new CollaborationJobStore(root, "parent");
		// Caller pane in backend has workspace "w9", but job says "other-workspace"
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);

		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {},
		});

		// Stale workspace handle
		await expect(
			coordinator.launch(
				{
					id: "job-stale",
					parentSessionId: "parent",
					sessionName: "shared",
					cwd: root,
					title: "Stale Handles Job",
					createdAt: Date.now(),
					deadlineSeconds: 1200,
					placement: "current-pane",
					socketPath: "/home/caudev/.config/herdr/herdr.sock",
					callerPaneId: "w9:pA",
					callerWorkspaceId: "stale-workspace",
					callerTabId: "w9:tA",
					agents: [
						{
							id: "agent-1",
							name: "builder",
							provider: "agy",
							cwd: root,
							args: ["--effort", "high"],
							env: {},
							profile: {
								identity: "profile-1",
								allowedTools: ["bash"],
								writePaths: [],
								parentPid: process.pid,
								parentSession: "parent",
							},
						},
					],
				},
				"Task",
			),
		).rejects.toThrow(/caller/i);

		// No mutation occurred: splitPane was never called
		expect(backend.splitPane).not.toHaveBeenCalled();

		await rm(root, { recursive: true, force: true });
	});

	it("partial launch cleanup closes only newly created panes matching occupant, never caller pane or workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-partial-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend, panes } = createMockBackend([callerPane]);

		// Make startAgent fail on the 2nd agent
		let agentCount = 0;
		const originalStart = backend.startAgent;
		backend.startAgent = vi.fn(async (input: CollaborationStart) => {
			agentCount++;
			if (agentCount === 2) {
				throw new Error("Second agent failed interactive readiness");
			}
			return originalStart(input);
		});

		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {},
		});

		await expect(
			coordinator.launch(
				{
					id: "job-partial-fail",
					parentSessionId: "parent",
					sessionName: "shared",
					cwd: root,
					title: "Partial Fail Job",
					createdAt: Date.now(),
					deadlineSeconds: 1200,
					placement: "current-pane",
					socketPath: "/home/caudev/.config/herdr/herdr.sock",
					callerPaneId: "w9:pA",
					callerWorkspaceId: "w9",
					callerTabId: "w9:tA",
					agents: [
						{
							id: "agent-1",
							name: "builder",
							task: "Build partial work",
							provider: "agy",
							cwd: root,
							args: ["--effort", "high"],
							env: {},
							profile: {
								identity: "profile-1",
								allowedTools: ["bash"],
								writePaths: [],
								parentPid: process.pid,
								parentSession: "parent",
							},
						},
						{
							id: "agent-2",
							name: "validator",
							task: "Validate partial work",
							provider: "agy",
							cwd: root,
							args: ["--effort", "high"],
							env: {},
							profile: {
								identity: "profile-2",
								allowedTools: ["bash"],
								writePaths: [],
								parentPid: process.pid,
								parentSession: "parent",
							},
						},
					],
				},
				"Partial fail task",
			),
		).rejects.toThrow("Second agent failed interactive readiness");

		// Caller pane was NEVER closed
		expect(panes.has("w9:pA")).toBe(true);
		// Workspace was NEVER closed
		expect(backend.closeWorkspace).not.toHaveBeenCalled();
		// Only the created pane for agent 1 was closed
		expect(backend.closePane).toHaveBeenCalled();

		// Check durable state recorded failed terminal
		const loaded = store.load("job-partial-fail");
		expect(loaded.agents[0].status).toBe("failed");
		expect(loaded.agents[1].status).toBe("failed");

		await rm(root, { recursive: true, force: true });
	});

	it("restores, follows up, and stops using saved endpoint even if host environment changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-env-change-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		createMockBackend([callerPane]);

		// Pre-populate store with a running job with saved socketPath
		const savedSocketPath = "/home/caudev/.config/herdr/saved.sock";
		const job: CollaborationJob = store.create({
			id: "job-env-test",
			parentSessionId: "parent",
			sessionName: "shared",
			cwd: root,
			title: "Env Change Job",
			createdAt: Date.now(),
			deadlineSeconds: 1200,
			placement: "current-pane",
			socketPath: savedSocketPath,
			binPath: "/saved/herdr",
			callerPaneId: "w9:pA",
			callerWorkspaceId: "w9",
			callerTabId: "w9:tA",
			agents: [
				{
					id: "agent-1",
					name: "builder",
					provider: "agy",
					cwd: root,
					args: ["--effort", "high"],
					env: {},
					profile: {
						identity: "profile-1",
						allowedTools: ["bash"],
						writePaths: [],
						parentPid: process.pid,
						parentSession: "parent",
					},
				},
			],
		});

		store.update(job.id, (current) => {
			current.agents[0].paneId = "pane-agent-1";
			current.agents[0].backendName = "builder";
			current.agents[0].terminalId = "term-agent-1";
			current.agents[0].status = "idle";
		});

		// Now tamper with / delete host environment
		const originalEnv = { ...process.env };
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		process.env.HERDR_SOCKET_PATH = "/invalid/changed/sock";

		try {
			const observedEnvs: NodeJS.ProcessEnv[] = [];
			const mockRun = vi.fn(async (_exe: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
				observedEnvs.push({ ...(opts?.env ?? {}) });
				if (args[0] === "agent" && args[1] === "get") {
					return {
						code: 0,
						reason: "exited" as const,
						stdout: JSON.stringify({
							result: {
								type: "agent_info",
								agent: {
									pane_id: "pane-agent-1",
									terminal_id: "term-agent-1",
									workspace_id: "w-1",
									tab_id: "t-1",
									name: "builder",
									agent: "agy",
									agent_status: "idle",
									interactive_ready: true,
									launch_pending: false,
									state_change_seq: 1,
									revision: 1,
								},
							},
						}),
						stderr: "",
					};
				}
				return {
					code: 0,
					reason: "exited" as const,
					stdout: JSON.stringify({ result: {} }),
					stderr: "",
				};
			});

			const coordinator = new CollaborationCoordinator({
				store,
				backend: async (j) =>
					resolveCollaborationBackend(j, {
						run: mockRun,
						connect: vi.fn(async (path) => {
							expect(path).toBe(savedSocketPath);
							return {
								request: vi.fn(async () => ({ protocol: 22 })),
								onEvent: vi.fn(() => () => {}),
								close: vi.fn(),
							};
						}),
					}),
				report: () => {},
				launchTurn: vi.fn(async () => {}),
			});

			// Real follow-up using coordinator verifies commands receive savedSocketPath
			await coordinator.followup(job.id, "agent-1", "Next turn instruction");
			expect(observedEnvs.length).toBeGreaterThan(0);
			for (const env of observedEnvs) {
				expect(env.HERDR_SOCKET_PATH).toBe(savedSocketPath);
			}

			// Real stop using coordinator
			observedEnvs.length = 0;
			await coordinator.stop(job.id);
			for (const env of observedEnvs) {
				expect(env.HERDR_SOCKET_PATH).toBe(savedSocketPath);
			}

			// Managed negative control:
			// Managed backend must strip HERDR_SOCKET_PATH so ambient env does not leak
			const managedEnvs: NodeJS.ProcessEnv[] = [];
			const managedRun = vi.fn(async (_exe: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
				managedEnvs.push({ ...(opts?.env ?? {}) });
				return { code: 0, reason: "exited" as const, stdout: JSON.stringify({ result: {} }), stderr: "" };
			});
			const managedBackend = new HerdrBackend({
				executable: "herdr",
				session: "isolated-session",
				run: managedRun,
			});
			await managedBackend.closeWorkspace("w-isolated");
			expect(managedEnvs.length).toBeGreaterThan(0);
			expect(managedEnvs[0].HERDR_SOCKET_PATH).toBeUndefined();
		} finally {
			process.env = originalEnv;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fire_task accepts unambiguous per-agent tasks when top-level task is omitted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-fire-task-"));
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);

		let tool: ToolDefinition | undefined;
		const api = {
			registerTool: (t: ToolDefinition) => {
				tool = t;
			},
			registerCommand: vi.fn(),
			on: vi.fn(),
			getActiveTools: () => ["pi_collaboration"],
			getThinkingLevel: () => "high",
			getEffectiveResourceProfile: () => ({}),
			reportManagedLane: vi.fn(),
			reportSpawnedUsage: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		const context = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
			ui: { notify: vi.fn(), confirm: vi.fn() },
		} as unknown as ExtensionContext;

		piCollaborationExtension(api, {
			stateDirectory: root,
			backend: async () => backend as unknown as CollaborationBackend,
			launchTurn: async () => {},
			providers: new NativeProviderRegistry(
				vi.fn(async () => ({
					code: 0,
					reason: "exited" as const,
					stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
					stderr: "",
				})),
			),
		});

		expect(tool).toBeDefined();

		// Invoke fire_task WITHOUT top-level task, but WITH distinct per-agent tasks
		const result = await tool!.execute(
			"call-1",
			{
				action: "fire_task",
				placement: "managed-workspace",
				agents: [
					{
						provider: "agy",
						name: "builder",
						task: "Implement feature X with focused tests.",
						model: "gemini-3.8-flash-high",
						args: ["--effort", "high"],
					},
					{
						provider: "agy",
						name: "validator",
						task: "Run adversarial validation against feature X.",
						model: "gemini-3.8-flash-high",
						args: ["--effort", "high"],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		// It should succeed, not throw "fire_task requires a task."
		expect(result.isError).toBeFalsy();
		const details = result.details as { job?: CollaborationJob };
		expect(details.job).toBeDefined();
		// Stored/submitted worker prompts contain own task and exclude sibling-only instructions
		expect(details.job?.agents[0].prompt).toContain("Implement feature X with focused tests.");
		expect(details.job?.agents[0].prompt).not.toContain("Run adversarial validation against feature X.");
		expect(details.job?.agents[1].prompt).toContain("Run adversarial validation against feature X.");
		expect(details.job?.agents[1].prompt).not.toContain("Implement feature X with focused tests.");
		expect(details.job?.agents[0].prompt).toContain("Execute assigned team responsibilities.");
		expect(details.job?.agents[1].prompt).toContain("Execute assigned team responsibilities.");

		// When shared objective is explicitly supplied, preserve it in the prompts
		const sharedResult = await tool!.execute(
			"call-shared",
			{
				action: "fire_task",
				placement: "managed-workspace",
				task: "Release secure production patch",
				agents: [
					{
						provider: "agy",
						name: "builder",
						task: "Implement security fix in auth.ts.",
						model: "gemini-3.8-flash-high",
						args: ["--effort", "high"],
					},
					{
						provider: "agy",
						name: "validator",
						task: "Verify fix against exploit payloads.",
						model: "gemini-3.8-flash-high",
						args: ["--effort", "high"],
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(sharedResult.isError).toBeFalsy();
		const sharedDetails = sharedResult.details as { job?: CollaborationJob };
		expect(sharedDetails.job?.agents[0].prompt).toContain("Team objective:\nRelease secure production patch");
		expect(sharedDetails.job?.agents[0].prompt).toContain("Implement security fix in auth.ts.");
		expect(sharedDetails.job?.agents[0].prompt).not.toContain("Verify fix against exploit payloads.");
		expect(sharedDetails.job?.agents[1].prompt).toContain("Team objective:\nRelease secure production patch");
		expect(sharedDetails.job?.agents[1].prompt).toContain("Verify fix against exploit payloads.");
		expect(sharedDetails.job?.agents[1].prompt).not.toContain("Implement security fix in auth.ts.");

		await rm(root, { recursive: true, force: true });
	});

	it("preserves exact native args for agy with model and effort", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-exact-args-"));
		const originalEnv = { ...process.env };
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w9:pA";
		process.env.HERDR_WORKSPACE_ID = "w9";
		process.env.HERDR_TAB_ID = "w9:tA";
		process.env.HERDR_SOCKET_PATH = "/home/caudev/.config/herdr/herdr.sock";
		process.env.HERDR_BIN_PATH = "/home/caudev/.local/bin/herdr";
		try {
			let tool: ToolDefinition | undefined;
			const api = {
				registerTool: (t: ToolDefinition) => {
					tool = t;
				},
				registerCommand: vi.fn(),
				on: vi.fn(),
				getActiveTools: () => ["pi_collaboration"],
				getThinkingLevel: () => "high",
				getEffectiveResourceProfile: () => ({}),
				reportManagedLane: vi.fn(),
				reportSpawnedUsage: vi.fn(),
				sendMessage: vi.fn(),
			} as unknown as ExtensionAPI;

			const context = {
				cwd: root,
				hasUI: true,
				sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
				ui: { notify: vi.fn(), confirm: vi.fn() },
			} as unknown as ExtensionContext;

			piCollaborationExtension(api, {
				stateDirectory: root,
				backend: async () => createMockBackend().backend as unknown as CollaborationBackend,
				launchTurn: async () => {},
			});

			const result = await tool!.execute(
				"call-plan",
				{
					action: "workspace_plan",
					placement: "current-pane",
					agents: [
						{
							provider: "agy",
							name: "native-specialist",
							model: "gemini-3.8-flash-high",
							args: ["--effort", "high"],
						},
					],
				},
				undefined,
				undefined,
				context,
			);

			expect(result.isError).toBeFalsy();
			const textContent = result.content[0];
			if (textContent.type !== "text") throw new Error("Expected text result");
			const plan = JSON.parse(textContent.text).job as CollaborationJob;
			expect(plan).toBeDefined();
			const agent = plan.agents[0];
			expect(agent.args).toEqual([
				"--effort",
				"high",
				"--model",
				"gemini-3.8-flash-high",
				"--dangerously-skip-permissions",
			]);
		} finally {
			process.env = originalEnv;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("same-agent follow-up reaches same native agent and publishes terminal notification once", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-followup-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);

		const reportedEvents: ManagedLaneEvent[] = [];
		let launchedTurnCount = 0;
		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: (event) => reportedEvents.push(event),
			launchTurn: async () => {
				launchedTurnCount++;
			},
		});

		// 1. Initial launch
		const job = await coordinator.launch(
			{
				id: "job-followup-test",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Followup Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "current-pane",
				socketPath: "/home/caudev/.config/herdr/herdr.sock",
				callerPaneId: "w9:pA",
				callerWorkspaceId: "w9",
				callerTabId: "w9:tA",
				agents: [
					{
						id: "agent-1",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: ["--effort", "high"],
						env: {},
						profile: {
							identity: "profile-1",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
				],
			},
			"Initial task",
		);

		expect(launchedTurnCount).toBe(1);
		const initialAgent = job.agents[0];
		expect(initialAgent.turn).toBe(1);

		// Helper finishes initial turn
		store.finishTurn(job.id, initialAgent.id, initialAgent.turnId, "done", "Initial task done");
		coordinator.refresh();

		// Terminal event reported once for turn 1
		const initialTerminals = reportedEvents.filter((e) => e.phase === "terminal");
		expect(initialTerminals.length).toBe(1);
		expect(initialTerminals[0].dispatchSequence).toBe(1);

		// Subsequent refresh does NOT re-emit terminal
		coordinator.refresh();
		expect(reportedEvents.filter((e) => e.phase === "terminal").length).toBe(1);

		// 2. Follow-up on same agent
		const followupAgent = await coordinator.followup(job.id, initialAgent.id, "Follow-up task");
		expect(followupAgent.turn).toBe(2);
		expect(followupAgent.paneId).toBe(initialAgent.paneId);
		expect(followupAgent.backendName).toBe(initialAgent.backendName);
		expect(launchedTurnCount).toBe(2);

		// Helper finishes turn 2
		store.finishTurn(job.id, followupAgent.id, followupAgent.turnId, "done", "Follow-up done");
		coordinator.refresh();

		// Terminal event reported once for turn 2
		const allTerminals = reportedEvents.filter((e) => e.phase === "terminal");
		expect(allTerminals.length).toBe(2);
		expect(allTerminals[1].dispatchSequence).toBe(2);

		// Another refresh does NOT re-emit
		coordinator.refresh();
		expect(reportedEvents.filter((e) => e.phase === "terminal").length).toBe(2);

		await rm(root, { recursive: true, force: true });
	});

	it("no blind retry on uncertain delivery when follow-up launch fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-no-retry-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);

		let shouldFailTurn = false;
		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {
				if (shouldFailTurn) throw new Error("Connection reset by peer");
			},
		});

		const job = await coordinator.launch(
			{
				id: "job-no-retry",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "No Retry Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "current-pane",
				socketPath: "/home/caudev/.config/herdr/herdr.sock",
				callerPaneId: "w9:pA",
				callerWorkspaceId: "w9",
				callerTabId: "w9:tA",
				agents: [
					{
						id: "agent-1",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: ["--effort", "high"],
						env: {},
						profile: {
							identity: "profile-1",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
				],
			},
			"Initial task",
		);

		// Finish initial turn
		store.finishTurn(job.id, job.agents[0].id, job.agents[0].turnId, "done", "Done");
		coordinator.refresh();

		// Now make follow-up launch fail
		shouldFailTurn = true;
		await expect(coordinator.followup(job.id, "agent-1", "Failing task")).rejects.toThrow("Connection reset by peer");

		// Agent must be stopped with failure, not left running or automatically retried
		const updated = store.load(job.id).agents[0];
		expect(updated.status).toBe("failed");
		expect(updated.evidence).toContain("delivery is uncertain and will not be replayed");

		await rm(root, { recursive: true, force: true });
	});

	it("stop_session on shared binding operates on owned job panes without destroying server", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-herdr-stop-session-"));
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend, panes } = createMockBackend([callerPane]);

		let tool: ToolDefinition | undefined;
		const api = {
			registerTool: (t: ToolDefinition) => {
				tool = t;
			},
			registerCommand: vi.fn(),
			on: vi.fn(),
			getActiveTools: () => ["pi_collaboration"],
			getThinkingLevel: () => "high",
			getEffectiveResourceProfile: () => ({}),
			reportManagedLane: vi.fn(),
			reportSpawnedUsage: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		const context = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
			ui: { notify: vi.fn(), confirm: vi.fn() },
		} as unknown as ExtensionContext;

		piCollaborationExtension(api, {
			stateDirectory: root,
			backend: async () => backend as unknown as CollaborationBackend,
			launchTurn: async () => {},
			providers: new NativeProviderRegistry(
				vi.fn(async () => ({
					code: 0,
					reason: "exited" as const,
					stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
					stderr: "",
				})),
			),
		});

		// Launch in current-pane
		const originalEnv = { ...process.env };
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "w9:pA";
		process.env.HERDR_WORKSPACE_ID = "w9";
		process.env.HERDR_TAB_ID = "w9:tA";
		process.env.HERDR_SOCKET_PATH = "/home/caudev/.config/herdr/herdr.sock";
		process.env.HERDR_BIN_PATH = "/home/caudev/.local/bin/herdr";

		try {
			const launchedResult = await tool!.execute(
				"launch-call",
				{
					action: "launch_workspace",
					placement: "current-pane",
					agents: [
						{
							provider: "agy",
							name: "worker",
							args: ["--effort", "high"],
						},
					],
				},
				undefined,
				undefined,
				context,
			);

			const job = (launchedResult.details as { job?: CollaborationJob })?.job;
			expect(job).toBeDefined();
			expect(job?.placement).toBe("current-pane");
			const agentPaneId = job!.agents[0].paneId;
			expect(typeof agentPaneId).toBe("string");
			expect(panes.has(agentPaneId!)).toBe(true);

			// Call stop_session without magic confirm token
			const stopResult = await tool!.execute(
				"stop-call",
				{
					action: "stop_session",
					jobId: job!.id,
				},
				undefined,
				undefined,
				context,
			);

			expect(stopResult.isError).toBeFalsy();
			// Agent pane is closed
			expect(backend.closePane).toHaveBeenCalledWith(agentPaneId);
			// Server stop is NEVER called on shared session
			expect(backend.stopSession).not.toHaveBeenCalled();
			// Caller pane is still present
			expect(panes.has("w9:pA")).toBe(true);
		} finally {
			process.env = originalEnv;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers from transient false terminal (idle without report while working) and completes on settled report", async () => {
		let currentStatus = "idle";
		let currentSeq = 11;
		let reportClaim: CollaborationResultClaim | undefined;
		let eventListener: ((event: CollaborationEvent) => void) | undefined;
		let reportListener: (() => void) | undefined;

		const backend = createStubBackend({
			session: "shared",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 11,
				revision: 20,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: currentStatus as CollaborationAgent["status"],
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: currentSeq,
				revision: 24,
			})),
			readAgent: vi.fn(async () => ({
				paneId: "pane-1",
				text: "final bash output\nReport submitted successfully.",
				truncated: false,
				revision: 0,
			})),
			subscribeEvents: vi.fn(async (_paneId, listener) => {
				eventListener = listener;
				return () => {
					eventListener = undefined;
				};
			}),
		});

		const turnPromise = executeCollaborationTurn(
			backend,
			{
				target: "pi-autonomy",
				terminalId: "term-1",
				turnId: "turn-abc",
				reportCommand: "pi-collaboration-peer",
				text: "Perform active Read/Bash operations",
				timeoutMs: 5000,
			},
			undefined,
			undefined,
			() => reportClaim,
			undefined,
			(listener) => {
				reportListener = listener;
				return () => {
					reportListener = undefined;
				};
			},
		);

		// Allow turnPromise to finish prompt and register event/report listeners
		await Promise.resolve();
		await Promise.resolve();

		// At this point, prompt returned idle, but no report was submitted.
		// Agent transitioned to working (seq 23, active Read/Bash).
		currentStatus = "working";
		currentSeq = 23;
		eventListener?.({ type: "agent_status_changed", paneId: "pane-1", status: "working" });
		await Promise.resolve();
		await Promise.resolve();

		// Verify that prompt was called only ONCE (no automatic resubmission on early idle)
		expect(backend.prompt).toHaveBeenCalledTimes(1);

		// Now agent writes final report
		reportClaim = {
			turnId: "turn-abc",
			status: "done",
			evidence: "All implementation edits and tests verified.",
		};
		reportListener?.();
		await Promise.resolve();
		await Promise.resolve();

		// Agent finishes and settles to idle at seq 25
		currentStatus = "idle";
		currentSeq = 25;
		eventListener?.({ type: "agent_status_changed", paneId: "pane-1", status: "idle" });

		// Turn helper completes with verified report!
		const result = await turnPromise;
		expect(result.status).toBe("done");
		expect(result.evidence).toBe("All implementation edits and tests verified.");
		expect(backend.prompt).toHaveBeenCalledTimes(1);
	});

	it("watchdog times out when early idle receives no authenticated report before deadline", async () => {
		const backend = createStubBackend({
			session: "shared",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 11,
				revision: 20,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: "working" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 12,
				revision: 21,
			})),
			subscribeEvents: vi.fn(async () => () => {}),
		});

		await expect(
			executeCollaborationTurn(
				backend,
				{
					target: "pi-autonomy",
					terminalId: "term-1",
					turnId: "turn-abc",
					reportCommand: "pi-collaboration-peer",
					text: "Do something",
					timeoutMs: 50,
				},
				undefined,
				undefined,
				() => undefined,
				undefined,
				() => () => {},
			),
		).rejects.toThrow(/timed out.*waiting for authenticated final report/);
	});

	it("HerdrBackend constructor requires explicit valid binding and does not infer shared from missing session", () => {
		expect(() => new HerdrBackend({ executable: "herdr" })).toThrow(
			"An explicit named Herdr session is required for an isolated backend.",
		);
		expect(() => new HerdrBackend({ executable: "herdr", shared: true })).toThrow(
			"A valid socket path is required for a shared Herdr backend.",
		);
		const shared = new HerdrBackend({ executable: "herdr", shared: true, socketPath: "/tmp/herdr.sock" });
		expect(shared.shared).toBe(true);
		expect(shared.session).toBe("");
		const isolated = new HerdrBackend({ executable: "herdr", session: "isolated-session" });
		expect(isolated.shared).toBe(false);
		expect(isolated.session).toBe("isolated-session");
	});

	it("isSupportedHerdrProtocol and resolveCollaborationBackend accept protocols 20 and 22, and reject unsupported", async () => {
		// Pinned managed 20
		expect(isSupportedHerdrProtocol({ protocol: 20 })).toBe(true);
		// Installed live 22 with capabilities
		expect(
			isSupportedHerdrProtocol({
				type: "pong",
				version: "0.9.0",
				protocol: 22,
				capabilities: {
					live_handoff: true,
					detached_server_daemon: true,
					endpoint_protocol_generation: 1,
					surface_interest: true,
					health_check: true,
				},
			}),
		).toBe(true);
		// Unsupported
		expect(isSupportedHerdrProtocol({ protocol: 19 })).toBe(false);
		expect(isSupportedHerdrProtocol({ protocol: 21 })).toBe(false);
		expect(isSupportedHerdrProtocol({ protocol: 23 })).toBe(false);
		expect(isSupportedHerdrProtocol({ protocol: 99 })).toBe(false);
		expect(isSupportedHerdrProtocol(null)).toBe(false);
		expect(isSupportedHerdrProtocol({})).toBe(false);

		const job = createStubJob({
			id: "job-proto",
			placement: "current-pane",
			socketPath: "/tmp/test.sock",
			binPath: "/saved/herdr",
			sessionName: "shared",
		});

		// 22 succeeds
		const b22 = await resolveCollaborationBackend(job, {
			connect: vi.fn(async () => ({
				request: vi.fn(async () => ({
					type: "pong",
					version: "0.9.0",
					protocol: 22,
					capabilities: { live_handoff: true },
				})),
				onEvent: vi.fn(() => () => {}),
				close: vi.fn(),
			})),
		});
		expect(b22.id).toBe("herdr");

		// 20 succeeds
		const b20 = await resolveCollaborationBackend(job, {
			connect: vi.fn(async () => ({
				request: vi.fn(async () => ({ protocol: 20 })),
				onEvent: vi.fn(() => () => {}),
				close: vi.fn(),
			})),
		});
		expect(b20.id).toBe("herdr");

		// 99 fails
		await expect(
			resolveCollaborationBackend(job, {
				connect: vi.fn(async () => ({
					request: vi.fn(async () => ({ protocol: 99 })),
					onEvent: vi.fn(() => () => {}),
					close: vi.fn(),
				})),
			}),
		).rejects.toThrow("The installed Herdr server does not expose the supported collaboration protocol.");
	});

	it("preserves validated HERDR_BIN_PATH with saved job and avoids routing managed binary to live server", async () => {
		const customBin = "/home/caudev/.local/bin/herdr";
		const caller = detectHerdrCallerContext({
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w9:pA",
			HERDR_WORKSPACE_ID: "w9",
			HERDR_TAB_ID: "w9:tA",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
			HERDR_BIN_PATH: customBin,
		});
		expect(caller?.binPath).toBe(customBin);

		const job = createStubJob({
			id: "job-bin-test",
			placement: "current-pane",
			socketPath: "/tmp/herdr.sock",
			binPath: customBin,
			sessionName: "shared",
		});

		const runs: string[] = [];
		const backend = await resolveCollaborationBackend(job, {
			run: vi.fn(async (exe) => {
				runs.push(exe);
				return {
					code: 0,
					reason: "exited" as const,
					stdout: JSON.stringify({ result: { type: "notification_show" } }),
					stderr: "",
				};
			}),
			connect: vi.fn(async () => ({
				request: vi.fn(async () => ({ protocol: 22 })),
				onEvent: vi.fn(() => () => {}),
				close: vi.fn(),
			})),
		});

		await backend.notify("Title", "Body");
		expect(runs.length).toBeGreaterThan(0);
		expect(runs[0]).toBe(customBin);
	});

	it("validates caller terminal identity on initial getPane admission and rejects if terminal handle changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-caller-term-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller-initial",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);
		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {},
		});

		const job = await coordinator.launch({
			id: "job-caller-term",
			parentSessionId: "parent",
			sessionName: "shared",
			cwd: root,
			title: "Caller Term Job",
			createdAt: Date.now(),
			deadlineSeconds: 1200,
			placement: "current-pane",
			callerPaneId: "w9:pA",
			callerWorkspaceId: "w9",
			callerTabId: "w9:tA",
			agents: [
				{
					id: "a1",
					name: "w1",
					provider: "agy",
					cwd: root,
					args: [],
					env: {},
					profile: {
						identity: "p1",
						allowedTools: ["bash"],
						writePaths: [],
						parentPid: process.pid,
						parentSession: "parent",
					},
				},
			],
		});

		expect(job.callerTerminalId).toBe("term-caller-initial");

		backend.getPane = vi.fn(async () => ({
			paneId: "w9:pA",
			terminalId: "term-caller-replaced",
			workspaceId: "w9",
			tabId: "w9:tA",
		}));

		await expect(
			coordinator.launch({
				...job,
				id: "job-caller-term-2",
				callerTerminalId: "term-caller-initial",
			}),
		).rejects.toThrow("Caller terminal handle changed; refusing to mutate shared session.");

		await rm(root, { recursive: true, force: true });
	});

	it("cleans up pre-name shells through getPane terminal fence and retains uncertain state on close failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-prename-shell-"));
		const store = new CollaborationJobStore(root, "parent");
		const callerPane: CollaborationPane = {
			paneId: "w9:pA",
			terminalId: "term-caller",
			workspaceId: "w9",
			tabId: "w9:tA",
		};
		const { backend } = createMockBackend([callerPane]);

		backend.startAgent = vi.fn(async () => {
			throw new Error("startAgent failed before registering name");
		});

		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend as unknown as CollaborationBackend,
			report: () => {},
			launchTurn: async () => {},
		});

		await expect(
			coordinator.launch({
				id: "job-prename",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Prename Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "current-pane",
				callerPaneId: "w9:pA",
				callerWorkspaceId: "w9",
				callerTabId: "w9:tA",
				agents: [
					{
						id: "a1",
						name: "w1",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						profile: {
							identity: "p1",
							allowedTools: ["bash"],
							writePaths: [],
							parentPid: process.pid,
							parentSession: "parent",
						},
					},
				],
			}),
		).rejects.toThrow("startAgent failed before registering name");

		expect(backend.getPane).toHaveBeenCalled();
		expect(backend.closePane).toHaveBeenCalled();

		await rm(root, { recursive: true, force: true });
	});

	it("report-before-stop: waits until occupant settles out of working even when claim already exists", async () => {
		let currentStatus: CollaborationAgent["status"] = "working";
		let listener: ((event: CollaborationEvent) => void) | undefined;
		const backend = createStubBackend({
			id: "herdr",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 10,
				revision: 10,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "pi-autonomy",
				status: currentStatus,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: currentStatus === "working" ? 11 : 12,
				revision: currentStatus === "working" ? 11 : 12,
			})),
			readAgent: vi.fn(async () => ({
				paneId: "pane-1",
				text: "Finished work output",
				truncated: false,
				revision: 12,
			})),
			subscribeEvents: vi.fn(async (_paneId, fn) => {
				listener = fn;
				return () => {};
			}),
		});

		const claim = {
			turnId: "turn-rbs",
			status: "done" as const,
			evidence: "Work completed early",
		};

		const turnPromise = executeCollaborationTurn(
			backend,
			{
				target: "pi-autonomy",
				terminalId: "term-1",
				turnId: "turn-rbs",
				reportCommand: "pi-collab",
				text: "Do work",
				timeoutMs: 1000,
			},
			undefined,
			undefined,
			() => claim,
			undefined,
			() => () => {},
		);

		// While currentStatus is "working", the turn must not resolve yet
		await Promise.resolve();
		await Promise.resolve();
		expect(backend.readAgent).not.toHaveBeenCalled();

		// Now the agent settles to idle
		currentStatus = "idle";
		listener?.({ type: "agent_status_changed", status: "idle" });

		const result = await turnPromise;
		expect(result).toMatchObject({ status: "done", evidence: "Work completed early" });
		expect(backend.readAgent).toHaveBeenCalledTimes(1);
	});

	it("blocked-without-report: settles immediately at native blocked boundary without waiting for deadline", async () => {
		const backend = createStubBackend({
			id: "herdr",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agy-agent",
				status: "blocked" as const,
				question: "Grant permission to run bash?",
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 10,
				revision: 10,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agy-agent",
				status: "blocked" as const,
				question: "Grant permission to run bash?",
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 10,
				revision: 10,
			})),
			readAgent: vi.fn(async () => ({
				paneId: "pane-1",
				text: "Do you approve running bash command?",
				truncated: false,
				revision: 10,
			})),
			subscribeEvents: vi.fn(async () => () => {}),
		});

		// No claim exists; native agent is blocked asking a question
		const result = await executeCollaborationTurn(
			backend,
			{
				target: "agy-agent",
				terminalId: "term-1",
				turnId: "turn-bwr",
				reportCommand: "pi-collab",
				text: "Run task",
				timeoutMs: 1000,
			},
			undefined,
			undefined,
			() => undefined,
			undefined,
			() => () => {},
		);

		expect(result.status).toBe("blocked");
		expect(result.evidence).toContain("Grant permission to run bash?");
	});

	it("late subscription: abort before subscribeEvents resolves immediately unsubscribes when resolved", async () => {
		const controller = new AbortController();
		let resolveSub!: (unsub: () => void) => void;
		const unsubSpy = vi.fn();
		const backend = createStubBackend({
			id: "herdr",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agent-late",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 1,
				revision: 1,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agent-late",
				status: "working" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 2,
				revision: 2,
			})),
			subscribeEvents: vi.fn(
				() =>
					new Promise<() => void>((resolve) => {
						resolveSub = resolve;
					}),
			),
		});

		const promise = executeCollaborationTurn(
			backend,
			{
				target: "agent-late",
				terminalId: "term-1",
				turnId: "turn-late",
				reportCommand: "pi-collab",
				text: "Task",
				timeoutMs: 1000,
			},
			controller.signal,
			undefined,
			() => undefined,
			undefined,
			() => () => {},
		);

		// Allow prompt() to resolve and waitForTurnSettlement to call subscribeEvents
		await new Promise((r) => setTimeout(r, 10));
		expect(backend.subscribeEvents).toHaveBeenCalled();

		// Abort while subscription is still resolving
		controller.abort();
		await expect(promise).rejects.toThrow();

		// Now subscription finishes late; it must unsubscribe immediately
		resolveSub(unsubSpy);
		await Promise.resolve();
		expect(unsubSpy).toHaveBeenCalledTimes(1);
	});

	it("rapid idle-working-idle: continues waiting across premature idle and intermediate working until final settlement", async () => {
		let currentStatus: CollaborationAgent["status"] = "idle";
		let hasClaim = false;
		let listener: ((event: CollaborationEvent) => void) | undefined;
		const backend = createStubBackend({
			id: "herdr",
			prompt: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agent-rapid",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 11,
				revision: 20,
			})),
			getAgent: vi.fn(async () => ({
				paneId: "pane-1",
				terminalId: "term-1",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: "agent-rapid",
				status: currentStatus,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: currentStatus === "idle" ? (hasClaim ? 25 : 11) : 23,
				revision: currentStatus === "idle" ? (hasClaim ? 25 : 20) : 23,
			})),
			readAgent: vi.fn(async () => ({
				paneId: "pane-1",
				text: "Settled work output",
				truncated: false,
				revision: 25,
			})),
			subscribeEvents: vi.fn(async (_paneId, fn) => {
				listener = fn;
				return () => {};
			}),
		});

		const turnPromise = executeCollaborationTurn(
			backend,
			{
				target: "agent-rapid",
				terminalId: "term-1",
				turnId: "turn-rapid",
				reportCommand: "pi-collab",
				text: "Task",
				timeoutMs: 1000,
			},
			undefined,
			undefined,
			() => (hasClaim ? { turnId: "turn-rapid", status: "done" as const, evidence: "Final report" } : undefined),
			undefined,
			() => () => {},
		);

		// Agent was at premature idle seq11; then quickly flips to working seq23
		currentStatus = "working";
		listener?.({ type: "agent_status_changed", status: "working" });
		await Promise.resolve();
		expect(backend.readAgent).not.toHaveBeenCalled();

		// Agent finishes, writes report, and settles to idle seq25
		hasClaim = true;
		currentStatus = "idle";
		listener?.({ type: "agent_status_changed", status: "idle" });

		const result = await turnPromise;
		expect(result).toMatchObject({ status: "done", evidence: "Final report" });
	});

	it("AGY steering: followup on running AGY agent sends esc to interrupt, but does not send esc for stopped or non-AGY", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agy-steer-"));
		const store = new CollaborationJobStore(root, "parent");
		const sendKeys = vi.fn(async () => {});
		let agyLiveStatus: CollaborationAgent["status"] = "working";

		const backend = createStubBackend({
			id: "herdr",
			getAgent: vi.fn(async (target: string) => ({
				paneId: target === "builder" ? "pane-agy" : "pane-pi",
				terminalId: target === "builder" ? "term-agy" : "term-pi",
				workspaceId: "w9",
				tabId: "w9:tA",
				name: target,
				status: target === "builder" ? agyLiveStatus : "working",
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 1,
				revision: 1,
			})),
			sendKeys,
		});

		const coordinator = new CollaborationCoordinator({
			store,
			backend: async () => backend,
			report: () => {},
			launchTurn: vi.fn(async () => {}),
		});

		const job = store.create({
			id: "job-agy-steer",
			parentSessionId: "parent",
			sessionName: "shared",
			cwd: root,
			title: "AGY Steer Job",
			createdAt: Date.now(),
			deadlineSeconds: 1200,
			placement: "current-pane",
			callerPaneId: "w9:pA",
			callerWorkspaceId: "w9",
			callerTabId: "w9:tA",
			agents: [
				{
					id: "a1",
					name: "builder",
					provider: "agy",
					cwd: root,
					args: [],
					env: {},
					profile: {
						identity: "prof-1",
						allowedTools: ["bash"],
						writePaths: [],
					},
				},
				{
					id: "a2",
					name: "coder",
					provider: "pi",
					cwd: root,
					args: [],
					env: {},
					profile: {
						identity: "prof-2",
						allowedTools: ["bash"],
						writePaths: [],
					},
				},
			],
		});

		store.update(job.id, (current) => {
			current.agents[0].paneId = "pane-agy";
			current.agents[0].backendName = "builder";
			current.agents[0].terminalId = "term-agy";

			current.agents[1].paneId = "pane-pi";
			current.agents[1].backendName = "coder";
			current.agents[1].terminalId = "term-pi";
			current.agents[1].status = "idle";
		});

		const initialTurn = store.reserveTurn(job.id, "a1", "Initial task");
		store.claimTurn(job.id, "a1", initialTurn.turnId, 12345);

		// 1. Running AGY agent: followup sends esc and waits for idle ready boundary
		let eventCallback: ((event: CollaborationEvent) => void) | undefined;
		backend.subscribeEvents = vi.fn(async (_paneId: string, cb: (event: CollaborationEvent) => void) => {
			eventCallback = cb;
			return () => {
				eventCallback = undefined;
			};
		});
		agyLiveStatus = "working";
		const followupPromise = coordinator.followup(job.id, "a1", "New instruction for running agy");
		await vi.waitFor(() => expect(sendKeys).toHaveBeenCalledWith("builder", ["esc"]));

		// While still working, followup is awaiting ready boundary
		expect(store.load(job.id).agents[0].turn).toBe(1);

		// Agent transitions to idle after interrupt
		agyLiveStatus = "idle";
		eventCallback?.({ type: "agent_status_changed", paneId: "pane-agy", status: "idle" });
		await followupPromise;
		expect(store.load(job.id).agents[0].turn).toBe(2);

		// 2. Queued-vs-steer intent: followup with steer: false rejects active work
		sendKeys.mockClear();
		store.claimTurn(job.id, "a1", store.load(job.id).agents[0].turnId, 12346);
		agyLiveStatus = "working";
		await expect(
			coordinator.followup(job.id, "a1", "Queued instruction without interrupt", undefined, { steer: false }),
		).rejects.toThrow("Cannot queue follow-up to running agent without steering interrupt");
		expect(sendKeys).not.toHaveBeenCalled();

		// 3. Stopped AGY agent: followup does not send esc
		sendKeys.mockClear();
		store.finishTurn(job.id, "a1", store.load(job.id).agents[0].turnId, "stopped", "Turn completed");
		agyLiveStatus = "idle";
		await coordinator.followup(job.id, "a1", "Instruction for stopped agy");
		expect(sendKeys).not.toHaveBeenCalled();

		// 4. Non-AGY running agent (e.g. pi): followup does not send esc and rejects steering
		sendKeys.mockClear();
		const piTurn = store.reserveTurn(job.id, "a2", "Task for pi");
		store.claimTurn(job.id, "a2", piTurn.turnId, 12347);
		await expect(coordinator.followup(job.id, "a2", "Instruction for pi agent")).rejects.toThrow(
			'Cannot steer running agent for provider "pi"',
		);
		expect(sendKeys).not.toHaveBeenCalled();

		// 5. Untracked native work: native is working while store agent is idle
		store.finishTurn(job.id, "a1", store.load(job.id).agents[0].turnId, "stopped", "Settled");
		store.update(job.id, (current) => {
			current.agents[0].status = "idle";
		});
		agyLiveStatus = "working";
		sendKeys.mockClear();
		await expect(coordinator.followup(job.id, "a1", "Followup on untracked work")).rejects.toThrow(
			"refusing to interrupt untracked work",
		);
		expect(sendKeys).not.toHaveBeenCalled();

		// 6. Mismatched occupant: throws before follow-up
		store.update(job.id, (current) => {
			current.agents[0].status = "idle";
		});
		agyLiveStatus = "idle";
		backend.getAgent = vi.fn(async () => ({
			paneId: "pane-agy",
			terminalId: "term-different",
			workspaceId: "w9",
			tabId: "w9:tA",
			name: "builder",
			status: "idle" as const,
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		}));
		store.update(job.id, (current) => {
			current.agents[0].status = "idle";
		});
		await expect(coordinator.followup(job.id, "a1", "Instruction with changed occupant")).rejects.toThrow(
			"Collaboration pane occupant changed before follow-up.",
		);

		await rm(root, { recursive: true, force: true });
	});

	it("subscribeEvents supplies fallback AbortSignal and cleans up connection on subscription failure", async () => {
		let capturedSignal: AbortSignal | undefined;
		const closeSpy = vi.fn();
		const mockConnect = vi.fn(async (_path: string, signal: AbortSignal) => {
			capturedSignal = signal;
			return {
				request: vi.fn(async (method: string) => {
					if (method === "events.subscribe") {
						throw new Error("Subscription rejected by daemon");
					}
					return {};
				}),
				onEvent: vi.fn(() => () => {}),
				close: closeSpy,
			};
		});

		const backend = new HerdrBackend({
			executable: "herdr",
			session: "isolated-session",
			socketPath: "/tmp/mock.sock",
			connect: mockConnect,
		});

		// Call without passing a signal (tests fallback AbortSignal)
		await expect(backend.subscribeEvents("p1", () => {})).rejects.toThrow("Subscription rejected by daemon");
		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(false);
		// Verified that connection was closed on subscription failure
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	it("waitForTurnSettlement rejects immediately on getAgent error without deadline hang", async () => {
		const backend = createStubBackend({
			id: "herdr",
			prompt: vi.fn(async () => ({
				paneId: "pane-err",
				terminalId: "term-err",
				workspaceId: "w1",
				tabId: "t1",
				status: "idle" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 1,
				revision: 1,
			})),
			getAgent: vi.fn(async () => {
				throw new Error("Socket connection closed abruptly");
			}),
			subscribeEvents: vi.fn(async () => () => {}),
		});

		const turnPromise = executeCollaborationTurn(
			backend,
			{
				target: "agent-err",
				terminalId: "term-err",
				turnId: "turn-err",
				reportCommand: "pi-collab",
				text: "Task",
				timeoutMs: 10000,
			},
			undefined,
			undefined,
			() => undefined,
			undefined,
			() => () => {},
		);

		await expect(turnPromise).rejects.toThrow("Socket connection closed abruptly");
	});

	it("valid steering emits exactly one old terminal BEFORE successor dispatch; throwing report callback retains old evidence/intent, retry succeeds with totalEsc1, terminalPublishAttempts2, successorLaunches1", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-steer-handoff-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-handoff",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Handoff Job",
				createdAt: Date.now(),
				deadlineSeconds: 30,
				agents: [
					{
						id: "a1",
						name: "builder",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "p1",
						terminalId: "term1",
						backendName: "builder",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});
			const turn = store.reserveTurn(job.id, "a1", "Original task");
			store.claimTurn(job.id, "a1", turn.turnId, 12345);

			let liveState: CollaborationAgent = {
				paneId: "p1",
				terminalId: "term1",
				workspaceId: "w1",
				tabId: "t1",
				name: "builder",
				kind: "agy",
				status: "working",
				interactiveReady: true,
				launchPending: false,
				revision: 1,
				stateChangeSequence: 1,
			};
			let escapes = 0;
			let launches = 0;
			let terminalPublishAttempts = 0;
			const publishedEvents: ManagedLaneEvent[] = [];
			let shouldThrowOnTerminal = true;

			const backend = createStubBackend({
				id: "herdr",
				session: "shared",
				getAgent: vi.fn(async () => liveState),
				sendKeys: vi.fn(async () => {
					escapes++;
					liveState = { ...liveState, status: "idle", stateChangeSequence: 2 };
				}),
				subscribeEvents: vi.fn(async () => () => {}),
			});

			const coordinator = new CollaborationCoordinator({
				store,
				backend: async () => backend,
				report: (event) => {
					if (event.phase === "terminal") {
						terminalPublishAttempts++;
						if (shouldThrowOnTerminal) {
							throw new Error("Simulated network failure publishing terminal handoff");
						}
						publishedEvents.push(event);
					}
				},
				launchTurn: vi.fn(async () => {
					launches++;
				}),
			});

			// 1. Followup with throwing report callback:
			// commitSteering succeeds, but terminal publication throws.
			// Must NOT call abortSteering; retains stopped state, evidence, and pending steering intent.
			await expect(coordinator.followup(job.id, "a1", "Apply correction")).rejects.toThrow(
				"Simulated network failure publishing terminal handoff",
			);
			expect(escapes).toBe(1);
			expect(launches).toBe(0);
			expect(terminalPublishAttempts).toBe(1);

			const midState = store.load(job.id).agents[0];
			expect(midState.status).toBe("stopped");
			expect(midState.evidence).toBe("Interrupted by user steering.");
			expect(midState.steering).toBeDefined();
			expect(midState.steering?.prompt).toBe("Apply correction");
			expect(midState.notifiedTurn).toBe(0);

			// 2. Retry followup after publication recovery:
			// report succeeds, emits exactly one old terminal, consumes steering intent, launches successor turn.
			// Total Esc must remain 1 (no second Esc sent!).
			shouldThrowOnTerminal = false;
			await coordinator.followup(job.id, "a1", "Apply correction");

			expect(escapes).toBe(1);
			expect(terminalPublishAttempts).toBe(2);
			expect(launches).toBe(1);
			expect(publishedEvents.length).toBe(1);
			expect(publishedEvents[0]).toMatchObject({
				phase: "terminal",
				status: "stopped",
				dispatchSequence: 1,
				summary: "Interrupted by user steering.",
			});

			const finalState = store.load(job.id).agents[0];
			expect(finalState.status).toBe("reserved");
			expect(finalState.turn).toBe(2);
			expect(finalState.steering).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("steering prompt admission: blank, NUL, and peer-expanded overflow reject before Esc, native work remains running", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-steer-admit-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-admit",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Admission Job",
				createdAt: Date.now(),
				deadlineSeconds: 30,
				peerCommand: "pi collaboration-peer",
				agents: [
					{
						id: "a1",
						name: "builder",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "p1",
						terminalId: "term1",
						backendName: "builder",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});
			const turn = store.reserveTurn(job.id, "a1", "Original task");
			store.claimTurn(job.id, "a1", turn.turnId, 12345);

			let escapes = 0;
			const backend = createStubBackend({
				id: "herdr",
				session: "shared",
				getAgent: vi.fn(async () => ({
					paneId: "p1",
					terminalId: "term1",
					workspaceId: "w1",
					tabId: "t1",
					name: "builder",
					status: "working" as const,
					interactiveReady: true,
					launchPending: false,
					stateChangeSequence: 1,
					revision: 1,
				})),
				sendKeys: vi.fn(async () => {
					escapes++;
				}),
				subscribeEvents: vi.fn(async () => () => {}),
			});

			const coordinator = new CollaborationCoordinator({
				store,
				backend: async () => backend,
				report: () => {},
				launchTurn: vi.fn(async () => {}),
			});

			// Blank prompt rejects before Esc
			await expect(coordinator.followup(job.id, "a1", "   ")).rejects.toThrow(
				"Collaboration prompt cannot be blank or empty.",
			);
			expect(escapes).toBe(0);
			expect(store.load(job.id).agents[0].status).toBe("running");

			// NUL prompt rejects before Esc
			await expect(coordinator.followup(job.id, "a1", "bad\0prompt")).rejects.toThrow(
				"Collaboration prompt cannot contain null bytes.",
			);
			expect(escapes).toBe(0);
			expect(store.load(job.id).agents[0].status).toBe("running");

			// Expanded overflow prompt rejects before Esc
			await expect(coordinator.followup(job.id, "a1", "x".repeat(32760))).rejects.toThrow(
				"Collaboration prompt exceeds maximum allowed size",
			);
			expect(escapes).toBe(0);
			expect(store.load(job.id).agents[0].status).toBe("running");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stopping during admitted steering clears steering marker at finishStop, refresh publishes, and archive succeeds", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-steer-stop-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-stop",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Stop Job",
				createdAt: Date.now(),
				deadlineSeconds: 30,
				agents: [
					{
						id: "a1",
						name: "builder",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "p1",
						terminalId: "term1",
						backendName: "builder",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});
			const turn = store.reserveTurn(job.id, "a1", "Original task");
			store.claimTurn(job.id, "a1", turn.turnId, 12345);

			// Admit steering
			store.beginSteering(job.id, "a1", turn.turnId, "Next task");
			expect(store.load(job.id).agents[0].steering).toBeDefined();

			// Stop the agent while steering is admitted
			store.beginStop(job.id, "a1", turn.turnId);
			store.finishStop(job.id, "a1", turn.turnId, "stopped", "Explicitly stopped by user");

			const stoppedAgent = store.load(job.id).agents[0];
			expect(stoppedAgent.status).toBe("stopped");
			expect(stoppedAgent.closed).toBe(true);
			expect(stoppedAgent.steering).toBeUndefined();

			const terminals: Extract<ManagedLaneEvent, { phase: "terminal" }>[] = [];
			const coordinator = new CollaborationCoordinator({
				store,
				backend: async () => createStubBackend(),
				report: (e) => {
					if (e.phase === "terminal") terminals.push(e);
				},
				launchTurn: vi.fn(async () => {}),
			});

			coordinator.refresh();
			expect(terminals.length).toBe(1);
			expect(terminals[0].summary).toContain("Explicitly stopped by user");

			// Archive succeeds without throwing "Cannot archive an active collaboration job"
			expect(() => store.archive(job.id)).not.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("restoration surfaces pending steering as explicit uncertain control state with successor intent", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-steer-restore-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-restore",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Restore Job",
				createdAt: Date.now(),
				deadlineSeconds: 30,
				agents: [
					{
						id: "a1",
						name: "builder",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "p1",
						terminalId: "term1",
						backendName: "builder",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});
			const turn = store.reserveTurn(job.id, "a1", "Original task");
			store.claimTurn(job.id, "a1", turn.turnId, 12345);

			// Admit steering intent
			store.beginSteering(job.id, "a1", turn.turnId, "Pending successor correction");

			const backend = createStubBackend({
				listAgents: vi.fn(async () => [
					{
						paneId: "p1",
						terminalId: "term1",
						workspaceId: "w1",
						tabId: "t1",
						name: "builder",
						kind: "agy",
						status: "working" as const,
						interactiveReady: true,
						launchPending: false,
						stateChangeSequence: 1,
						revision: 1,
					},
				]),
			});

			let publishedFailure: string | undefined;
			await reconcileCollaborationSessions(
				store,
				async () => backend,
				(_jobId, _identity, error) => {
					publishedFailure = error;
				},
				() => true,
			);

			expect(publishedFailure).toBeDefined();
			expect(publishedFailure).toContain("pending steering");
			expect(publishedFailure).toContain("Pending successor correction");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("simultaneous followups reject second followup before sending second Esc", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-simultaneous-steer-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-simul",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Simul Job",
				createdAt: Date.now(),
				deadlineSeconds: 30,
				agents: [
					{
						id: "a1",
						name: "builder",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "p1",
						terminalId: "term1",
						backendName: "builder",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});
			const turn = store.reserveTurn(job.id, "a1", "Original task");
			store.claimTurn(job.id, "a1", turn.turnId, 12345);

			let escapes = 0;
			let rejectSettlement!: (err: Error) => void;
			const backend = createStubBackend({
				getAgent: vi.fn(async () => ({
					paneId: "p1",
					terminalId: "term1",
					workspaceId: "w1",
					tabId: "t1",
					name: "builder",
					status: "working" as const,
					interactiveReady: true,
					launchPending: false,
					stateChangeSequence: 1,
					revision: 1,
				})),
				sendKeys: vi.fn(async () => {
					escapes++;
				}),
				subscribeEvents: vi.fn(
					() =>
						new Promise<() => void>((_resolve, reject) => {
							rejectSettlement = reject;
						}),
				),
			});

			const coordinator = new CollaborationCoordinator({
				store,
				backend: async () => backend,
				report: () => {},
				launchTurn: vi.fn(async () => {}),
			});

			// First followup starts and is waiting for settlement
			const firstFollowup = coordinator.followup(job.id, "a1", "First steering");
			await vi.waitFor(() => expect(escapes).toBe(1));

			// Second followup must reject immediately without sending Esc
			await expect(coordinator.followup(job.id, "a1", "Second steering")).rejects.toThrow(
				"Collaboration agent steering already in progress; simultaneous steering rejected.",
			);
			expect(escapes).toBe(1);

			// Clean up pending promise
			rejectSettlement(new Error("settlement aborted"));
			await expect(firstFollowup).rejects.toThrow("settlement aborted");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("delayed getAgent cancellation in waitForAgentEventCondition aborts without installing subscriptions", async () => {
		const controller = new AbortController();
		let resolveGetAgent!: (agent: CollaborationAgent) => void;
		const subscribeSpy = vi.fn(async () => () => {});
		const backend = createStubBackend({
			getAgent: vi.fn(
				() =>
					new Promise<CollaborationAgent>((resolve) => {
						resolveGetAgent = resolve;
					}),
			),
			subscribeEvents: subscribeSpy,
		});

		const waitPromise = waitForAgentEventCondition({
			backend,
			target: "builder",
			terminalId: "term1",
			paneId: "p1",
			timeoutMs: 5000,
			signal: controller.signal,
			check: () => ({ settled: false }),
		});

		// Abort while getAgent is awaiting
		controller.abort(new Error("Delayed abort during getAgent"));
		resolveGetAgent({
			paneId: "p1",
			terminalId: "term1",
			workspaceId: "w1",
			tabId: "t1",
			name: "builder",
			status: "working",
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		});

		await expect(waitPromise).rejects.toThrow("Delayed abort during getAgent");
		expect(subscribeSpy).not.toHaveBeenCalled();
	});

	it("subscribeReport synchronous throw cleans up and unsubscribes late subscribeEvents", async () => {
		let resolveSub!: (unsub: () => void) => void;
		const unsubSpy = vi.fn();
		const backend = createStubBackend({
			getAgent: vi.fn(async () => ({
				paneId: "p1",
				terminalId: "term1",
				workspaceId: "w1",
				tabId: "t1",
				name: "builder",
				status: "working" as const,
				interactiveReady: true,
				launchPending: false,
				stateChangeSequence: 1,
				revision: 1,
			})),
			subscribeEvents: vi.fn(
				() =>
					new Promise<() => void>((resolve) => {
						resolveSub = resolve;
					}),
			),
		});

		const waitPromise = waitForAgentEventCondition({
			backend,
			target: "builder",
			terminalId: "term1",
			paneId: "p1",
			timeoutMs: 5000,
			subscribeReport: () => {
				throw new Error("Synchronous throw in subscribeReport");
			},
			check: () => ({ settled: false }),
		});

		await expect(waitPromise).rejects.toThrow("Synchronous throw in subscribeReport");

		// Late subscribeEvents resolution must immediately call unsub
		resolveSub(unsubSpy);
		await Promise.resolve();
		expect(unsubSpy).toHaveBeenCalledTimes(1);
	});

	it("shared placement requires valid caller HERDR_BIN_PATH at admission and persists it without fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-binpath-admission-"));
		try {
			let tool: ToolDefinition | undefined;
			const api = {
				registerTool: (t: ToolDefinition) => {
					tool = t;
				},
				registerCommand: vi.fn(),
				on: vi.fn(),
				getActiveTools: () => ["pi_collaboration"],
				getThinkingLevel: () => "high",
				getEffectiveResourceProfile: () => ({}),
				reportManagedLane: vi.fn(),
				reportSpawnedUsage: vi.fn(),
				sendMessage: vi.fn(),
			} as unknown as ExtensionAPI;

			const context = {
				cwd: root,
				hasUI: true,
				sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
				ui: { notify: vi.fn(), confirm: vi.fn() },
			} as unknown as ExtensionContext;

			piCollaborationExtension(api, {
				stateDirectory: root,
				backend: async () => createMockBackend().backend as unknown as CollaborationBackend,
				launchTurn: async () => {},
				providers: new NativeProviderRegistry(
					vi.fn(async () => ({
						code: 0,
						reason: "exited" as const,
						stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
						stderr: "",
					})),
				),
			});

			const savedEnv = {
				HERDR_ENV: process.env.HERDR_ENV,
				HERDR_PANE_ID: process.env.HERDR_PANE_ID,
				HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
				HERDR_TAB_ID: process.env.HERDR_TAB_ID,
				HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
				HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
			};

			try {
				process.env.HERDR_ENV = "1";
				process.env.HERDR_PANE_ID = "w9:pA";
				process.env.HERDR_WORKSPACE_ID = "w9";
				process.env.HERDR_TAB_ID = "w9:tA";
				process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";

				// Negative 1: Missing HERDR_BIN_PATH
				delete process.env.HERDR_BIN_PATH;
				await expect(
					tool!.execute(
						"call-missing-bin",
						{
							action: "workspace_plan",
							placement: "current-pane",
							agents: [{ provider: "agy", name: "w1", args: ["--effort", "high"] }],
						},
						undefined,
						undefined,
						context,
					),
				).rejects.toThrow("Placement 'current-pane' requires a valid caller executable (HERDR_BIN_PATH).");

				// Negative 2: Relative HERDR_BIN_PATH
				process.env.HERDR_BIN_PATH = "herdr";
				await expect(
					tool!.execute(
						"call-rel-bin",
						{
							action: "workspace_plan",
							placement: "current-pane",
							agents: [{ provider: "agy", name: "w1", args: ["--effort", "high"] }],
						},
						undefined,
						undefined,
						context,
					),
				).rejects.toThrow("Placement 'current-pane' requires a valid caller executable (HERDR_BIN_PATH).");

				// Negative 3: HERDR_BIN_PATH with null byte
				process.env.HERDR_BIN_PATH = "/usr/bin/herdr\0malicious";
				await expect(
					tool!.execute(
						"call-nul-bin",
						{
							action: "workspace_plan",
							placement: "current-pane",
							agents: [{ provider: "agy", name: "w1", args: ["--effort", "high"] }],
						},
						undefined,
						undefined,
						context,
					),
				).rejects.toThrow("Placement 'current-pane' requires a valid caller executable (HERDR_BIN_PATH).");

				// Valid caller control: Absolute HERDR_BIN_PATH succeeds and persists exactly
				const validBin = "/home/caudev/.local/bin/herdr";
				process.env.HERDR_BIN_PATH = validBin;
				const successResult = await tool!.execute(
					"call-valid-bin",
					{
						action: "workspace_plan",
						placement: "current-pane",
						agents: [{ provider: "agy", name: "w1", args: ["--effort", "high"] }],
					},
					undefined,
					undefined,
					context,
				);
				expect(successResult.isError).toBeFalsy();
				const textContent = successResult.content[0];
				if (textContent.type !== "text") throw new Error("Expected text result");
				const plan = JSON.parse(textContent.text).job as CollaborationJob;
				expect(plan.placement).toBe("current-pane");
				expect(plan.binPath).toBe(validBin);

				// Managed workspace unchanged: operates even without HERDR_BIN_PATH
				delete process.env.HERDR_BIN_PATH;
				const managedResult = await tool!.execute(
					"call-managed",
					{
						action: "workspace_plan",
						placement: "managed-workspace",
						agents: [{ provider: "agy", name: "w1", args: ["--effort", "high"] }],
					},
					undefined,
					undefined,
					context,
				);
				expect(managedResult.isError).toBeFalsy();
				const managedText = managedResult.content[0];
				if (managedText.type !== "text") throw new Error("Expected text result");
				const managedPlan = JSON.parse(managedText.text).job as CollaborationJob;
				expect(managedPlan.placement).toBe("managed-workspace");
				expect(managedPlan.binPath).toBeUndefined();
			} finally {
				for (const [key, val] of Object.entries(savedEnv)) {
					if (val === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = val;
					}
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("owned collaboration stop executes without confirmation roundtrip, while dryRun previews with no mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stop-handoff-"));
		try {
			const store = new CollaborationJobStore(root, "parent");
			const job = store.create({
				id: "job-stop-test",
				parentSessionId: "parent",
				sessionName: "shared",
				cwd: root,
				title: "Stop Handoff Job",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "current-pane",
				socketPath: "/tmp/herdr.sock",
				binPath: "/bin/herdr",
				agents: [
					{
						id: "a1",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "pane-worker-1",
						terminalId: "term-1",
						backendName: "worker",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
			});

			const closePaneSpy = vi.fn(async () => {});
			const backend = createStubBackend({
				closePane: closePaneSpy,
				getAgent: vi.fn(async () => ({
					paneId: "pane-worker-1",
					terminalId: "term-1",
					workspaceId: "w1",
					tabId: "t1",
					name: "worker",
					status: "idle" as const,
					interactiveReady: true,
					launchPending: false,
					stateChangeSequence: 1,
					revision: 1,
				})),
			});

			let tool: ToolDefinition | undefined;
			const api = {
				registerTool: (t: ToolDefinition) => {
					tool = t;
				},
				registerCommand: vi.fn(),
				on: vi.fn(),
				getActiveTools: () => ["pi_collaboration"],
				getThinkingLevel: () => "high",
				getEffectiveResourceProfile: () => ({}),
				reportManagedLane: vi.fn(),
				reportSpawnedUsage: vi.fn(),
				sendMessage: vi.fn(),
			} as unknown as ExtensionAPI;

			const context = {
				cwd: root,
				hasUI: true,
				sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
				ui: { notify: vi.fn(), confirm: vi.fn() },
			} as unknown as ExtensionContext;

			piCollaborationExtension(api, {
				stateDirectory: root,
				backend: async () => backend,
				launchTurn: async () => {},
			});

			// 1. dryRun: true previews without mutation
			const dryRunResult = await tool!.execute(
				"call-dry-run",
				{
					action: "stop_job",
					jobId: job.id,
					dryRun: true,
				},
				undefined,
				undefined,
				context,
			);
			expect(dryRunResult.isError).toBeFalsy();
			const textContent = dryRunResult.content[0];
			if (textContent.type !== "text") throw new Error("Expected text result");
			const dryDetails = JSON.parse(textContent.text);
			expect(dryDetails.dryRun).toBe(true);
			expect(dryDetails.jobId).toBe(job.id);
			expect(closePaneSpy).not.toHaveBeenCalled();
			expect(store.load(job.id).agents[0].closed).toBeFalsy();

			// 1b. dryRun: true also previews dismiss without mutation
			const dryDismissResult = await tool!.execute(
				"call-dry-dismiss",
				{
					action: "dismiss",
					jobId: job.id,
					dryRun: true,
				},
				undefined,
				undefined,
				context,
			);
			expect(dryDismissResult.isError).toBeFalsy();
			const dismissContent = dryDismissResult.content[0];
			if (dismissContent.type !== "text") throw new Error("Expected text result");
			const dismissDetails = JSON.parse(dismissContent.text);
			expect(dismissDetails.dryRun).toBe(true);
			expect(dismissDetails.action).toBe("dismiss");
			expect(dismissDetails.jobId).toBe(job.id);
			expect(closePaneSpy).not.toHaveBeenCalled();
			expect(store.load(job.id).dismissed).toBe(false);

			// 2. Direct stop_job without dryRun:false or magic confirm string terminates owned pane immediately
			const directStopResult = await tool!.execute(
				"call-direct-stop",
				{
					action: "stop_job",
					jobId: job.id,
				},
				undefined,
				undefined,
				context,
			);
			expect(directStopResult.isError).toBeFalsy();
			expect(closePaneSpy).toHaveBeenCalledWith("pane-worker-1");
			expect(store.load(job.id).agents[0].closed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stop by title rejects multiple owned jobs with same title instead of find-first", async () => {
		const root = join(tmpdir(), `pi-test-panel-dup-title-${Date.now()}`);
		await mkdir(root, { recursive: true });
		try {
			const store = new CollaborationJobStore(root, "parent-session-1");
			const job1 = store.create({
				id: "job-dup-1",
				parentSessionId: "parent-session-1",
				title: "shared-feature-team",
				sessionName: "shared-feature-session-1",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "managed-workspace",
				socketPath: "/tmp/herdr.sock",
				binPath: "/bin/herdr",
				cwd: root,
				agents: [
					{
						id: "worker",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "pane-1",
						terminalId: "term-1",
						backendName: "worker",
						profile: { identity: "p1", allowedTools: ["bash"], writePaths: [] },
					},
				],
				workspaceId: "ws-dup-1",
			});
			const job2 = store.create({
				id: "job-dup-2",
				parentSessionId: "parent-session-1",
				title: "shared-feature-team",
				sessionName: "shared-feature-session-2",
				createdAt: Date.now(),
				deadlineSeconds: 1200,
				placement: "managed-workspace",
				socketPath: "/tmp/herdr.sock",
				binPath: "/bin/herdr",
				cwd: root,
				agents: [
					{
						id: "worker",
						name: "worker",
						provider: "agy",
						cwd: root,
						args: [],
						env: {},
						paneId: "pane-2",
						terminalId: "term-2",
						backendName: "worker",
						profile: { identity: "p2", allowedTools: ["bash"], writePaths: [] },
					},
				],
				workspaceId: "ws-dup-2",
			});

			const closePaneSpy = vi.fn(async () => {});
			const mockBackend = createStubBackend({ closePane: closePaneSpy });

			let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
			const mockPi: ExtensionAPI = {
				registerTool: (def: any) => {
					tool = def;
				},
				registerCommand: () => {},
				on: () => {},
				getEffectiveResourceProfile: () => undefined,
				getActiveTools: () => [],
				getThinkingLevel: () => undefined,
			} as unknown as ExtensionAPI;

			const context: ExtensionContext = {
				sessionManager: { getSessionId: () => "parent-session-1" } as any,
				ui: { notify: () => {} } as any,
			} as unknown as ExtensionContext;

			piCollaborationExtension(mockPi, {
				stateDirectory: root,
				backend: async () => mockBackend,
				launchTurn: async () => {},
			});

			await expect(
				tool!.execute(
					"call-stop-dup",
					{
						action: "stop_job",
						title: "shared-feature-team",
					},
					undefined,
					undefined,
					context,
				),
			).rejects.toThrow('Multiple owned collaboration jobs match "shared-feature-team". Specify an exact jobId.');

			expect(closePaneSpy).not.toHaveBeenCalled();
			expect(store.load(job1.id).agents[0].closed).toBeFalsy();
			expect(store.load(job2.id).agents[0].closed).toBeFalsy();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
