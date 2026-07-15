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
		expect(requiredCapabilitiesForTool("python")).toEqual(["run_shell"]);
		expect(classifyToolTrust("python")).toBe("trusted");
	});

	it("allows bounded analysis but asks before destructive or nested-process code", () => {
		const envelope = buildForegroundEnvelope({ turnIndex: 1, activeToolNames: ["python"], cwd: process.cwd() });
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code: "print(sum(range(10)))" },
				cwd: process.cwd(),
				envelope,
			}),
		).toMatchObject({ outcome: "allow" });
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code: "import shutil; shutil.rmtree('build')" },
				cwd: process.cwd(),
				envelope,
			}),
		).toMatchObject({ outcome: "ask-user", gate: "risk_assessment" });
		expect(
			evaluateToolGate({
				toolName: "python",
				args: { code: "import subprocess; subprocess.run(['git', 'status'])" },
				cwd: process.cwd(),
				envelope,
			}),
		).toMatchObject({ outcome: "ask-user", gate: "risk_assessment" });
	});

	it("adds concise preference and bounded-search guidance to the system prompt", () => {
		const prompt = buildSystemPrompt({ cwd: process.cwd(), selectedTools: ["read", "bash", "python"] });
		expect(prompt).toContain("Prefer the python tool for bounded Python snippets and scripts");
		expect(prompt).toContain("Keep searches bounded and purposeful");
	});
});
