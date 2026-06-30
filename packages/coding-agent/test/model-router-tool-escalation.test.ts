import { describe, expect, it } from "vitest";
import { shouldEscalateModelRouterTool } from "../src/core/model-router/tool-escalation.ts";

describe("model router tool escalation", () => {
	it("does not escalate read-only tools on cheap-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "read" })).toBe(false);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "grep" })).toBe(false);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "ls" })).toBe(false);
	});

	it("escalates mutating tools on cheap-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "write" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "edit" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "bash" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "replace_file_content" })).toBe(true);
	});

	it("allows read-only shell commands to stay on the cheap model", () => {
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "bash",
				args: { command: "git status --short" },
			}),
		).toBe(false);
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "bash",
				args: { command: "pwd && git diff --stat" },
			}),
		).toBe(false);
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "run_command",
				args: { command: "npm view @caupulican/pi version" },
			}),
		).toBe(false);
	});

	it("escalates mutating shell commands from cheap turns", () => {
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "bash",
				args: { command: "npm install left-pad" },
			}),
		).toBe(true);
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "run_command",
				args: { command: "git commit -m change" },
			}),
		).toBe(true);
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "shell",
				args: { command: "echo hi > out.txt" },
			}),
		).toBe(true);
	});

	it("does not escalate medium-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ tier: "medium", toolName: "write" })).toBe(false);
		expect(shouldEscalateModelRouterTool({ tier: "medium", toolName: "bash", args: { command: "rm -rf /" } })).toBe(
			false,
		);
	});

	it("does not escalate expensive-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ tier: "expensive", toolName: "write" })).toBe(false);
		expect(
			shouldEscalateModelRouterTool({ tier: "expensive", toolName: "bash", args: { command: "git push" } }),
		).toBe(false);
	});
});
