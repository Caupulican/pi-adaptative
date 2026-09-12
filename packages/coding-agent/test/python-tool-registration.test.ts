import { describe, expect, it } from "vitest";
import { requiredCapabilitiesForTool } from "../src/core/autonomy/approval-gate.ts";
import { buildForegroundEnvelope } from "../src/core/autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { MODEL_CAPABILITY_MINIMAL_ALLOWED_TOOLS } from "../src/core/model-capability.ts";
import { classifyToolTrust } from "../src/core/security/untrusted-boundary.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

describe("native python tool registration", () => {
	it("is built in and active by default on every platform", () => {
		expect(getDefaultActiveToolNames("linux")).toContain("python");
		expect(getDefaultActiveToolNames("win32")).toContain("python");
		expect(Object.keys(createAllToolDefinitions(process.cwd(), undefined, "linux"))).toContain("python");
		expect(Object.keys(createAllToolDefinitions(process.cwd(), undefined, "win32"))).toContain("python");
		expect(MODEL_CAPABILITY_MINIMAL_ALLOWED_TOOLS).toContain("python");
	});

	it("uses the shell-execution capability and existing trusted local boundary", () => {
		expect(requiredCapabilitiesForTool("python")).toEqual(["process.exec"]);
		expect(classifyToolTrust("python")).toBe("trusted");
	});

	it("admits python code on the explicit capability contract and never on keyword heuristics", () => {
		// The keyword `risk_assessment` gate is gone (docs/doctrine.md, Guards): python and bash are
		// host-trust execution boundaries (session-role.ts). Admitted code proceeds — including code
		// that merely mentions deletion or a child process — and only the structural envelope
		// (capability, tool allow/deny lists, path scope) can reject it. Consent for edge operations
		// belongs to the session edge, which classifies literal shell tool calls, not Python source.
		const envelope = buildForegroundEnvelope({ turnIndex: 1, activeToolNames: ["python"], cwd: process.cwd() });
		for (const code of [
			"print(sum(range(10)))",
			"import shutil; shutil.rmtree('build')",
			"import subprocess; subprocess.run(['git', 'status'])",
		]) {
			expect(evaluateToolGate({ toolName: "python", args: { code }, cwd: process.cwd(), envelope })).toMatchObject({
				outcome: "allow",
				gate: "tool_gate",
				reasonCode: "allowed_by_envelope",
			});
		}
	});

	it("still rejects python structurally when the envelope withholds process.exec or denies the tool", () => {
		const envelope = buildForegroundEnvelope({ turnIndex: 1, activeToolNames: ["python"], cwd: process.cwd() });
		const code = "print('hello')";
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code },
				cwd: process.cwd(),
				envelope: {
					...envelope,
					capabilities: envelope.capabilities.filter((capability) => capability !== "process.exec"),
				},
			}),
		).toMatchObject({ outcome: "block", gate: "tool_gate", reasonCode: "missing_capability" });
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code },
				cwd: process.cwd(),
				envelope: { ...envelope, deniedTools: ["python"] },
			}),
		).toMatchObject({ outcome: "block", gate: "tool_gate", reasonCode: "tool_denied" });
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code },
				cwd: process.cwd(),
				envelope: { ...envelope, allowedTools: ["read"] },
			}),
		).toMatchObject({ outcome: "block", gate: "tool_gate", reasonCode: "tool_not_allowed" });
	});

	it("adds concise preference and bounded-search guidance to the system prompt", () => {
		const prompt = buildSystemPrompt({ cwd: process.cwd(), selectedTools: ["read", "bash", "python"] });
		expect(prompt).toContain("Python: bounded scripts/data");
		expect(prompt).toContain("rg/jq: scoped roots/filters");
	});
});
