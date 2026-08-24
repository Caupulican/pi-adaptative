import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

const readParameters = Type.Object({ path: Type.String() });
const readTool: AgentTool<typeof readParameters> = {
	name: "read",
	label: "Read",
	description: "Read a file",
	parameters: readParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

const bashParameters = Type.Object({ command: Type.String() });
const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: bashParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

describe("AgentSession - Autonomy Gates Harness", () => {
	it("executes tools normally when no capability envelope is present", async () => {
		let executed = false;
		const customBashTool = {
			...bashTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [customBashTool] });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run ls");
		expect(executed).toBe(true);

		await harness.cleanup();
	});

	it("keeps capability authorization scoped to each call in a mixed read/edit/bash/grep batch", async () => {
		const editParameters = Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() });
		const grepParameters = Type.Object({
			pattern: Type.String(),
			path: Type.String(),
			glob: Type.Optional(Type.String()),
		});
		const executed: string[] = [];
		const tool = <
			T extends typeof readParameters | typeof bashParameters | typeof editParameters | typeof grepParameters,
		>(
			name: "read" | "edit" | "bash" | "grep",
			parameters: T,
		): AgentTool<T> => ({
			name,
			label: name,
			description: `${name} test tool`,
			parameters,
			execute: async (toolCallId) => {
				executed.push(`${name}:${toolCallId}`);
				return { content: [{ type: "text", text: `${name} completed` }], details: {} };
			},
		});
		const harness = await createHarness({
			settings: { modelCapability: { mode: "off" } },
			tools: [
				tool("read", readParameters),
				tool("edit", editParameters),
				tool("bash", bashParameters),
				tool("grep", grepParameters),
			],
		});
		harness.session.capabilityEnvelope = {
			id: "mixed-per-call",
			capabilities: ["filesystem.read", "process.exec"],
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "src/allowed.ts" }, { id: "read-call" }),
					fauxToolCall(
						"edit",
						{ path: "src/allowed.ts", oldText: "before", newText: "after" },
						{ id: "edit-call" },
					),
					fauxToolCall("bash", { command: "echo allowed" }, { id: "bash-call" }),
					fauxToolCall("grep", { pattern: "needle", path: "src", glob: "*.ts" }, { id: "grep-call" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("batch complete"),
		]);

		try {
			await harness.session.prompt("exercise the mixed capability batch");

			const results = new Map(
				harness.session.agent.state.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => [
						message.toolCallId,
						{
							isError: message.isError,
							text: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join("\n"),
						},
					]),
			);
			expect(executed.sort()).toEqual(["bash:bash-call", "grep:grep-call", "read:read-call"]);
			expect(results.get("read-call")).toMatchObject({ isError: false, text: "read completed" });
			expect(results.get("bash-call")).toMatchObject({ isError: false, text: "bash completed" });
			expect(results.get("grep-call")).toMatchObject({ isError: false, text: "grep completed" });
			expect(results.get("edit-call")).toMatchObject({ isError: true });
			expect(results.get("edit-call")?.text).toContain("missing_capability");
		} finally {
			await harness.cleanup();
		}
	});

	it("blocks tool execution when explicitly denied by envelope", async () => {
		let executed = false;
		const customBashTool = {
			...bashTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [customBashTool] });

		harness.session.capabilityEnvelope = {
			id: "env-1",
			capabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.http"],
			deniedTools: ["bash"],
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run ls");

		expect(executed).toBe(false);

		// The model should receive the blocked tool result in its history
		const messages = harness.session.agent.state.messages;
		const toolResultMsg = messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		if (!toolResultMsg || toolResultMsg.role !== "toolResult") throw new Error("Expected blocked tool result");
		expect(toolResultMsg.isError).toBe(true);
		const text = toolResultMsg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("blocked by autonomy gate [tool_gate]");

		await harness.cleanup();
	});

	it("blocks path-based tools when accessing outside allowed roots", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gates-test-"));
		const allowedRoot = path.join(tempDir, "allowed");
		fs.mkdirSync(allowedRoot);

		let executed = false;
		const customReadTool = {
			...readTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [customReadTool] });

		harness.session.capabilityEnvelope = {
			id: "env-1",
			capabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.http"],
			allowedPaths: [allowedRoot],
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "/etc/passwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Read secret file");

		expect(executed).toBe(false);

		const messages = harness.session.agent.state.messages;
		const toolResultMsg = messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		if (!toolResultMsg || toolResultMsg.role !== "toolResult") throw new Error("Expected blocked tool result");
		expect(toolResultMsg.isError).toBe(true);
		const text = toolResultMsg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("blocked by autonomy gate [path_scope]");

		fs.rmSync(tempDir, { recursive: true, force: true });
		await harness.cleanup();
	});

	it("blocks bash when command is destructive", async () => {
		let executed = false;
		const customBashTool = {
			...bashTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [customBashTool] });

		harness.session.capabilityEnvelope = {
			id: "env-1",
			capabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.http"],
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run destructive command");

		expect(executed).toBe(false);

		const messages = harness.session.agent.state.messages;
		const toolResultMsg = messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		if (!toolResultMsg || toolResultMsg.role !== "toolResult") throw new Error("Expected blocked tool result");
		expect(toolResultMsg.isError).toBe(true);
		const text = toolResultMsg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("blocked by autonomy gate [risk_assessment]");

		await harness.cleanup();
	});

	it("blocks due to missing capability and does not execute underlying tool", async () => {
		let executed = false;
		const customReadTool = {
			...readTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [customReadTool] });

		harness.session.capabilityEnvelope = {
			id: "env-missing",
			capabilities: [], // No filesystem.read authority.
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "/tmp/foo.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Read file");

		expect(executed).toBe(false);

		const messages = harness.session.agent.state.messages;
		const toolResultMsg = messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		if (!toolResultMsg || toolResultMsg.role !== "toolResult") throw new Error("Expected blocked tool result");
		expect(toolResultMsg.isError).toBe(true);

		const text = toolResultMsg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

		expect(text).toContain("blocked by autonomy gate [tool_gate]");
		expect(text).toContain("missing_capability");

		await harness.cleanup();
	});
});
