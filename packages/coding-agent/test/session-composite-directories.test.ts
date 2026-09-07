import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationDetails } from "../src/core/image-generation.ts";
import type { ScoutControllerDeps, ScoutRunResult } from "../src/core/scout-controller.ts";
import type { executeToolkitScript } from "../src/core/toolkit/script-runner.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const probes = vi.hoisted(() => ({
	toolkit: vi.fn<typeof executeToolkitScript>(),
	scout: vi.fn<(deps: ScoutControllerDeps) => Promise<ScoutRunResult>>(),
	image: vi.fn<(cwd: string) => Promise<AgentToolResult<ImageGenerationDetails>>>(),
}));
vi.mock("../src/core/toolkit/script-runner.ts", () => ({ executeToolkitScript: probes.toolkit }));
vi.mock("../src/core/scout-controller.ts", () => ({
	ScoutController: class {
		private readonly deps: ScoutControllerDeps;
		constructor(deps: ScoutControllerDeps) {
			this.deps = deps;
		}
		run() {
			return probes.scout(this.deps);
		}
	},
}));
vi.mock("../src/core/image-generation.ts", () => ({
	ImageGenerationController: class {
		private readonly cwd: string;
		constructor(cwd: string) {
			this.cwd = cwd;
		}
		generate() {
			return probes.image(this.cwd);
		}
	},
}));

async function selectProject(harness: Harness): Promise<string> {
	const project = join(harness.tempDir, "selected project 日本語");
	mkdirSync(project);
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("task_directory", { action: "register", workspaceId: "project", path: project })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "project" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Selected"),
	]);
	await harness.session.prompt("Select the synthetic project directory.");
	expect(
		harness.session.agent.state.messages
			.filter((message) => message.role === "toolResult" && message.isError)
			.map(getMessageText),
	).toEqual([]);
	return project;
}

describe("composite tools consume admitted task context", () => {
	afterEach(() => vi.clearAllMocks());

	it.each(["run_toolkit_script", "context_scout"] as const)(
		"%s retains its directory lease through cancellation and rejects pre-cancelled admission",
		async (name) => {
			const harness = await createHarness({
				initialActiveToolNames: ["task_directory", name],
				settings: {
					modelCapability: { mode: "off" },
					scout: { enabled: true },
					toolkit: {
						scripts: [
							{ name: "fixture", description: "Synthetic operation", runner: "bash", path: "fixture.sh" },
						],
					},
				},
			});
			const project = await selectProject(harness);
			const started = Promise.withResolvers<void>();
			const finished = Promise.withResolvers<void>();
			const cancelled = Promise.withResolvers<void>();
			const abort = new AbortController();
			const waitForCancellation = async (cwd: string, signal?: AbortSignal) => {
				expect(cwd).toBe(project);
				expect(signal).toBe(abort.signal);
				signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
				started.resolve();
				await cancelled.promise;
				await finished.promise;
			};
			probes.toolkit.mockImplementation(async ({ cwd, signal }) => {
				await waitForCancellation(cwd, signal);
				return { stdout: "", stderr: "aborted", exitCode: null, durationMs: 0, timedOut: false };
			});
			probes.scout.mockImplementation(async (deps) => {
				await waitForCancellation(deps.getCwd(), deps.signal);
				expect(deps.getCwd()).toBe(project);
				return {
					summary: "",
					citations: [],
					droppedCitations: 0,
					unreliable: false,
					truncated: true,
					turnsUsed: 0,
					failure: "aborted",
				};
			});
			const tool = harness.session.agent.state.tools.find((tool) => tool.name === name)!;
			const directory = harness.session.agent.state.tools.find((tool) => tool.name === "task_directory")!;
			const params = name === "context_scout" ? { query: "Inspect synthetic fixture" } : { script: "fixture" };
			const alreadyAborted = AbortSignal.abort();
			await expect(tool.bindInvocation!("pre-cancelled", params, alreadyAborted)).rejects.toThrow();
			expect(probes.toolkit).not.toHaveBeenCalled();
			expect(probes.scout).not.toHaveBeenCalled();
			const invocation = await tool.bindInvocation!("active", params, abort.signal);
			const execution = invocation.execute("active", params, abort.signal);
			await started.promise;
			let selected = false;
			const selection = directory.execute("switch", { action: "select", workspaceId: "session" }).then(() => {
				selected = true;
			});
			try {
				abort.abort();
				await cancelled.promise;
				expect(selected).toBe(false);
				expect(invocation.executionContext.cwd).toBe(project);
				finished.resolve();
				await execution;
				expect(selected).toBe(false);
			} finally {
				finished.resolve();
				await execution;
				invocation.release();
			}
			await selection;
			const next = await tool.bindInvocation!("next", params);
			try {
				expect(next.executionContext.cwd).toBe(harness.tempDir);
			} finally {
				next.release();
			}
		},
	);

	it("passes the captured directory and cancellation to toolkit execution", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "run_toolkit_script"],
			settings: {
				modelCapability: { mode: "off" },
				toolkit: {
					scripts: [{ name: "fixture", description: "Synthetic operation", runner: "bash", path: "fixture.sh" }],
				},
			},
		});
		const project = await selectProject(harness);
		probes.toolkit.mockResolvedValue({ stdout: "fixture", stderr: "", exitCode: 0, durationMs: 0, timedOut: false });
		const tool = harness.session.agent.state.tools.find((tool) => tool.name === "run_toolkit_script")!;
		const params = { script: "fixture" };
		const abort = new AbortController();
		const invocation = await tool.bindInvocation!("toolkit", params, abort.signal);
		try {
			await invocation.execute("toolkit", params, abort.signal);
			expect(probes.toolkit).toHaveBeenCalledWith(expect.objectContaining({ cwd: project, signal: abort.signal }));
		} finally {
			invocation.release();
		}
	});

	it("executes the owner-approved process in its admitted directory", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "directory-operator",
			model: { provider: "faux", id: "faux-1" },
			role: "operator",
			capabilityCeiling: ["process.exec", "workflow.plan"],
			toolNames: ["run_process", "task_directory"],
		});
		profile.executionPolicy = {
			allowedExecutables: [process.execPath],
			allowedEnvironmentVariables: [],
			maxOutputBytes: 4096,
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000 }],
			orchestrationProfile: profile,
			settings: { modelCapability: { mode: "off" } },
		});
		const project = await selectProject(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"run_process",
						{
							executable: process.execPath,
							args: ["-e", "console.log(require('node:fs').realpathSync.native(process.cwd()))"],
						},
						{ id: "process" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Print the admitted process directory.");
		const result = harness.session.agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "process",
		);
		expect(getMessageText(result)).toContain(realpathSync.native(project));
	});

	it("keeps scout child paths relative to execution while permission roots stay session-relative", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "context_scout"],
			settings: { modelCapability: { mode: "off" }, scout: { enabled: true } },
		});
		const project = await selectProject(harness);
		writeFileSync(join(project, "allowed.txt"), "ALLOWED_FIXTURE\n");
		writeFileSync(join(project, "denied.txt"), "DENIED_FIXTURE\n");
		harness.session.capabilityEnvelope = {
			id: "scout-file",
			capabilities: ["filesystem.read"],
			allowedTools: ["context_scout"],
			allowedPaths: [join("selected project 日本語", "allowed.txt")],
		};
		const abort = new AbortController();
		probes.scout.mockImplementation(async (deps) => {
			expect(deps.getCwd()).toBe(project);
			expect(deps.signal).toBe(abort.signal);
			const read = deps.buildReadOnlyTools(deps.getCwd()).find((tool) => tool.name === "read")!;
			expect(getMessageText(await read.execute("allowed", { path: "allowed.txt" }))).toContain("ALLOWED_FIXTURE");
			await expect(read.execute("denied", { path: "denied.txt" })).rejects.toThrow("path_scope");
			expect(deps.fileExists("allowed.txt")).toBe(true);
			// The citation counter includes the empty line after a final newline.
			expect(deps.countLines("allowed.txt")).toBe(2);
			expect(deps.fileExists("denied.txt")).toBe(false);
			expect(deps.countLines("denied.txt")).toBeUndefined();
			return {
				summary: "Inspected",
				citations: [],
				droppedCitations: 0,
				unreliable: false,
				truncated: false,
				turnsUsed: 1,
			};
		});
		const tool = harness.session.agent.state.tools.find((tool) => tool.name === "context_scout")!;
		const params = { query: "Inspect synthetic fixture" };
		const invocation = await tool.bindInvocation!("scout", params, abort.signal);
		try {
			await invocation.execute("scout", params, abort.signal);
		} finally {
			invocation.release();
		}
		expect(probes.scout).toHaveBeenCalledOnce();
	});

	it("constructs image reference handling at the admitted directory without provider calls", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory"],
			settings: { modelCapability: { mode: "off" } },
		});
		const project = await selectProject(harness);
		probes.image.mockResolvedValue({
			content: [{ type: "text", text: "mocked image" }],
			details: {
				provider: "openai-codex",
				model: "fixture",
				operation: "edit",
				path: "fixture.png",
				sequence: 1,
				bytes: 0,
				inline: false,
			},
		});
		const definition = harness.session.getToolDefinition("image_generate")!;
		const params = { prompt: "Fixture", referenced_image_paths: ["fixture.png"] };
		const invocation = await definition.bindInvocation!("image", params);
		try {
			await invocation.execute("image", params);
		} finally {
			invocation.release();
		}
		expect(probes.image).toHaveBeenCalledExactlyOnceWith(project);
	});
});
