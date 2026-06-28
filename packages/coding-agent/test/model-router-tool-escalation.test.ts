import { describe, expect, it } from "vitest";
import { shouldEscalateModelRouterTool } from "../src/core/model-router/tool-escalation.ts";

describe("model router tool escalation", () => {
	it("does not escalate read-only tools on research-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "read" })).toBe(false);
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "grep" })).toBe(false);
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "ls" })).toBe(false);
	});

	it("escalates mutating tools on research-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "write" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "edit" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "bash" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ intent: "research", toolName: "replace_file_content" })).toBe(true);
	});

	it("allows read-only shell commands to stay on the cheap research model", () => {
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "bash",
				args: { command: "git status --short" },
			}),
		).toBe(false);
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "bash",
				args: { command: "pwd && git diff --stat" },
			}),
		).toBe(false);
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "run_command",
				args: { command: "npm view @caupulican/pi version" },
			}),
		).toBe(false);
	});

	it("escalates mutating shell commands from cheap research turns", () => {
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "bash",
				args: { command: "npm install left-pad" },
			}),
		).toBe(true);
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "run_command",
				args: { command: "git commit -m change" },
			}),
		).toBe(true);
		expect(
			shouldEscalateModelRouterTool({
				intent: "research",
				toolName: "shell",
				args: { command: "echo hi > out.txt" },
			}),
		).toBe(true);
	});

	it("does not escalate modify-routed turns", () => {
		expect(shouldEscalateModelRouterTool({ intent: "modify", toolName: "write" })).toBe(false);
	});
});
