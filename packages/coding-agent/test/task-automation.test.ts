import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateOutputContract,
	MAX_ARG_LENGTH,
	MAX_OUTPUT_EXCERPT_BYTES,
	type TaskAutomationDefinition,
	type TaskAutomationOperationContract,
	type TaskAutomationStepBinding,
	validateTaskAutomationContract,
} from "../src/core/automation/contracts.ts";
import {
	appendTaskAutomationStateSnapshot,
	cloneTaskAutomationState,
	createSessionTaskAutomationStoragePort,
	getLatestTaskAutomationStateSnapshot,
	recoverAutomationInFlight,
	type TaskAutomationState,
} from "../src/core/automation/session-task-automation.ts";
import { TaskAutomationController } from "../src/core/automation/task-automation-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createTaskAutomationToolDefinition } from "../src/core/tools/task-automation.ts";

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createValidContract(overrides?: Partial<TaskAutomationOperationContract>): TaskAutomationOperationContract {
	return {
		inputs: [{ name: "target", type: "string", description: "target item" }],
		outputs: { format: "text", description: "output summary", contains: "COMPLETED: ok" },
		preconditions: ["database running"],
		effects: ["item updated"],
		failure: ["invalid item id"],
		verifier: {
			args: ["--test"],
			expectedOutput: "VERIFIER_OK",
			expectedExitCode: 0,
			negativeControls: [
				{
					description: "Rejects invalid id",
					args: ["--invalid-id"],
					expectedExitCode: 1,
					expectedError: "ERROR: invalid id",
				},
			],
		},
		...overrides,
	};
}

describe("TaskAutomation Comprehensive Unit Suite", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "task-automation-unit-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	describe("1. Contract and Declarative Output Assertions", () => {
		it("validates valid contract successfully", () => {
			const contract = createValidContract();
			const result = validateTaskAutomationContract(contract);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("rejects non-object and missing required sections", () => {
			expect(validateTaskAutomationContract(null).valid).toBe(false);
			expect(validateTaskAutomationContract({}).valid).toBe(false);
			expect(
				validateTaskAutomationContract({
					outputs: { format: "text", description: "d" },
				}).valid,
			).toBe(false);
		});

		it("rejects missing contains or expectedOutput in contract", () => {
			const contractMissingContains = createValidContract({
				outputs: { format: "text", description: "desc", contains: "" },
			});
			expect(validateTaskAutomationContract(contractMissingContains).valid).toBe(false);

			const contractMissingExpectedOutput = createValidContract({
				verifier: {
					args: ["--test"],
					expectedOutput: "",
					negativeControls: [
						{
							description: "Rejects invalid id",
							args: ["--invalid-id"],
							expectedExitCode: 1,
						},
					],
				},
			});
			expect(validateTaskAutomationContract(contractMissingExpectedOutput).valid).toBe(false);
		});

		it("evaluates output contracts correctly", () => {
			// json format
			const jsonOutput = { format: "json" as const, description: "json output", contains: '"key"' };
			expect(evaluateOutputContract(jsonOutput, '{"key": "value"}').valid).toBe(true);
			expect(evaluateOutputContract(jsonOutput, "not json").valid).toBe(false);
			expect(evaluateOutputContract(jsonOutput, "").valid).toBe(false);

			// lines format
			const linesOutput = { format: "lines" as const, description: "lines output", contains: "line 1" };
			expect(evaluateOutputContract(linesOutput, "line 1\nline 2").valid).toBe(true);
			expect(evaluateOutputContract(linesOutput, "   ").valid).toBe(false);

			// text contains check
			const textOutput = {
				format: "text" as const,
				description: "substring test",
				contains: "ITEM-42",
			};
			expect(evaluateOutputContract(textOutput, "prefix ITEM-42 suffix").valid).toBe(true);
			expect(evaluateOutputContract(textOutput, "MISMATCH").valid).toBe(false);
		});
	});

	describe("2. Pure Deep Copy & Restore In-Flight Recovery", () => {
		it("cloneTaskAutomationState preserves executing state and detaches nested objects", () => {
			const original: TaskAutomationState = {
				version: 1,
				revision: 2,
				createdAt: "2026-09-12T10:00:00.000Z",
				updatedAt: "2026-09-12T10:01:00.000Z",
				automations: [
					{
						name: "exec-item",
						description: "Active item",
						runner: "bash",
						path: "s.sh",
						state: "executing",
						contract: createValidContract(),
						binding: { stepId: "step-1", expectedArgs: ["--flag"] },
						createdAt: "2026-09-12T10:00:00.000Z",
						updatedAt: "2026-09-12T10:01:00.000Z",
					},
				],
			};

			const cloned = cloneTaskAutomationState(original);
			expect(cloned.automations[0].state).toBe("executing");
			expect(cloned.automations[0]).not.toBe(original.automations[0]);
			expect(cloned.automations[0].contract).not.toBe(original.automations[0].contract);
			expect(cloned.automations[0].binding).not.toBe(original.automations[0].binding);
		});

		it("recoverAutomationInFlight converts executing to terminal failed", () => {
			const executing: TaskAutomationDefinition = {
				name: "crashed",
				description: "desc",
				runner: "bash",
				path: "crashed.sh",
				state: "executing",
				contract: createValidContract(),
				createdAt: "2026-09-12T10:00:00.000Z",
				updatedAt: "2026-09-12T10:01:00.000Z",
			};

			const recovered = recoverAutomationInFlight(executing, "2026-09-12T10:05:00.000Z");
			expect(recovered.state).toBe("failed");
			expect(recovered.lastExecution?.outcome).toBe("failed");
			expect(recovered.lastExecution?.error).toBe("interrupted_by_session_restore");
		});

		it("latest malformed record does not fall back to stale ready snapshot", () => {
			const sessionManager = SessionManager.inMemory(tempDir);

			// Append valid snapshot with ready automation
			const validReadyState: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						name: "stale-ready",
						description: "older valid ready",
						runner: "bash",
						path: "s.sh",
						state: "ready",
						contract: createValidContract(),
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
			};
			appendTaskAutomationStateSnapshot(sessionManager, validReadyState);

			// Append a malformed record as the newest entry on branch
			sessionManager.appendCustomEntry("task_automation_state", {
				version: 1,
				state: { corrupt: "not a valid task automation state" },
			});

			// getLatestTaskAutomationStateSnapshot must return undefined, NOT fall back to older valid snapshot
			const latest = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(latest).toBeUndefined();
		});
	});

	describe("3. Task Step Binding Invariant & Exact Argv Contract", () => {
		it("bindStep requires exact expectedArgs array and clears prior execution", async () => {
			const scriptPath = "action.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async () => ({
					exitCode: 0,
					stdout: "VERIFIER_OK COMPLETED: ok",
					stderr: "",
					durationMs: 5,
					timedOut: false,
				}),
			});

			controller.author({
				name: "step-binder",
				description: "Binding test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await controller.validate("step-binder");

			// Bind step with exact expectedArgs
			const binding: TaskAutomationStepBinding = {
				stepId: "step-step1",
				expectedArgs: ["--exact", "param"],
				operationIdentity: "op-1",
			};
			controller.bindStep("step-binder", binding);

			const automation = controller.getAutomation("step-binder");
			expect(automation?.binding?.stepId).toBe("step-step1");
			expect(automation?.binding?.expectedArgs).toEqual(["--exact", "param"]);
			expect(automation?.binding?.operationIdentity).toBe("op-1");
			// Rebinding clears execution evidence
			expect(automation?.lastExecution).toBeUndefined();
		});

		it("assertTaskStepsTransition enforces status, exact args, and hash", async () => {
			const scriptPath = "action.sh";
			const fullPath = join(tempDir, scriptPath);
			writeFileSync(fullPath, "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: "VERIFIER_OK COMPLETED: ok",
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: "COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "step-guard",
				description: "Guard test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
				binding: {
					stepId: "step-deploy",
					expectedArgs: ["--prod"],
				},
			});

			// Validation
			await controller.validate("step-guard");

			// Cannot complete before execution succeeds
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-deploy", status: "completed" }]);
			}).toThrow("has not executed successfully");

			// Run with WRONG args
			await controller.run("step-guard", ["--staging"]);

			// Still cannot complete because args mismatch
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-deploy", status: "completed" }]);
			}).toThrow('expecting args ["--prod"], but last execution ran with ["--staging"]');

			// Run with CORRECT expected args
			const runCorrect = await controller.run("step-guard", ["--prod"]);
			expect(runCorrect.outcome).toBe("succeeded");

			// Now step completion passes without error
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-deploy", status: "completed" }]);
			}).not.toThrow();

			// Tamper on disk: completion check immediately rejects
			writeFileSync(fullPath, "echo 'TAMPERED'", "utf8");
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-deploy", status: "completed" }]);
			}).toThrow("has not executed successfully");
		});
	});

	describe("4. executeAdmittedScript Failure Propagation", () => {
		it("propagates non-zero exit and error details when output contract fails despite underlying exit 0", async () => {
			const scriptPath = "exit-zero-bad-output.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: "VERIFIER_OK COMPLETED: ok",
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					// Exit 0, but output does NOT contain "COMPLETED: ok"
					return { exitCode: 0, stdout: "WRONG_OUTPUT_SHAPE", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "contract-failure-propagator",
				description: "Output contract test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await controller.validate("contract-failure-propagator");

			// executeAdmittedScript MUST propagate non-zero exit code!
			const execution = await controller.executeAdmittedScript("contract-failure-propagator", []);
			expect(execution.exitCode).not.toBe(0);
			expect(execution.exitCode).toBe(1);
			expect(execution.stderr).toContain("Output does not contain required substring");
		});
	});

	describe("5. Scope Identity Live Refresh", () => {
		it("detects branch changes and automatically refreshes from storage", () => {
			let currentBranch = "main";
			const sessionManager = SessionManager.inMemory(tempDir);

			const controller = new TaskAutomationController({
				context: {
					getCwd: () => tempDir,
					getBranchId: () => currentBranch,
				},
				storage: createSessionTaskAutomationStoragePort(sessionManager),
			});

			controller.author({
				name: "main-automation",
				description: "On main branch",
				runner: "bash",
				path: "main.sh",
				contract: createValidContract(),
			});

			expect(controller.getAutomations()).toHaveLength(1);

			// Switch to a new branch in the context port
			currentBranch = "feature-branch";

			// Querying controller refreshes from storage automatically
			expect(controller.getState().revision).toBeGreaterThanOrEqual(1);
		});
	});

	describe("6. TaskAutomation Tool Definition", () => {
		it("executes spec, bind, validate, run, and status actions through the model-facing tool", async () => {
			const scriptPath = "tool-test.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: "VERIFIER_OK COMPLETED: ok",
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: "COMPLETED: ok tool run", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			const tool = createTaskAutomationToolDefinition(controller);
			const mockCtx = { cwd: tempDir } as unknown as ExtensionContext;

			// 1. spec action
			const specResult = await tool.execute(
				"call-1",
				{
					action: "spec",
					name: "tool-auto",
					description: "Authored via tool",
					runner: "bash",
					path: scriptPath,
					contract: createValidContract(),
					stepId: "step-tool",
					args: ["--tool-arg"],
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(specResult.isError).toBeFalsy();
			const specContent = specResult.content[0];
			expect(specContent.type).toBe("text");
			if (specContent.type === "text") {
				expect(specContent.text).toContain("specification recorded");
			}

			// 2. bind action
			const bindResult = await tool.execute(
				"call-2",
				{
					action: "bind",
					name: "tool-auto",
					stepId: "step-tool-rebound",
					args: ["--tool-arg-2"],
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(bindResult.isError).toBeFalsy();
			const bindContent = bindResult.content[0];
			expect(bindContent.type).toBe("text");
			if (bindContent.type === "text") {
				expect(bindContent.text).toContain('Bound task step "step-tool-rebound"');
			}

			// 3. validate action
			const validateResult = await tool.execute(
				"call-3",
				{
					action: "validate",
					name: "tool-auto",
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(validateResult.isError).toBeFalsy();
			const valContent = validateResult.content[0];
			expect(valContent.type).toBe("text");
			if (valContent.type === "text") {
				expect(valContent.text).toContain("Validation SUCCEEDED");
			}

			// 4. run action
			const runResult = await tool.execute(
				"call-4",
				{
					action: "run",
					name: "tool-auto",
					args: ["--tool-arg-2"],
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(runResult.isError).toBeFalsy();
			const runContent = runResult.content[0];
			expect(runContent.type).toBe("text");
			if (runContent.type === "text") {
				expect(runContent.text).toContain("succeeded (exit code 0)");
			}

			// 5. status action (single)
			const statusResult = await tool.execute(
				"call-5",
				{
					action: "status",
					name: "tool-auto",
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(statusResult.isError).toBeFalsy();
			const statusContent = statusResult.content[0];
			expect(statusContent.type).toBe("text");
			if (statusContent.type === "text") {
				expect(statusContent.text).toContain("tool-auto");
			}

			// 6. status action (all summary - avoids flooding)
			const allStatusResult = await tool.execute(
				"call-6",
				{
					action: "status",
				},
				undefined,
				undefined,
				mockCtx,
			);
			expect(allStatusResult.isError).toBeFalsy();
			const allStatusContent = allStatusResult.content[0];
			expect(allStatusContent.type).toBe("text");
			if (allStatusContent.type === "text") {
				expect(allStatusContent.text).toContain("Task automations (1)");
			}
			const details = allStatusResult.details as { outcome: string; automations: unknown[] };
			expect(details.outcome).toBe("status");
			expect(Array.isArray(details.automations)).toBe(true);
		});
	});

	describe("7. Bounded Persisted Outputs & Excerpts", () => {
		it("checks full output against contract but bounds persisted evidence and execution stdout", async () => {
			const scriptPath = "large-output.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const hugeChunk = "x".repeat(30_000);
			const verifierFullStdout = `VERIFIER_OK COMPLETED: ok ${hugeChunk}`;
			const runFullStdout = `COMPLETED: ok ${hugeChunk}`;

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: verifierFullStdout, stderr: "", durationMs: 10, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: runFullStdout, stderr: "", durationMs: 10, timedOut: false };
				},
			});

			controller.author({
				name: "large-auto",
				description: "Large output test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const valResult = await controller.validate("large-auto");
			expect(valResult.success).toBe(true);

			// Evidence stdout is bounded to MAX_OUTPUT_EXCERPT_BYTES
			const evidence = valResult.evidence;
			expect(evidence).toBeDefined();
			expect(Buffer.byteLength(evidence!.verifierStdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
			expect(evidence!.verifierStdout).toContain("... [truncated]");

			// Run execution stdout is also bounded
			const runRes = await controller.run("large-auto", []);
			expect(runRes.outcome).toBe("succeeded");
			const auto = controller.getAutomation("large-auto");
			expect(auto?.lastExecution?.outcome).toBe("succeeded");
			expect(Buffer.byteLength(auto!.lastExecution!.stdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
			expect(auto!.lastExecution!.stdout).toContain("... [truncated]");
		});
	});

	describe("8. Persistence Invariants & Strict Decoder Roundtrip", () => {
		it("invalid author or bind input leaves revision/state unchanged and valid state roundtrips through decoder", async () => {
			const scriptPath = "valid-roundtrip.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			controller.author({
				name: "valid-auto",
				description: "Valid automation",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const revBefore = controller.getState().revision;
			expect(revBefore).toBe(1);

			// 1. Invalid author input (malformed contract) must throw and leave revision unchanged
			expect(() => {
				controller.author({
					name: "bad-auto",
					description: "Bad contract",
					runner: "bash",
					path: scriptPath,
					contract: { ...createValidContract(), outputs: { format: "text", description: "d", contains: "" } },
				});
			}).toThrow();

			expect(controller.getState().revision).toBe(revBefore);
			expect(controller.getAutomations()).toHaveLength(1);

			// 2. Invalid bind input (empty stepId) must throw and leave revision unchanged
			expect(() => {
				controller.bindStep("valid-auto", {
					stepId: "   ",
					expectedArgs: [],
				});
			}).toThrow();

			expect(controller.getState().revision).toBe(revBefore);

			// 3. Stored state roundtrips cleanly through the strict decoder
			const decoded = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(decoded).toBeDefined();
			expect(decoded?.revision).toBe(revBefore);
			expect(decoded?.automations[0].name).toBe("valid-auto");
		});

		it("rejects oversize/malformed run args BEFORE authorize or spawn using canonical args schema", async () => {
			const scriptPath = "args-check.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			let authorizeCalled = false;
			let spawnCalled = false;

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async () => {
					spawnCalled = true;
					return { exitCode: 0, stdout: "VERIFIER_OK COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
				authorize: async () => {
					authorizeCalled = true;
					return { authorized: true };
				},
			});

			controller.author({
				name: "args-auto",
				description: "Args check",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await controller.validate("args-auto");

			// Reset flags after validation
			authorizeCalled = false;
			spawnCalled = false;

			// Run with an argument exceeding MAX_ARG_LENGTH (500)
			const oversizedArg = "a".repeat(MAX_ARG_LENGTH + 10);
			const runResult = await controller.run("args-auto", [oversizedArg]);

			expect(runResult.outcome).toBe("failed");
			expect(runResult.error).toContain("Run arguments violate schema bounds");
			expect(authorizeCalled).toBe(false);
			expect(spawnCalled).toBe(false);
		});

		it("failed run with large stdout/stderr persists bounded terminal result and survives restore", async () => {
			const scriptPath = "failed-large.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const hugeChunk = "e".repeat(30_000);
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: "VERIFIER_OK COMPLETED: ok",
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					// Production run fails with non-zero exit and huge stderr/stdout
					return {
						exitCode: 2,
						stdout: `FAILED OUTPUT ${hugeChunk}`,
						stderr: `FAILED ERROR ${hugeChunk}`,
						durationMs: 5,
						timedOut: false,
					};
				},
			});

			controller.author({
				name: "fail-auto",
				description: "Failed large test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await controller.validate("fail-auto");

			const runRes = await controller.run("fail-auto", []);
			expect(runRes.outcome).toBe("failed");

			// Persisted execution result is bounded
			const auto = controller.getAutomation("fail-auto");
			expect(auto?.lastExecution?.outcome).toBe("failed");
			expect(Buffer.byteLength(auto!.lastExecution!.stdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
			expect(Buffer.byteLength(auto!.lastExecution!.stderr, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
			expect(Buffer.byteLength(auto!.lastExecution!.error ?? "", "utf8")).toBeLessThanOrEqual(
				MAX_OUTPUT_EXCERPT_BYTES,
			);

			// Survives strict decoder on restore
			const restored = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(restored).toBeDefined();
			expect(restored?.automations[0].lastExecution?.outcome).toBe("failed");
			expect(restored?.automations[0].lastExecution?.exitCode).toBe(2);
		});
	});

	describe("9. Controller Invariant Regressions", () => {
		it("stale failed validation discarded and does not overwrite replacement re-author", async () => {
			const scriptPath = "stale-val.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const fixtureGate = createDeferred<void>();

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						await fixtureGate.promise;
						// Fails when it finally finishes
						return { exitCode: 1, stdout: "", stderr: "Verifier failed", durationMs: 5, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "err", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "stale-val",
				description: "Original authoring",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			// Start validation (pauses inside executor awaiting fixtureGate)
			const valPromise = controller.validate("stale-val");

			// While validation is paused, re-author the automation
			controller.author({
				name: "stale-val",
				description: "Re-authored automation",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			// Release the paused validation
			fixtureGate.resolve();
			const valResult = await valPromise;

			// Obsolete validation must be reported and discarded
			expect(valResult.success).toBe(false);

			// The automation state in controller MUST NOT be overwritten to "failed"; it must remain the re-authored version
			const auto = controller.getAutomation("stale-val");
			expect(auto?.description).toBe("Re-authored automation");
			expect(auto?.state).toBe("building");
			expect(auto?.generation).toBe(2);
		});

		it("in-flight validating fixture failure with explicit started barrier does not overwrite replacement re-author", async () => {
			const scriptPath = "stale-val-barrier.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const fixtureStarted = createDeferred<void>();
			const fixtureGate = createDeferred<void>();

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						fixtureStarted.resolve();
						await fixtureGate.promise;
						return { exitCode: 1, stdout: "", stderr: "Verifier failed", durationMs: 5, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "err", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "barrier-auto",
				description: "Original barrier authoring",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const valPromise = controller.validate("barrier-auto");

			// Wait until validation has transitioned to validating and reached executor
			await fixtureStarted.promise;
			expect(controller.getAutomation("barrier-auto")?.state).toBe("validating");

			// While validation is paused in-flight, re-author the automation
			controller.author({
				name: "barrier-auto",
				description: "Re-authored barrier automation",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});
			expect(controller.getAutomation("barrier-auto")?.state).toBe("building");

			// Release the paused validation
			fixtureGate.resolve();
			const valResult = await valPromise;

			expect(valResult.success).toBe(false);

			const auto = controller.getAutomation("barrier-auto");
			expect(auto?.description).toBe("Re-authored barrier automation");
			expect(auto?.state).toBe("building");
			expect(auto?.generation).toBe(2);
		});

		it("spawns no next fixture after authorization when intervening mutation occurs", async () => {
			const scriptPath = "stale-auth.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const authGate = createDeferred<void>();
			let spawnCalled = false;

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				authorize: async () => {
					await authGate.promise;
					return { authorized: true };
				},
				executor: async () => {
					spawnCalled = true;
					return { exitCode: 0, stdout: "VERIFIER_OK COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "stale-auth",
				description: "Original authoring",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const valPromise = controller.validate("stale-auth");

			// Intervening mutation while authorize is waiting
			controller.author({
				name: "stale-auth",
				description: "Mutated during auth",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			// Release authorizer
			authGate.resolve();
			const valResult = await valPromise;

			expect(valResult.success).toBe(false);
			expect(valResult.reason).toContain("Automation was modified during authorization");
			// Crucial: no fixture spawn ever occurred
			expect(spawnCalled).toBe(false);
		});

		it("enforces both contract outputs (JSON/contains) and verifier expectedOutput on positive fixture", async () => {
			const scriptPath = "json-val.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			let positiveStdout = "";

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: positiveStdout, stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: positiveStdout, stderr: "", durationMs: 5, timedOut: false };
				},
			});

			const jsonContract = createValidContract({
				outputs: { format: "json", description: "JSON output", contains: "success_token" },
				verifier: {
					args: ["--test"],
					expectedOutput: "VERIFIER_PASS",
					negativeControls: [
						{
							description: "Rejects invalid id",
							args: ["--invalid-id"],
							expectedExitCode: 1,
							expectedError: "ERROR: invalid id",
						},
					],
				},
			});

			controller.author({
				name: "json-auto",
				description: "JSON contract automation",
				runner: "bash",
				path: scriptPath,
				contract: jsonContract,
			});

			// Case 1: Verifier expectedOutput passes, but stdout is invalid JSON
			positiveStdout = "VERIFIER_PASS success_token NOT_JSON";
			const valFailJson = await controller.validate("json-auto");
			expect(valFailJson.success).toBe(false);
			expect(valFailJson.reason).toContain("Positive fixture stdout did not satisfy contract output requirements");

			// Case 2: Valid JSON and verifier expectedOutput present, but missing declared contract contains
			positiveStdout = JSON.stringify({ message: "VERIFIER_PASS", other: "val" });
			const valFailContains = await controller.validate("json-auto");
			expect(valFailContains.success).toBe(false);
			expect(valFailContains.reason).toContain(
				"Positive fixture stdout did not satisfy contract output requirements",
			);

			// Case 3: Valid JSON, contract contains satisfied, AND verifier expectedOutput satisfied
			positiveStdout = JSON.stringify({ token: "success_token", status: "VERIFIER_PASS" });
			const valSuccess = await controller.validate("json-auto");
			expect(valSuccess.success).toBe(true);
			expect(valSuccess.state).toBe("ready");
		});

		it("protects persisted execution evidence against in-place caller argument array mutations", async () => {
			const scriptPath = "mutation-args.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return {
						exitCode: 0,
						stdout: "VERIFIER_OK COMPLETED: ok",
						stderr: "",
						durationMs: 5,
						timedOut: false,
					};
				},
			});

			controller.author({
				name: "mutate-auto",
				description: "Mutation test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const valRes = await controller.validate("mutate-auto");
			expect(valRes.success).toBe(true);

			const mutableArgs = ["original-arg1", "original-arg2"];
			const runPromise = controller.run("mutate-auto", mutableArgs);

			// Caller mutates array in-place immediately after call
			mutableArgs[0] = "MUTATED_VALUE";
			mutableArgs.push("POISON_ARG");

			const runRes = await runPromise;
			expect(runRes.outcome).toBe("succeeded");

			const auto = controller.getAutomation("mutate-auto");
			expect(auto?.lastExecution?.args).toEqual(["original-arg1", "original-arg2"]);
		});

		it("bounds huge thrown executor error and persists terminal failed state without throwing", async () => {
			const scriptPath = "throw-huge.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			let throwHuge = false;

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: "VERIFIER_OK COMPLETED: ok",
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					if (throwHuge) {
						throw new Error(`CRITICAL_FAILURE_${"x".repeat(30_000)}`);
					}
					return { exitCode: 0, stdout: "VERIFIER_OK COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "throw-auto",
				description: "Throw huge test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await controller.validate("throw-auto");

			throwHuge = true;
			const runRes = await controller.run("throw-auto", []);

			expect(runRes.outcome).toBe("failed");
			expect(runRes.error).toBeDefined();
			expect(Buffer.byteLength(runRes.error!, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);

			// Check that automation transitioned to failed and lastExecution is persisted and bounded
			const auto = controller.getAutomation("throw-auto");
			expect(auto?.state).toBe("failed");
			expect(auto?.lastExecution?.outcome).toBe("failed");
			expect(Buffer.byteLength(auto!.lastExecution!.stderr, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
			expect(Buffer.byteLength(auto!.lastExecution!.error ?? "", "utf8")).toBeLessThanOrEqual(
				MAX_OUTPUT_EXCERPT_BYTES,
			);

			// Decodes successfully on restore (did not throw in commitMutation)
			const restored = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(restored?.automations[0].state).toBe("failed");
		});
	});
});
