import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	TASK_AUTOMATION_PROVENANCE,
	type TaskAutomationProvenance,
	TaskAutomationRuntimeAdapter,
} from "../src/core/automation/task-automation-runtime-adapter.ts";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { spawnScriptExecutor } from "../src/core/toolkit/script-runner.ts";
import {
	createRunToolkitScriptToolDefinition,
	type RunToolkitScriptDetails,
	type ToolkitScriptAuthorizer,
} from "../src/core/tools/run-toolkit-script.ts";
import type { TaskAutomationInput } from "../src/core/tools/task-automation.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const isWin = process.platform === "win32";
const runner = isWin ? "powershell" : "bash";
const scriptFilename = isWin ? "calc.ps1" : "calc.sh";

function asRunDetails(details: unknown): RunToolkitScriptDetails | undefined {
	return typeof details === "object" && details !== null ? (details as RunToolkitScriptDetails) : undefined;
}

type ScriptWithProvenance = ToolkitScript & {
	[TASK_AUTOMATION_PROVENANCE]?: TaskAutomationProvenance;
};

function getToolResult(harness: Harness, callIndex = -1) {
	const results = harness.session.agent.state.messages.filter((m) => m.role === "toolResult");
	return callIndex < 0 ? results[results.length + callIndex] : results[callIndex];
}

function getToolResultText(harness: Harness, callIndex = -1): string {
	const res = getToolResult(harness, callIndex);
	if (res?.role !== "toolResult") throw new Error("No toolResult message found");
	return res.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

function writeCalcScript(dir: string, contentModifier?: string): string {
	const scriptDir = join(dir, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	const scriptPath = join(scriptDir, scriptFilename);

	let scriptContent = "";
	if (isWin) {
		scriptContent = `param($arg1)
if (-not $arg1) { Write-Error "missing input"; exit 2 }
if ($arg1 -eq "invalid") { Write-Error "error: invalid arg"; exit 1 }
Write-Output "result=$arg1"
exit 0
`;
	} else {
		scriptContent = `#!/usr/bin/env bash
if [ "$#" -lt 1 ]; then
  echo "missing input" >&2
  exit 2
fi
if [ "$1" = "invalid" ]; then
  echo "error: invalid arg" >&2
  exit 1
fi
echo "result=$1"
exit 0
`;
	}

	if (contentModifier) {
		scriptContent += `\n# modifier: ${contentModifier}\n`;
	}

	writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
	if (!isWin) {
		try {
			chmodSync(scriptPath, 0o755);
		} catch {
			// ignore on non-posix or restricted fs
		}
	}
	return `scripts/${scriptFilename}`;
}

function writeStaticScript(dir: string): string {
	const scriptDir = join(dir, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	const filename = isWin ? "static.ps1" : "static.sh";
	const scriptPath = join(scriptDir, filename);
	const scriptContent = isWin
		? `param($arg1)\nWrite-Output "static=$arg1"\nexit 0\n`
		: `#!/usr/bin/env bash\necho "static=$1"\nexit 0\n`;
	writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
	if (!isWin) {
		try {
			chmodSync(scriptPath, 0o755);
		} catch {
			// ignore on non-posix or restricted fs
		}
	}
	return `scripts/${filename}`;
}

describe("agent-session task automation integration", () => {
	it("exposes task_automation on the default root tool surface", async () => {
		const harness = await createHarness();
		try {
			const toolNames = harness.session.agent.state.tools.map((t) => t.name);
			expect(toolNames).toContain("task_automation");
			expect(toolNames).toContain("run_toolkit_script");
			expect(toolNames).toContain("task_steps");
		} finally {
			await harness.cleanup();
		}
	});

	it("authors, validates with negative controls, and runs task automation through runtime tools", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Spec action
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "calc-tool",
							description: "Deterministic calculation script",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [{ name: "value", type: "string", description: "Input value to echo" }],
								outputs: { format: "text", description: "Output text with result prefix", contains: "result=" },
								preconditions: ["Script exists and is executable"],
								effects: ["Outputs formatted calculation result"],
								failure: ["Exits non-zero on invalid arg"],
								verifier: {
									args: ["test-val"],
									expectedExitCode: 0,
									expectedOutput: "result=test-val",
									negativeControls: [
										{
											description: "Reject invalid argument",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Specification created"),
			]);

			await harness.session.prompt("Author the calculation automation");
			const specResult = getToolResultText(harness);
			expect(specResult).toContain('Automation "calc-tool" specification recorded');

			// 2. Validate action (positive execution + negative control execution)
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "validate",
							name: "calc-tool",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Validation completed"),
			]);

			await harness.session.prompt("Validate the automation");
			const validateResult = getToolResultText(harness);
			expect(validateResult).toContain('Validation SUCCEEDED for "calc-tool"');
			expect(validateResult).toContain("Script hash:");

			// 3. Run action
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "run",
							name: "calc-tool",
							args: ["hello-world"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Run completed"),
			]);

			await harness.session.prompt("Run the automation");
			const runResult = getToolResultText(harness);
			expect(runResult).toContain('Automation "calc-tool" succeeded (exit code 0)');
			expect(runResult).toContain("result=hello-world");

			// 4. Execution via run_toolkit_script routes to controller without bypass
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "calc-tool",
							args: ["via-toolkit"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Toolkit run completed"),
			]);

			await harness.session.prompt("Run via run_toolkit_script");
			const toolkitResult = getToolResultText(harness);
			expect(toolkitResult).toContain("result=via-toolkit");
		} finally {
			await harness.cleanup();
		}
	});

	it("invalidates evidence when script on disk is mutated and rejects execution until re-validated", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Author
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "calc-mutate",
							description: "Script to test mutation invalidation",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [{ name: "v", type: "string", description: "val" }],
								outputs: { format: "text", description: "result", contains: "result=" },
								preconditions: ["Script exists"],
								effects: ["Prints result"],
								failure: ["Rejects bad input"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "Reject invalid argument",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec calc-mutate");

			// 2. Validate
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "validate",
							name: "calc-mutate",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Validation done"),
			]);
			await harness.session.prompt("Validate calc-mutate");
			expect(getToolResultText(harness)).toContain("Validation SUCCEEDED");

			// Mutate file on disk
			writeCalcScript(harness.tempDir, "tampered-content");

			// Attempt to run with modified script on disk
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "run",
							name: "calc-mutate",
							args: ["test"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Run attempt finished"),
			]);

			await harness.session.prompt("Run mutated script");
			const mutateRunResult = getToolResultText(harness);
			expect(mutateRunResult).toContain("modified on disk since validation");
			expect(mutateRunResult).toContain("re-validation required");

			// run_toolkit_script MUST also reject and not fall through to raw execution
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("run_toolkit_script", {
							script: "calc-mutate",
							args: ["test"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Toolkit run attempt finished"),
			]);

			await harness.session.prompt("Run mutated script via toolkit");
			const toolkitRunResult = getToolResultText(harness);
			expect(toolkitRunResult).toContain("no scripts registered");
		} finally {
			await harness.cleanup();
		}
	});

	it("prevents completing or dropping a task step bound to an unverified automation", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Spec
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "bound-calc",
							description: "Automation bound to a task step",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [{ name: "v", type: "string", description: "val" }],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["Script exists"],
								effects: ["Prints result"],
								failure: ["Exits 1"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec bound-calc");

			// 2. Validate
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "validate",
							name: "bound-calc",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Validation done"),
			]);
			await harness.session.prompt("Validate bound-calc");

			// 3. Set task steps
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "set",
							steps: [{ content: "Perform bound calculation", status: "in_progress" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Step set"),
			]);
			await harness.session.prompt("Set task step");

			// Bind step-1 to bound-calc with expectedArgs
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "bind",
							name: "bound-calc",
							stepId: "step-1",
							args: ["prod-arg"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Bind done"),
			]);

			await harness.session.prompt("Bind step-1 to bound-calc");
			expect(getToolResultText(harness)).toContain('Bound task step "step-1" to automation "bound-calc"');

			// Attempt to mark step-1 completed BEFORE running automation with expectedArgs
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "update",
							id: "step-1",
							status: "completed",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Update attempted"),
			]);

			await harness.session.prompt("Complete step-1 prematurely");
			const prematureResult = getToolResultText(harness);
			expect(prematureResult).toContain("which has not executed successfully");

			// Attempt to drop the active unresolved bound step via clear
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "clear",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Clear attempted"),
			]);

			await harness.session.prompt("Clear steps prematurely");
			const clearResult = getToolResultText(harness);
			expect(clearResult).toContain("Cannot drop active bound task step");

			// Now run the automation with the exact expectedArgs
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "run",
							name: "bound-calc",
							args: ["prod-arg"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Run completed"),
			]);

			await harness.session.prompt("Run automation with expectedArgs");
			expect(getToolResultText(harness)).toContain("succeeded");

			// Now mark step-1 completed: MUST succeed
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "update",
							id: "step-1",
							status: "completed",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Step marked complete"),
			]);

			await harness.session.prompt("Complete step-1 now");
			expect(getToolResultText(harness)).toContain("task_steps update recorded");
			const finalStepResult = getToolResult(harness);
			const stepDetails = finalStepResult.details as
				| { applied?: boolean; state?: { steps?: Array<{ status?: string }> } }
				| undefined;
			expect(stepDetails?.applied).toBe(true);
			expect(stepDetails?.state?.steps?.[0]?.status).toBe("completed");
		} finally {
			await harness.cleanup();
		}
	});

	it("gates direct shell execution of registered script paths without blocking unrelated commands", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// Spec the automation so its script path is registered
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "shell-gated",
							description: "Script to test direct shell gating",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["exists"],
								effects: ["runs"],
								failure: ["fails"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec registered"),
			]);

			await harness.session.prompt("Register shell-gated");

			// Direct shell execution of the registered script path must be gated
			const directCmd = isWin ? `powershell .\\${scriptRelPath} test` : `bash ./${scriptRelPath} test`;
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: directCmd,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Direct execution blocked"),
			]);

			await harness.session.prompt("Run direct script via shell");
			const gateResult = getToolResultText(harness);
			expect(gateResult).toContain("Direct shell execution of registered automation script");
			expect(gateResult).toContain("is gated");

			// Unrelated shell command (echo "safe") must NOT be blocked
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: 'echo "safe unblocked execution"',
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Echo executed"),
			]);

			await harness.session.prompt("Run safe echo command");
			const echoResult = getToolResultText(harness);
			expect(echoResult).toContain("safe unblocked execution");
		} finally {
			await harness.cleanup();
		}
	});

	it("gates direct shell execution when an extension hook rewrites benign arguments to registered script", async () => {
		let scriptRelPath = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName === "bash") {
							// Rewrite safe echo into direct script execution
							const directCmd = isWin ? `powershell .\\${scriptRelPath} test` : `bash ./${scriptRelPath} test`;
							(event.input as { command: string }).command = directCmd;
						}
					});
				},
			],
		});
		scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// Spec the automation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "hook-gated",
							description: "Script to test hook rewriting",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["exists"],
								effects: ["runs"],
								failure: ["fails"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec hook-gated");

			// Model attempts to run an innocent command, but extension hook rewrites it to registered script
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: 'echo "innocent command"',
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Execution evaluated"),
			]);

			await harness.session.prompt("Run innocent command");
			const gateResult = getToolResultText(harness);
			expect(gateResult).toContain("Direct shell execution of registered automation script");
			expect(gateResult).toContain("is gated");
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects direct AgentSession.saveTaskStepsStateSnapshot completing an unverified bound step", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Spec
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "direct-save-bound",
							description: "Testing direct session save invariant",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["exists"],
								effects: ["runs"],
								failure: ["fails"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec direct-save-bound");

			// 2. Set task steps
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_steps", {
							action: "set",
							steps: [{ content: "Perform direct save test", status: "in_progress" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Step set"),
			]);
			await harness.session.prompt("Set step");

			// 3. Bind step-1
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "bind",
							name: "direct-save-bound",
							stepId: "step-1",
							args: ["prod-arg"],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Bound"),
			]);
			await harness.session.prompt("Bind step-1");

			// 4. Directly invoke harness.session.saveTaskStepsStateSnapshot with step completed
			// Spread the genuine existing TaskStepsState and TaskStep rather than incomplete fakes
			const currentSnapshot = harness.session.getTaskStepsStateSnapshot();
			expect(currentSnapshot).toBeDefined();
			expect(currentSnapshot!.steps.length).toBeGreaterThan(0);

			const stepToComplete = currentSnapshot!.steps.find((s) => s.id === "step-1");
			expect(stepToComplete).toBeDefined();

			const snapshotWithCompletedStep = {
				...currentSnapshot!,
				steps: currentSnapshot!.steps.map((s) =>
					s.id === "step-1"
						? {
								...s,
								status: "completed" as const,
								updatedAt: new Date().toISOString(),
							}
						: s,
				),
			};

			let saveError: Error | undefined;
			try {
				await harness.session.saveTaskStepsStateSnapshot(snapshotWithCompletedStep);
			} catch (err) {
				saveError = err as Error;
			}
			expect(saveError).toBeDefined();
			expect(saveError?.message).toContain("which has not executed successfully");
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects execution via dynamic provenance symbol after scope/session switch without raw fallback", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Spec and validate
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "provenance-test",
							description: "Test provenance symbol",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["exists"],
								effects: ["runs"],
								failure: ["fails"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec provenance-test");

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "validate",
							name: "provenance-test",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Validate done"),
			]);
			await harness.session.prompt("Validate provenance-test");

			let executorCalled = false;
			const testAdapter = new TaskAutomationRuntimeAdapter({
				getCwd: () => harness.tempDir,
				getSessionManager: () => harness.session.sessionManager,
				executor: async () => {
					executorCalled = true;
					throw new Error("Raw executor must never be called for dynamic automation script!");
				},
			});

			const combined = testAdapter.getCombinedScripts([]);
			const dynamicScript = combined.find((s) => s.name === "provenance-test");
			expect(dynamicScript).toBeDefined();

			const dynamicScriptWithProv = dynamicScript as ScriptWithProvenance;
			expect(dynamicScriptWithProv[TASK_AUTOMATION_PROVENANCE]).toBeDefined();

			// Spread snapshot retains own enumerable Symbol property
			const spreadSnapshot = { ...dynamicScript! };
			const spreadWithProv = spreadSnapshot as ScriptWithProvenance;
			expect(spreadWithProv[TASK_AUTOMATION_PROVENANCE]).toBeDefined();

			// 1. Session ID scope switch
			const sessionSwitchedAdapter = new TaskAutomationRuntimeAdapter({
				getCwd: () => harness.tempDir,
				getSessionManager: () =>
					new Proxy(harness.session.sessionManager, {
						get(target, prop, receiver) {
							if (prop === "getSessionId") return () => "switched-session-id";
							return Reflect.get(target, prop, receiver);
						},
					}),
				executor: async () => {
					executorCalled = true;
					throw new Error("Raw executor must never be called on session switch!");
				},
			});

			const sessionSwitchResult = await sessionSwitchedAdapter.executeScript(spreadSnapshot, ["test"]);
			expect(sessionSwitchResult.exitCode).toBe(1);
			expect(sessionSwitchResult.stderr).toContain("Scope switch invalidates pending execution");
			expect(executorCalled).toBe(false);

			// 2. Workspace CWD scope switch
			const cwdSwitchedAdapter = new TaskAutomationRuntimeAdapter({
				getCwd: () => join(harness.tempDir, "different-cwd"),
				getSessionManager: () => harness.session.sessionManager,
				executor: async () => {
					executorCalled = true;
					throw new Error("Raw executor must never be called on cwd switch!");
				},
			});

			const cwdSwitchResult = await cwdSwitchedAdapter.executeScript(spreadSnapshot, ["test"]);
			expect(cwdSwitchResult.exitCode).toBe(1);
			expect(cwdSwitchResult.stderr).toContain("Scope switch invalidates pending execution");
			expect(executorCalled).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects execution of old selection after same-file contract re-authoring and re-validation without spawning executor", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			let oldExecutionPhase = false;
			let oldExecutionExecutorCalls = 0;
			const adapter = new TaskAutomationRuntimeAdapter({
				getCwd: () => harness.tempDir,
				getSessionManager: () => harness.session.sessionManager,
				executor: async (command, argv, cwd, timeoutMs, signal) => {
					if (oldExecutionPhase) {
						oldExecutionExecutorCalls++;
						throw new Error("Raw executor must not be spawned for stale dynamic selection!");
					}
					return spawnScriptExecutor(command, argv, cwd, timeoutMs, signal);
				},
			});

			const controller = adapter.getController();

			// 1. Author initial contract
			controller.author({
				name: "contract-replace-test",
				description: "Initial contract version",
				runner,
				path: scriptRelPath,
				contract: {
					inputs: [{ name: "v", type: "string", description: "val" }],
					outputs: { format: "text", description: "res", contains: "result=" },
					preconditions: ["exists"],
					effects: ["runs"],
					failure: ["fails"],
					verifier: {
						args: ["ok1"],
						expectedExitCode: 0,
						expectedOutput: "result=ok1",
						negativeControls: [
							{
								description: "neg1",
								args: ["invalid"],
								expectedExitCode: 1,
								expectedError: "invalid arg",
							},
						],
					},
				},
			});

			// 2. Validate -> moves to ready, generation 1
			const val1 = await controller.validate("contract-replace-test");
			expect(val1.success).toBe(true);

			// 3. Selection: combined registry stamps frozen provenance with generation 1
			const combined = adapter.getCombinedScripts([]);
			const oldSelection = combined.find((s) => s.name === "contract-replace-test");
			expect(oldSelection).toBeDefined();

			const typeCheckedOld = oldSelection as ScriptWithProvenance;
			const prov = typeCheckedOld[TASK_AUTOMATION_PROVENANCE];
			expect(prov).toBeDefined();
			expect(prov?.generation).toBe(1);
			expect(Object.isFrozen(prov)).toBe(true);

			// 4. Same-file contract replacement via author
			controller.author({
				name: "contract-replace-test",
				description: "Replaced contract version",
				runner,
				path: scriptRelPath,
				contract: {
					inputs: [{ name: "v", type: "string", description: "val" }],
					outputs: { format: "text", description: "res", contains: "result=" },
					preconditions: ["exists"],
					effects: ["runs"],
					failure: ["fails"],
					verifier: {
						args: ["ok2"],
						expectedExitCode: 0,
						expectedOutput: "result=ok2",
						negativeControls: [
							{
								description: "neg2",
								args: ["invalid"],
								expectedExitCode: 1,
								expectedError: "invalid arg",
							},
						],
					},
				},
			});

			// 5. Re-validate replaced contract -> moves to ready, generation 2
			const val2 = await controller.validate("contract-replace-test");
			expect(val2.success).toBe(true);
			const currentAuto = controller.getAutomation("contract-replace-test");
			expect(currentAuto?.generation).toBe(2);

			// 6. Old selection execution MUST reject with generation mismatch, and raw executor MUST NOT spawn
			oldExecutionPhase = true;
			const oldExecutionResult = await adapter.executeScript(oldSelection!, ["ok2"]);
			expect(oldExecutionResult.exitCode).toBe(1);
			expect(oldExecutionResult.stderr).toContain("generation mismatch");
			expect(oldExecutionExecutorCalls).toBe(0);
			oldExecutionPhase = false;

			// 7. Negative control: fresh selection with current generation executes successfully
			const freshCombined = adapter.getCombinedScripts([]);
			const freshSelection = freshCombined.find((s) => s.name === "contract-replace-test");
			expect(freshSelection).toBeDefined();

			const freshExecutionResult = await adapter.executeScript(freshSelection!, ["fresh-run"]);
			expect(freshExecutionResult.exitCode).toBe(0);
			expect(freshExecutionResult.stdout).toContain("result=fresh-run");
			expect(oldExecutionExecutorCalls).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("executes task_automation in the background with real tool_task handoff and terminal notification", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			// 1. Author automation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "spec",
							name: "bg-calc",
							description: "Script for background test",
							runner,
							path: scriptRelPath,
							contract: {
								inputs: [{ name: "v", type: "string", description: "val" }],
								outputs: { format: "text", description: "res", contains: "result=" },
								preconditions: ["exists"],
								effects: ["runs"],
								failure: ["fails"],
								verifier: {
									args: ["ok"],
									expectedExitCode: 0,
									expectedOutput: "result=ok",
									negativeControls: [
										{
											description: "neg",
											args: ["invalid"],
											expectedExitCode: 1,
											expectedError: "invalid arg",
										},
									],
								},
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Spec done"),
			]);
			await harness.session.prompt("Spec bg-calc");

			// 2. Validate automation
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "validate",
							name: "bg-calc",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Validation done"),
			]);
			await harness.session.prompt("Validate bg-calc");

			// 3. Setup background event tracking via session.subscribe
			let sawRunningTask = false;
			let markTaskTerminal!: () => void;
			const taskTerminal = new Promise<void>((resolve) => {
				markTaskTerminal = resolve;
			});

			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "background_tools") {
					if (event.tasks.length > 0) {
						sawRunningTask = true;
					}
					if (sawRunningTask && event.tasks.length === 0) {
						markTaskTerminal();
					}
				}
			});

			// Run action with background: true
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("task_automation", {
							action: "run",
							name: "bg-calc",
							args: ["async-val"],
							background: true,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Task moved to background"),
			]);

			try {
				await harness.session.prompt("Run bg-calc in background");
				// Await terminal event from native background subsystem - no output polling!
				await taskTerminal;

				// Verify durable custom entry written by background tool task controller
				const taskEntries = harness.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
							? [entry.data as BackgroundToolTaskRecord]
							: [],
					);

				expect(taskEntries.length).toBeGreaterThan(0);
				const completedRecord = taskEntries.find(
					(r) => r.toolName === "task_automation" && r.status === "completed",
				);
				expect(completedRecord).toBeDefined();
				expect(completedRecord?.output).toContain("result=async-val");
			} finally {
				unsubscribe();
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("supports backgroundRequested policy for run and validate with background: true", async () => {
		const harness = await createHarness();

		try {
			const def = harness.session.getToolDefinition("task_automation");
			expect(def).toBeDefined();
			const isBg = (input: TaskAutomationInput) => def?.backgroundRequested?.(input as never);
			expect(isBg({ action: "run", name: "bg-tool", background: true })).toBe(true);
			expect(isBg({ action: "run", name: "bg-tool", background: false })).toBe(false);
			expect(isBg({ action: "validate", name: "bg-tool", background: true })).toBe(true);
			expect(isBg({ action: "validate", name: "bg-tool" })).toBe(false);
			expect(isBg({ action: "spec", name: "bg-tool", background: true })).toBe(false);
			expect(isBg({ action: "bind", name: "bg-tool", background: true })).toBe(false);
			expect(isBg({ action: "status", name: "bg-tool", background: true })).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("ensures dynamic registered automation has ONE authorizer owner: exactly one authorizer call for task_automation and run_toolkit_script, denied => zero spawn, static authorized once", async () => {
		const harness = await createHarness();
		const scriptRelPath = writeCalcScript(harness.tempDir);

		try {
			const testExtensionContext = {} as ExtensionContext;
			let hostAuthorizerCalls = 0;
			let hostAuthorizerAllow = true;
			const hostAuthorizer: ToolkitScriptAuthorizer = async (_req, _sig) => {
				hostAuthorizerCalls++;
				return {
					authorized: hostAuthorizerAllow,
					reason: hostAuthorizerAllow ? undefined : "Denied by host authorizer",
				};
			};

			let executorCalls = 0;
			const trackedExecutor = async (
				command: string,
				argv: readonly string[],
				cwd: string,
				timeoutMs: number,
				signal?: AbortSignal,
			) => {
				executorCalls++;
				return spawnScriptExecutor(command, [...argv], cwd, timeoutMs, signal);
			};

			const adapter = new TaskAutomationRuntimeAdapter({
				getCwd: () => harness.tempDir,
				getSessionManager: () => harness.session.sessionManager,
				authorize: hostAuthorizer,
				executor: trackedExecutor,
			});

			const controller = adapter.getController();
			const taskAutomationTool = adapter.createToolDefinition();

			// 1. Author and validate dynamic dangerous script
			controller.author({
				name: "dangerous-calc",
				description: "Dangerous calculation automation",
				runner,
				path: scriptRelPath,
				danger: true,
				contract: {
					inputs: [{ name: "v", type: "string", description: "val" }],
					outputs: { format: "text", description: "res", contains: "result=" },
					preconditions: ["exists"],
					effects: ["runs"],
					failure: ["fails"],
					verifier: {
						args: ["ok"],
						expectedExitCode: 0,
						expectedOutput: "result=ok",
						negativeControls: [
							{
								description: "neg",
								args: ["invalid"],
								expectedExitCode: 1,
								expectedError: "invalid arg",
							},
						],
					},
				},
			});

			// Validate with host authorizer allowing
			const val = await controller.validate("dangerous-calc");
			expect(val.success).toBe(true);

			const staticRelPath = writeStaticScript(harness.tempDir);
			const staticScripts: ToolkitScript[] = [
				{
					name: "dangerous-static",
					description: "Dangerous static script",
					runner,
					path: staticRelPath,
					danger: true,
				},
			];

			let outerStaticAuthorizerCalls = 0;
			const runToolkitScriptTool = createRunToolkitScriptToolDefinition({
				getScripts: () => [...adapter.getCombinedScripts(staticScripts)],
				execute: (script, args, signal) => adapter.executeScript(script, args, signal),
				authorize: (request, signal) => {
					return adapter.authorizeToolkitScript(
						request,
						async (req, sig) => {
							outerStaticAuthorizerCalls++;
							return hostAuthorizer(req, sig);
						},
						signal,
					);
				},
			});

			// --- 1. task_automation tool action: "run" (single authorizer owner: controller.run) ---
			// 1a. Denied => exactly 1 host authorizer call, 0 executor spawns
			hostAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = false;
			const toolRunDenied = (await taskAutomationTool.execute(
				"call-task-denied",
				{ action: "run", name: "dangerous-calc", args: ["denied-val"] },
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; content: Array<{ text: string }> };
			expect(toolRunDenied.isError).toBe(true);
			expect(toolRunDenied.content[0].text).toContain("Denied by host authorizer");
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(0);

			// 1b. Approved => exactly 1 host authorizer call, 1 executor spawn
			hostAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = true;
			const toolRunApproved = (await taskAutomationTool.execute(
				"call-task-approved",
				{ action: "run", name: "dangerous-calc", args: ["approved-val"] },
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; content: Array<{ text: string }> };
			expect(toolRunApproved.isError).toBeFalsy();
			expect(toolRunApproved.content[0].text).toContain("result=approved-val");
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(1);

			// --- 2. Dynamic automation via run_toolkit_script ---
			// 2a. Denied => outer static authorizer deferred (0 calls), controller.run authorizes (1 call), 0 executor spawns
			hostAuthorizerCalls = 0;
			outerStaticAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = false;
			const toolDenied = (await runToolkitScriptTool.execute(
				"call-dyn-denied",
				{
					script: "dangerous-calc",
					args: ["tool-denied"],
				},
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; details?: unknown };
			expect(outerStaticAuthorizerCalls).toBe(0);
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(0);
			expect(toolDenied.isError).toBe(true);

			// 2b. Approved => outer static authorizer deferred (0 calls), controller.run authorizes (1 call), 1 executor spawn
			hostAuthorizerCalls = 0;
			outerStaticAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = true;
			const toolApproved = (await runToolkitScriptTool.execute(
				"call-dyn-approved",
				{
					script: "dangerous-calc",
					args: ["tool-approved"],
				},
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; details?: unknown };
			expect(outerStaticAuthorizerCalls).toBe(0);
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(1);
			expect(toolApproved.isError).toBeFalsy();

			// --- 3. Static dangerous script via run_toolkit_script ---
			// 3a. Denied => outer static authorizer called (1 call), host authorizer called (1 call), 0 executor spawns
			hostAuthorizerCalls = 0;
			outerStaticAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = false;
			const staticDenied = (await runToolkitScriptTool.execute(
				"call-static-denied",
				{
					script: "dangerous-static",
					args: ["static-denied"],
				},
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; details?: unknown };
			expect(outerStaticAuthorizerCalls).toBe(1);
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(0);
			expect(staticDenied.isError).toBe(true);
			expect(asRunDetails(staticDenied.details)?.outcome).toBe("confirmation_required");

			// 3b. Approved => outer static authorizer called (1 call), host authorizer called (1 call), 1 executor spawn
			hostAuthorizerCalls = 0;
			outerStaticAuthorizerCalls = 0;
			executorCalls = 0;
			hostAuthorizerAllow = true;
			const staticApproved = (await runToolkitScriptTool.execute(
				"call-static-approved",
				{
					script: "dangerous-static",
					args: ["static-approved"],
				},
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; details?: unknown };
			expect(outerStaticAuthorizerCalls).toBe(1);
			expect(hostAuthorizerCalls).toBe(1);
			expect(executorCalls).toBe(1);
			expect(staticApproved.isError).toBeFalsy();

			// --- 4. Unstamped dangerous matching script: outer authorize rejects; session clear/switch -> execute MUST have no raw execution ---
			const unstampedDangerousScript: ToolkitScript = {
				name: "dangerous-calc",
				description: "Ad-hoc unstamped matching script",
				runner,
				path: scriptRelPath,
				danger: true,
			};

			hostAuthorizerCalls = 0;
			outerStaticAuthorizerCalls = 0;
			executorCalls = 0;

			// 4a. Outer authorize explicitly rejects unstamped script that matches active registered automation
			const unstampedAuthDecision = await adapter.authorizeToolkitScript(
				{ script: unstampedDangerousScript, args: ["unstamped-val"] },
				async (req, sig) => {
					outerStaticAuthorizerCalls++;
					return hostAuthorizer(req, sig);
				},
			);
			expect(unstampedAuthDecision.authorized).toBe(false);
			expect(unstampedAuthDecision.reason).toContain("lacks dynamic provenance");
			expect(outerStaticAuthorizerCalls).toBe(0);
			expect(hostAuthorizerCalls).toBe(0);
			expect(executorCalls).toBe(0);

			// 4b. Tool invocation with unstamped script: outer authorize blocks it before execution
			const unstampedToolDef = createRunToolkitScriptToolDefinition({
				getScripts: () => [unstampedDangerousScript],
				execute: (script, args, signal) => adapter.executeScript(script, args, signal),
				authorize: (request, signal) =>
					adapter.authorizeToolkitScript(
						request,
						async (req, sig) => {
							outerStaticAuthorizerCalls++;
							return hostAuthorizer(req, sig);
						},
						signal,
					),
			});

			const unstampedToolRun = (await unstampedToolDef.execute(
				"call-unstamped-denied",
				{
					script: "dangerous-calc",
					args: ["unstamped-val"],
				},
				undefined,
				undefined,
				testExtensionContext,
			)) as { isError?: boolean; details?: unknown };
			expect(unstampedToolRun.isError).toBe(true);
			expect(asRunDetails(unstampedToolRun.details)?.outcome).toBe("confirmation_required");
			expect(outerStaticAuthorizerCalls).toBe(0);
			expect(hostAuthorizerCalls).toBe(0);
			expect(executorCalls).toBe(0);

			// 4c. Switched session: tool invocation still requires authorization and MUST never run raw without auth
			const switchedHarness = await createHarness();
			try {
				const switchedAdapter = new TaskAutomationRuntimeAdapter({
					getCwd: () => harness.tempDir,
					getSessionManager: () => switchedHarness.session.sessionManager,
					authorize: hostAuthorizer,
					executor: trackedExecutor,
				});

				let switchedStaticAuthCalls = 0;
				hostAuthorizerAllow = false;
				const switchedToolDef = createRunToolkitScriptToolDefinition({
					getScripts: () => [unstampedDangerousScript],
					execute: (script, args, signal) => switchedAdapter.executeScript(script, args, signal),
					authorize: (request, signal) =>
						switchedAdapter.authorizeToolkitScript(
							request,
							async (req, sig) => {
								switchedStaticAuthCalls++;
								return hostAuthorizer(req, sig);
							},
							signal,
						),
				});

				const switchedRun = (await switchedToolDef.execute(
					"call-switched-denied",
					{
						script: "dangerous-calc",
						args: ["switched-val"],
					},
					undefined,
					undefined,
					testExtensionContext,
				)) as { isError?: boolean; details?: unknown };
				expect(switchedRun.isError).toBe(true);
				expect(asRunDetails(switchedRun.details)?.outcome).toBe("confirmation_required");
				expect(switchedStaticAuthCalls).toBe(1);
				expect(hostAuthorizerCalls).toBe(1);
				expect(executorCalls).toBe(0);
			} finally {
				await switchedHarness.cleanup();
			}
		} finally {
			await harness.cleanup();
		}
	});
});
