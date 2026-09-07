import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeLaneGate } from "../src/core/worktree-sync/lane-gate.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	}),
}));

describe("model-owned persistent task directories", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("exposes task directory management on the default native tool surface", async () => {
		const harness = await createHarness({ settings: { modelCapability: { mode: "off" } } });
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toContain("task_directory");
	});

	it("can forget an archived task binding without resurrecting the checklist entry", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "task_steps"],
			settings: { modelCapability: { mode: "off" } },
		});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("task_steps", { action: "set", steps: [{ content: "Old fixture task" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("task_directory", { action: "bind", taskId: "step-1", pinned: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("task_steps", { action: "clear" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("task_directory", { action: "forget", taskId: "step-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Create and remove the synthetic task binding.");
		const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results.filter((result) => result.isError).map(getMessageText)).toEqual([]);
		expect(harness.sessionManager.getLatestCustomEntryOnBranch("task_directory_state")?.data).toMatchObject({
			bindings: [],
		});
	});

	it("checks the accessed file, not its parent directory, against the unchanged grant", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read"],
			settings: { modelCapability: { mode: "off" } },
		});
		writeFileSync(join(harness.tempDir, "allowed.txt"), "ALLOWED_FIXTURE");
		writeFileSync(join(harness.tempDir, "denied.txt"), "DENIED_FIXTURE");
		harness.session.capabilityEnvelope = {
			id: "file-only",
			capabilities: ["filesystem.read"],
			allowedPaths: [join(harness.tempDir, "allowed.txt")],
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "allowed.txt" }, { id: "allowed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "denied.txt" }, { id: "denied" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Inspect only authorized fixture content.");
		const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results.find((result) => result.toolCallId === "allowed"))).toContain("ALLOWED_FIXTURE");
		const denied = results.find((result) => result.toolCallId === "denied");
		expect(denied?.isError).toBe(true);
		expect(getMessageText(denied)).not.toContain("DENIED_FIXTURE");
	});

	it("shares the selected directory across shell and byte-preserving edit, including reload", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "bash", "edit"],
			settings: { modelCapability: { mode: "off" } },
		});
		const root = join(harness.tempDir, "project with spaces");
		mkdirSync(join(root, "child"), { recursive: true });
		const before = Buffer.from("\uFEFFcafé\r\ntarget\n世界\r");
		writeFileSync(join(root, "fixture.txt"), before);
		writeFileSync(join(harness.tempDir, "fixture.txt"), "AMBIENT_UNCHANGED");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("task_directory", { action: "register", workspaceId: "project", path: root })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "project" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Directory selected"),
		]);
		await harness.session.prompt("Select the synthetic project.");
		await harness.session.reload();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "cd child; pwd" }, { id: "child" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" }, { id: "root" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall(
						"edit",
						{ path: "fixture.txt", edits: [{ oldText: "target", newText: "changed" }] },
						{ id: "edit" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Check shell context and edit the fixture.");
		const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results.filter((result) => result.isError).map(getMessageText)).toEqual([]);
		for (const [id, path] of [
			["child", join(root, "child")],
			["root", root],
		]) {
			expect(realpathSync.native(getMessageText(results.find((result) => result.toolCallId === id)).trim())).toBe(
				realpathSync.native(path),
			);
		}
		expect(readFileSync(join(root, "fixture.txt"))).toEqual(Buffer.from("\uFEFFcafé\r\nchanged\n世界\r"));
		expect(readFileSync(join(harness.tempDir, "fixture.txt"), "utf8")).toBe("AMBIENT_UNCHANGED");
	});

	it("keeps extension overrides and supplies their admitted directory", async () => {
		const execute = vi.fn(async (cwd: string) => ({ content: [{ type: "text" as const, text: cwd }], details: {} }));
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "read"],
			settings: { modelCapability: { mode: "off" } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "read",
						label: "Fixture read",
						description: "Fixture override",
						parameters: Type.Object({ path: Type.String() }),
						execute: async (_id, _params, _signal, _update, ctx) => execute(ctx.cwd),
					});
				},
			],
		});
		const root = join(harness.tempDir, "extension project");
		mkdirSync(root);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("task_directory", { action: "register", workspaceId: "extension", path: root })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "extension" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "not-a-native-file" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Run the fixture extension in the selected project.");
		expect(execute).toHaveBeenCalledExactlyOnceWith(root);
	});

	it("keeps the lane mutation guard around admitted native executors", async () => {
		vi.stubEnv("PI_WORKTREE_LANE", "fixture-lane");
		const guard = vi
			.spyOn(WorktreeLaneGate.prototype, "checkMutation")
			.mockResolvedValue({ allowed: false, code: "sync_required", message: "Fixture lane needs sync" });
		const harness = await createHarness({
			initialActiveToolNames: ["write"],
			settings: { modelCapability: { mode: "off" }, worktreeSync: { enabled: true } },
		});
		const write = harness.session.agent.state.tools.find((tool) => tool.name === "write")!;
		const params = { path: "blocked.txt", content: "MUST_NOT_WRITE" };
		const invocation = await write.bindInvocation!("blocked", params);
		try {
			const result = await invocation.execute("blocked", params);
			expect(getMessageText(result)).toContain("Fixture lane needs sync");
			expect(guard).toHaveBeenCalledExactlyOnceWith("write", undefined, join(harness.tempDir, "blocked.txt"));
			expect(existsSync(join(harness.tempDir, "blocked.txt"))).toBe(false);
		} finally {
			invocation.release();
		}
		guard.mockResolvedValue({ allowed: true });
		const permitted = await write.bindInvocation!("allowed", params);
		try {
			await permitted.execute("allowed", params);
			expect(existsSync(join(harness.tempDir, "blocked.txt"))).toBe(true);
		} finally {
			permitted.release();
		}
	});

	it("pins one task while another follows workspace selection, including same-batch task changes", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "task_steps", "read"],
			settings: { modelCapability: { mode: "off" } },
		});
		const first = join(harness.tempDir, "first project 日本語");
		const second = join(harness.tempDir, "second project");
		for (const [directory, marker] of [
			[first, "FIRST_FIXTURE"],
			[second, "SECOND_FIXTURE"],
		]) {
			mkdirSync(directory);
			writeFileSync(join(directory, "marker.txt"), marker);
		}
		const call = (name: string, args: Record<string, unknown>, id: string) =>
			fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
		harness.setResponses([
			call(
				"task_steps",
				{ action: "set", steps: [{ content: "First task", status: "in_progress" }, { content: "Second task" }] },
				"steps",
			),
			call("task_directory", { action: "register", workspaceId: "first", path: first }, "register-first"),
			call("task_directory", { action: "register", workspaceId: "second", path: second }, "register-second"),
			call("task_directory", { action: "bind", taskId: "step-1", workspaceId: "first", pinned: true }, "pin-first"),
			call("task_directory", { action: "bind", taskId: "step-2", pinned: false }, "follow-second"),
			call("task_directory", { action: "select", workspaceId: "second" }, "select-second"),
			call("read", { path: "marker.txt" }, "pinned-read"),
			fauxAssistantMessage(
				[
					fauxToolCall(
						"task_steps",
						{ action: "update", id: "step-2", status: "in_progress" },
						{ id: "activate-second" },
					),
					fauxToolCall("read", { path: "marker.txt" }, { id: "following-read" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("task_directory", { action: "select", workspaceId: "first" }, { id: "select-first" }),
					fauxToolCall("read", { path: "marker.txt" }, { id: "following-moved-read" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Fixture inspected"),
		]);
		await harness.session.prompt("Inspect the two synthetic projects using explicit task directory bindings.");
		const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results.filter((result) => result.isError).map(getMessageText)).toEqual([]);
		expect(getMessageText(results.find((result) => result.toolCallId === "pinned-read"))).toContain("FIRST_FIXTURE");
		expect(getMessageText(results.find((result) => result.toolCallId === "following-read"))).toContain(
			"SECOND_FIXTURE",
		);
		expect(getMessageText(results.find((result) => result.toolCallId === "following-moved-read"))).toContain(
			"FIRST_FIXTURE",
		);
		expect(harness.sessionManager.getLatestCustomEntryOnBranch("task_directory_state")?.data).toMatchObject({
			selectedWorkspaceId: "first",
			bindings: [
				{ taskId: "step-1", workspaceId: "first", pinned: true },
				{ taskId: "step-2", pinned: false },
			],
		});
	});
});
