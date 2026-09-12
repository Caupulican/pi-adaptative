import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	boundedUtf8Excerpt,
	evaluateOutputContract,
	MAX_ARG_LENGTH,
	MAX_AUTOMATION_NAME_LENGTH,
	MAX_OUTPUT_EXCERPT_BYTES,
	MAX_OUTPUT_SUBSTRING_LENGTH,
	MAX_TIMEOUT_MS,
	type TaskAutomationDefinition,
	type TaskAutomationOperationContract,
	validateTaskAutomationContract,
} from "../src/core/automation/contracts.ts";
import {
	appendTaskAutomationStateSnapshot,
	cloneTaskAutomationState,
	createSessionTaskAutomationStoragePort,
	decodeTaskAutomationStateSnapshotPayload,
	getLatestTaskAutomationStateSnapshot,
	recoverAutomationInFlight,
	TASK_AUTOMATION_STATE_CUSTOM_TYPE,
	type TaskAutomationState,
} from "../src/core/automation/session-task-automation.ts";
import {
	type AuthorTaskAutomationInput,
	TaskAutomationController,
} from "../src/core/automation/task-automation-controller.ts";
import type { ScriptExecution, ScriptExecutor } from "../src/core/toolkit/script-runner.ts";
import type { ToolkitScriptAuthorizer } from "../src/core/tools/run-toolkit-script.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
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
		outputs: {
			format: "text",
			description: "output summary",
			contains: "COMPLETED:",
		},
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

describe("TaskAutomationController Adversarial Regression Suite", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "task-automation-adv-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	// 1. Negative Control Failure Enforcement
	describe("1. Negative Control Failure Enforcement", () => {
		it("fails validation when negative control execution times out", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const executor: ScriptExecutor = async (_cmd, argv) => {
				if (argv.includes("--test")) {
					return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
				}
				return { exitCode: null, stdout: "", stderr: "timed out", durationMs: 15000, timedOut: true };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			controller.author({
				name: "timed-out-nc",
				description: "Test negative control timeout",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const result = await controller.validate("timed-out-nc");
			expect(result.success).toBe(false);
			expect(result.state).toBe("failed");
			expect(result.reason).toContain("timed out or crashed without an exit code; clean failure required");
			expect(controller.getAutomation("timed-out-nc")?.state).toBe("failed");
		});

		it("fails validation when negative control crashes with null exit code", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const executor: ScriptExecutor = async (_cmd, argv) => {
				if (argv.includes("--test")) {
					return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
				}
				return { exitCode: null, stdout: "", stderr: "SIGSEGV", durationMs: 5, timedOut: false };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			controller.author({
				name: "null-exit-nc",
				description: "Test negative control crash",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const result = await controller.validate("null-exit-nc");
			expect(result.success).toBe(false);
			expect(result.state).toBe("failed");
			expect(result.reason).toContain("timed out or crashed without an exit code; clean failure required");
		});

		it("fails validation when negative control unexpectedly succeeds with exit code 0", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const executor: ScriptExecutor = async () => {
				return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			controller.author({
				name: "zero-exit-nc",
				description: "Test negative control exiting 0",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const result = await controller.validate("zero-exit-nc");
			expect(result.success).toBe(false);
			expect(result.state).toBe("failed");
			expect(result.reason).toContain(
				"script unexpectedly succeeded or did not produce expected error on invalid input",
			);
		});

		it("rejects contract authoring when negative control specifies expectedExitCode 0", () => {
			const contract = createValidContract({
				verifier: {
					expectedOutput: "VERIFIER_OK",
					negativeControls: [
						{
							description: "Invalid negative control expecting 0",
							args: ["--bad"],
							expectedExitCode: 0,
						},
					],
				},
			});

			const validation = validateTaskAutomationContract(contract);
			expect(validation.valid).toBe(false);
			expect(validation.errors.some((e) => e.includes("cannot be 0; negative controls must expect failure"))).toBe(
				true,
			);

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			expect(() => {
				controller.author({
					name: "illegal-nc-contract",
					description: "Should throw",
					runner: "bash",
					path: "test.sh",
					contract,
				});
			}).toThrow("cannot be 0; negative controls must expect failure");
		});
	});

	// 2. Positive Output Pattern Assertion Enforcement
	describe("2. Positive Output Pattern Assertion Enforcement", () => {
		it("rejects contract when verifier.expectedOutput is missing or empty string", () => {
			const contractEmpty = createValidContract({
				verifier: {
					args: ["--test"],
					expectedOutput: "",
					negativeControls: [{ description: "test", args: ["--bad"], expectedExitCode: 1 }],
				},
			});

			const val = validateTaskAutomationContract(contractEmpty);
			expect(val.valid).toBe(false);
			expect(val.errors.some((e) => e.includes("exit-zero-only validation is prohibited"))).toBe(true);

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			expect(() => {
				controller.author({
					name: "no-pattern-auto",
					description: "Must reject before write",
					runner: "bash",
					path: "script.sh",
					contract: contractEmpty,
				});
			}).toThrow("exit-zero-only validation is prohibited");
		});

		it("enforces literal substring matching on verifier expectedOutput and output contains without regex interpretation", async () => {
			// Invariant (Review Decision): Substring evaluation uses finite includes, NO RegExp.
			// Regex metacharacters like ".*" or "[a-z]+" are treated as literal text.
			const scriptPath = "literal-match.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const executorStdout = "SOME_GENERIC_OUTPUT";
			const executor: ScriptExecutor = async () => {
				return { exitCode: 0, stdout: executorStdout, stderr: "", durationMs: 1, timedOut: false };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			const contractWithRegexChars = createValidContract({
				outputs: {
					format: "text",
					description: "Requires literal bracket pattern",
					contains: "[a-z]+",
				},
				verifier: {
					args: ["--test"],
					// ".*" in regex matches any string, but literally it only matches if ".*" is in stdout
					expectedOutput: ".*",
					negativeControls: [{ description: "test", args: ["--bad"], expectedExitCode: 1 }],
				},
			});

			controller.author({
				name: "literal-auto",
				description: "Literal test",
				runner: "bash",
				path: scriptPath,
				contract: contractWithRegexChars,
			});

			// 1. Verifier output contains "SOME_GENERIC_OUTPUT".
			// A regex ".*" would match, but finite literal substring fails!
			const valFail = await controller.validate("literal-auto");
			expect(valFail.success).toBe(false);

			// 2. Output contract evaluation directly:
			// "hello world" matches regex "[a-z]+", but does not contain literal "[a-z]+"
			const checkFail = evaluateOutputContract(contractWithRegexChars.outputs, "hello world");
			expect(checkFail.valid).toBe(false);
			expect(checkFail.error).toContain("does not contain required substring");

			// 3. String containing literal "[a-z]+" passes
			const checkPass = evaluateOutputContract(contractWithRegexChars.outputs, "result [a-z]+ done");
			expect(checkPass.valid).toBe(true);
		});

		it("fails validation when verifier exits 0 but stdout does not match expected pattern", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const executor: ScriptExecutor = async () => {
				return { exitCode: 0, stdout: "COMPLETED: BUT_WRONG_PATTERN", stderr: "", durationMs: 5, timedOut: false };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			controller.author({
				name: "pattern-mismatch",
				description: "Stdout mismatch",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const result = await controller.validate("pattern-mismatch");
			expect(result.success).toBe(false);
			expect(result.state).toBe("failed");
			expect(controller.getAutomation("pattern-mismatch")?.state).toBe("failed");
		});

		// 2.1 boundedUtf8Excerpt Boundary and Truncation Invariants
		describe("boundedUtf8Excerpt Boundary and Truncation Invariants", () => {
			it("handles empty string and non-positive maxBytes", () => {
				expect(boundedUtf8Excerpt("")).toBe("");
				expect(boundedUtf8Excerpt("hello", 0)).toBe("");
				expect(boundedUtf8Excerpt("hello", -5)).toBe("");
			});

			it("defaults maxBytes to MAX_OUTPUT_EXCERPT_BYTES when unspecified", () => {
				const longText = "a".repeat(MAX_OUTPUT_EXCERPT_BYTES + 100);
				const excerpt = boundedUtf8Excerpt(longText);
				expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_EXCERPT_BYTES);
				expect(excerpt).toContain("... [truncated]");
			});

			it("returns text unchanged when byte length is less than or equal to maxBytes", () => {
				const text = "short text";
				expect(boundedUtf8Excerpt(text, 100)).toBe(text);
				expect(boundedUtf8Excerpt(text, Buffer.byteLength(text, "utf8"))).toBe(text);
			});

			it("bounds output strictly to maxBytes for small budgets <= SUFFIX_BYTES without appending suffix", () => {
				const text = "1234567890abcdefghijklmnopqrstuvwxyz";
				for (let budget = 1; budget <= 16; budget++) {
					const result = boundedUtf8Excerpt(text, budget);
					const byteLen = Buffer.byteLength(result, "utf8");
					expect(byteLen).toBeLessThanOrEqual(budget);
					expect(result.includes("truncated")).toBe(false);
				}
			});

			it("handles exact suffix boundary and appends truncation marker without exceeding maxBytes", () => {
				const text = "abcdefghijklmnopqrstuvwxyz0123456789";
				// SUFFIX_BYTES is 16
				const atBoundary = boundedUtf8Excerpt(text, 16);
				expect(Buffer.byteLength(atBoundary, "utf8")).toBeLessThanOrEqual(16);

				const aboveBoundary = boundedUtf8Excerpt(text, 17);
				expect(Buffer.byteLength(aboveBoundary, "utf8")).toBeLessThanOrEqual(17);
				expect(aboveBoundary).toContain("... [truncated]");
			});

			it("preserves UTF-8 multibyte character boundaries and never produces corrupt code points", () => {
				// Multi-byte chars: '🚀' (4 bytes), 'é' (2 bytes), '€' (3 bytes), '🌍' (4 bytes)
				const multiText = "A🚀BéC€D🌍End";
				const totalBytes = Buffer.byteLength(multiText, "utf8");

				for (let budget = 1; budget <= totalBytes + 5; budget++) {
					const excerpt = boundedUtf8Excerpt(multiText, budget);
					const excerptBytes = Buffer.byteLength(excerpt, "utf8");
					expect(excerptBytes).toBeLessThanOrEqual(budget);
					// Must not contain replacement character U+FFFD
					expect(excerpt).not.toContain("\uFFFD");
					// Re-encoding must produce valid identical string
					expect(Buffer.from(excerpt, "utf8").toString("utf8")).toBe(excerpt);
				}
			});
		});

		// 2.2 Strict TypeBox Schema and Boundary Rejections
		describe("Strict TypeBox Schema and Boundary Rejections", () => {
			it("rejects unknown properties at root and nested levels via additionalProperties: false", () => {
				const base = createValidContract();

				// Extra property at root
				const extraRoot = { ...base, extraRootField: "bad" };
				const valRoot = validateTaskAutomationContract(extraRoot);
				expect(valRoot.valid).toBe(false);
				expect(
					valRoot.errors.some((e) => e.includes("additional properties") || e.includes("extraRootField")),
				).toBe(true);

				// Extra property in outputs
				const extraOutputs = { ...base, outputs: { ...base.outputs, unknownOutput: 123 } };
				const valOutputs = validateTaskAutomationContract(extraOutputs);
				expect(valOutputs.valid).toBe(false);
				expect(
					valOutputs.errors.some((e) => e.includes("additional properties") || e.includes("unknownOutput")),
				).toBe(true);

				// Extra property in inputs[0]
				const extraInputs = { ...base, inputs: [{ ...base.inputs[0], extraInputProp: true }] };
				const valInputs = validateTaskAutomationContract(extraInputs);
				expect(valInputs.valid).toBe(false);
				expect(
					valInputs.errors.some((e) => e.includes("additional properties") || e.includes("extraInputProp")),
				).toBe(true);

				// Extra property in verifier
				const extraVerifier = { ...base, verifier: { ...base.verifier, extraVerifierProp: "foo" } };
				const valVerifier = validateTaskAutomationContract(extraVerifier);
				expect(valVerifier.valid).toBe(false);
				expect(
					valVerifier.errors.some((e) => e.includes("additional properties") || e.includes("extraVerifierProp")),
				).toBe(true);

				// Extra property in negativeControls[0]
				const extraNC = {
					...base,
					verifier: {
						...base.verifier,
						negativeControls: [{ ...base.verifier.negativeControls[0], extraNCProp: "bar" }],
					},
				};
				const valNC = validateTaskAutomationContract(extraNC);
				expect(valNC.valid).toBe(false);
				expect(valNC.errors.some((e) => e.includes("additional properties") || e.includes("extraNCProp"))).toBe(
					true,
				);
			});

			it("rejects out-of-range integer timeoutMs values", () => {
				const base = createValidContract();

				for (const badTimeout of [0, -1, MAX_TIMEOUT_MS + 1, 1.5]) {
					const contract = {
						...base,
						verifier: {
							...base.verifier,
							timeoutMs: badTimeout,
						},
					};
					const val = validateTaskAutomationContract(contract);
					expect(val.valid).toBe(false);
					expect(val.errors.length).toBeGreaterThan(0);
				}

				// Valid timeout within bounds passes
				const validTimeout = {
					...base,
					verifier: {
						...base.verifier,
						timeoutMs: 5000,
					},
				};
				expect(validateTaskAutomationContract(validTimeout).valid).toBe(true);
			});

			it("rejects oversized strings exceeding shared contract bounds", () => {
				const base = createValidContract();

				// contains > MAX_OUTPUT_SUBSTRING_LENGTH (512)
				const overContains = {
					...base,
					outputs: { ...base.outputs, contains: "a".repeat(MAX_OUTPUT_SUBSTRING_LENGTH + 1) },
				};
				expect(validateTaskAutomationContract(overContains).valid).toBe(false);

				// verifier.expectedOutput > MAX_OUTPUT_SUBSTRING_LENGTH (512)
				const overExpectedOutput = {
					...base,
					verifier: { ...base.verifier, expectedOutput: "b".repeat(MAX_OUTPUT_SUBSTRING_LENGTH + 1) },
				};
				expect(validateTaskAutomationContract(overExpectedOutput).valid).toBe(false);

				// negativeControl.args[0] > MAX_ARG_LENGTH (500)
				const overArg = {
					...base,
					verifier: {
						...base.verifier,
						negativeControls: [
							{
								...base.verifier.negativeControls[0],
								args: ["c".repeat(MAX_ARG_LENGTH + 1)],
							},
						],
					},
				};
				expect(validateTaskAutomationContract(overArg).valid).toBe(false);

				// input.name > MAX_AUTOMATION_NAME_LENGTH (64)
				const overName = {
					...base,
					inputs: [{ ...base.inputs[0], name: "d".repeat(MAX_AUTOMATION_NAME_LENGTH + 1) }],
				};
				expect(validateTaskAutomationContract(overName).valid).toBe(false);
			});
		});
	});

	// 3. Concurrent File Hash Mutation During Validation
	describe("3. Concurrent File Hash Mutation During Validation", () => {
		it("detects script file mutation during validation and rejects admission", async () => {
			const scriptPath = "script.sh";
			const fullPath = join(tempDir, scriptPath);
			writeFileSync(fullPath, "echo 'ORIGINAL SCRIPT'", "utf8");

			const deferred = createDeferred<void>();

			const executor: ScriptExecutor = async (_cmd, argv) => {
				if (argv.includes("--test")) {
					writeFileSync(fullPath, "echo 'TAMPERED SCRIPT DURING VALIDATION'", "utf8");
					deferred.resolve();
					return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 10, timedOut: false };
				}
				return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 10, timedOut: false };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor,
			});

			controller.author({
				name: "tamper-check",
				description: "Detect mutation during validation",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const validatePromise = controller.validate("tamper-check");
			await deferred.promise;
			const result = await validatePromise;

			expect(result.success).toBe(false);
			expect(result.state).toBe("failed");
			expect(result.reason).toContain("Script was modified on disk during validation. Validation aborted.");
			expect(controller.getAutomation("tamper-check")?.state).toBe("failed");
			expect(controller.getAutomation("tamper-check")?.evidence).toBeUndefined();
		});
	});

	// 4. Revision Fencing Against Stale Execution Completion
	describe("4. Revision Fencing Against Stale Execution Completion", () => {
		it("discards stale execution completion, asserts non-success outcome, and drops evidence", async () => {
			const scriptPath = "script.sh";
			const fullPath = join(tempDir, scriptPath);
			writeFileSync(fullPath, "echo 'STABLE'", "utf8");

			const executorStarted = createDeferred<void>();
			const executionProceed = createDeferred<ScriptExecution>();

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					// Runtime execution signals explicit start barrier
					executorStarted.resolve();
					return executionProceed.promise;
				},
			});

			controller.author({
				name: "fenced-exec",
				description: "Original Version 1",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const val = await controller.validate("fenced-exec");
			expect(val.success).toBe(true);
			expect(controller.getAutomation("fenced-exec")?.state).toBe("ready");

			// Start execution and await explicit executor-start barrier
			const runPromise = controller.run("fenced-exec", ["run-arg"]);
			await executorStarted.promise;

			expect(controller.getAutomation("fenced-exec")?.state).toBe("executing");

			// While execution is in-flight, re-author the automation (bumping revision)
			controller.author({
				name: "fenced-exec",
				description: "Re-Authored Version 2 with new contract",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract({
					effects: ["re-authored new effect"],
				}),
			});

			expect(controller.getAutomation("fenced-exec")?.description).toBe("Re-Authored Version 2 with new contract");

			// Now resolve the stale in-flight execution with exit 0
			executionProceed.resolve({
				exitCode: 0,
				stdout: "COMPLETED: item-123",
				stderr: "",
				durationMs: 50,
				timedOut: false,
			});

			const runResult = await runPromise;

			// Invariant (Review § Acceptance #12): Discarded completion CANNOT return success even if process exited 0!
			expect(runResult.outcome).toBe("failed");
			expect(runResult.error).toMatch(/stale|discarded|intervening|revision/i);

			// Durable automation must retain re-authored specification and not be overwritten as succeeded
			const finalAutomation = controller.getAutomation("fenced-exec");
			expect(finalAutomation?.description).toBe("Re-Authored Version 2 with new contract");
			expect(finalAutomation?.lastExecution?.outcome).not.toBe("succeeded");
		});
	});

	// 5. AbortSignal & Cancellation Invariants
	describe("5. AbortSignal Non-Success Guarantee", () => {
		it("asserts pre-aborted signal never spawns executor and never transitions to active executing", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			let executorSpawned = false;
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async () => {
					executorSpawned = true;
					return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "pre-aborted-auto",
				description: "Pre-aborted test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const preAborted = new AbortController();
			preAborted.abort();

			// Pre-aborted run should not execute
			const runResult = await controller.run("pre-aborted-auto", ["arg"], preAborted.signal);
			expect(executorSpawned).toBe(false);
			expect(runResult.outcome).toBe("failed");
			// Must never have transitioned to active executing
			expect(controller.getAutomation("pre-aborted-auto")?.state).not.toBe("executing");
		});

		it("asserts mid-flight abort results in terminal failed state in addition to non-success outcome", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const ac = new AbortController();
			const executorStarted = createDeferred<void>();

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv, _cwd, _timeout, signal) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					executorStarted.resolve();
					// Wait until aborted
					return new Promise<ScriptExecution>((resolve) => {
						signal?.addEventListener("abort", () => {
							resolve({ exitCode: null, stdout: "", stderr: "aborted", durationMs: 10, timedOut: false });
						});
					});
				},
			});

			controller.author({
				name: "mid-aborted-run",
				description: "Mid-flight abort test",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const val = await controller.validate("mid-aborted-run");
			expect(val.success).toBe(true);

			const runPromise = controller.run("mid-aborted-run", ["arg"], ac.signal);
			await executorStarted.promise;

			ac.abort();
			const result = await runPromise;

			expect(result.outcome).toBe("failed");
			// Invariant (Review § Acceptance #12): Cancellation cannot publish success; terminal state must be failed
			const automation = controller.getAutomation("mid-aborted-run");
			expect(automation?.lastExecution?.outcome).toBe("failed");
		});

		it("fails closed when validation is aborted mid-flight", async () => {
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const ac = new AbortController();

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						ac.abort();
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "abortable-val",
				description: "Test abort in validation",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			await expect(controller.validate("abortable-val", ac.signal)).rejects.toThrow();
			expect(controller.getAutomation("abortable-val")?.state).not.toBe("ready");
		});
	});

	// 6. Snapshot Clones vs. Restore Interruption Recovery
	describe("6. Pure Deep Copy vs. Restore Interruption Recovery", () => {
		it("asserts cloneTaskAutomationState is a pure deep-copy that preserves executing state", () => {
			// Invariant (Review § Acceptance #15): Clone is a pure deep copy; recovery belongs only at restore, never append!
			const rawState: TaskAutomationState = {
				version: 1,
				revision: 4,
				createdAt: "2026-09-12T10:00:00.000Z",
				updatedAt: "2026-09-12T10:01:00.000Z",
				automations: [
					{
						name: "exec-in-progress",
						description: "Active task",
						runner: "bash",
						path: "s1.sh",
						state: "executing",
						contract: createValidContract(),
						createdAt: "2026-09-12T10:00:00.000Z",
						updatedAt: "2026-09-12T10:01:00.000Z",
					},
				],
			};

			const cloned = cloneTaskAutomationState(rawState);
			// Must preserve executing state during pure clone
			expect(cloned.automations[0].state).toBe("executing");
			// Must detach object references
			expect(cloned.automations[0]).not.toBe(rawState.automations[0]);
		});

		it("asserts recoverAutomationInFlight explicitly recovers executing state to failed on restore", () => {
			const executingAutomation: TaskAutomationDefinition = {
				name: "in-flight-task",
				description: "Simulate crash during run",
				runner: "bash",
				path: "script.sh",
				state: "executing",
				contract: createValidContract(),
				createdAt: "2026-09-12T10:00:00.000Z",
				updatedAt: "2026-09-12T10:01:00.000Z",
				lastExecution: {
					runId: "run-999",
					exitCode: null,
					stdout: "partial stdout",
					stderr: "",
					durationMs: 1200,
					startedAt: "2026-09-12T10:01:00.000Z",
					completedAt: "",
					outcome: "failed",
				},
			};

			const recovered = recoverAutomationInFlight(executingAutomation, "2026-09-12T10:05:00.000Z");
			expect(recovered.state).toBe("failed");
			expect(recovered.lastExecution?.outcome).toBe("failed");
			expect(recovered.lastExecution?.error).toBe("interrupted_by_session_restore");
			expect(recovered.lastExecution?.stderr).toContain("Interrupted by session restore or restart");
		});

		it("recovers executing state to failed when restoring a new controller from session snapshot", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller1 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			controller1.author({
				name: "survives-restart",
				description: "Will be interrupted",
				runner: "bash",
				path: "test.sh",
				contract: createValidContract(),
			});

			const currentAutomations = controller1.getAutomations();
			const interruptedState: TaskAutomationState = {
				version: 1,
				revision: 10,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...currentAutomations[0],
						state: "executing",
					},
				],
			};

			appendTaskAutomationStateSnapshot(sessionManager, interruptedState);

			const controller2 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			const restored = controller2.getAutomation("survives-restart");
			expect(restored).toBeDefined();
			expect(restored?.state).toBe("failed");
			expect(restored?.lastExecution?.error).toBe("interrupted_by_session_restore");
		});

		it("asserts recoverAutomationInFlight explicitly recovers validating state to failed on restore", () => {
			const validatingAutomation: TaskAutomationDefinition = {
				name: "in-flight-validation",
				description: "Simulate crash during validation",
				runner: "bash",
				path: "script.sh",
				state: "validating",
				contract: createValidContract(),
				createdAt: "2026-09-12T10:00:00.000Z",
				updatedAt: "2026-09-12T10:01:00.000Z",
			};

			const recovered = recoverAutomationInFlight(validatingAutomation, "2026-09-12T10:05:00.000Z");
			expect(recovered.state).toBe("failed");
			expect(recovered.evidence).toBeUndefined();
			expect(recovered.updatedAt).toBe("2026-09-12T10:05:00.000Z");
		});

		it("recovers validating state to failed when restoring from session snapshot via decodeTaskAutomationStateSnapshotPayload", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller1 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			controller1.author({
				name: "validating-restart",
				description: "Will be interrupted during validation",
				runner: "bash",
				path: "test.sh",
				contract: createValidContract(),
			});

			const currentAutomations = controller1.getAutomations();
			const interruptedState: TaskAutomationState = {
				version: 1,
				revision: 11,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...currentAutomations[0],
						state: "validating",
					},
				],
			};

			appendTaskAutomationStateSnapshot(sessionManager, interruptedState);

			const controller2 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			const latestEntry = sessionManager.getLatestCustomEntryOnBranch(TASK_AUTOMATION_STATE_CUSTOM_TYPE);
			expect(latestEntry).toBeDefined();
			const decoded = decodeTaskAutomationStateSnapshotPayload(latestEntry?.data);
			expect(decoded?.automations[0].state).toBe("failed");
			expect(decoded?.automations[0].evidence).toBeUndefined();

			const restored = controller2.getAutomation("validating-restart");
			expect(restored).toBeDefined();
			expect(restored?.state).toBe("failed");
			expect(restored?.evidence).toBeUndefined();
		});
	});

	// 7. Append Failure Rollback / Atomicity
	describe("7. Append Failure Rollback / Atomicity", () => {
		it("does not mutate in-memory state or advance revision when sessionManager append fails", () => {
			let failAppend = false;
			const realSession = SessionManager.inMemory(tempDir);

			const failingSessionManager = {
				appendCustomEntry: (customType: string, data: unknown) => {
					if (failAppend) {
						throw new Error("Disk quota exceeded or journal locked");
					}
					return realSession.appendCustomEntry(customType, data);
				},
				getLatestCustomEntryOnBranch: (customType: string) => {
					return realSession.getLatestCustomEntryOnBranch(customType);
				},
			};

			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => failingSessionManager,
			});

			controller.author({
				name: "initial-auto",
				description: "Initial",
				runner: "bash",
				path: "script.sh",
				contract: createValidContract(),
			});

			expect(controller.getAutomations().length).toBe(1);
			const revisionBefore = (controller as unknown as { state: TaskAutomationState }).state.revision;

			failAppend = true;

			expect(() => {
				controller.author({
					name: "failing-auto",
					description: "Will fail append",
					runner: "bash",
					path: "script2.sh",
					contract: createValidContract(),
				});
			}).toThrow("Disk quota exceeded or journal locked");

			expect(controller.getAutomations().length).toBe(1);
			expect(controller.getAutomation("failing-auto")).toBeUndefined();
			expect((controller as unknown as { state: TaskAutomationState }).state.revision).toBe(revisionBefore);
		});

		it("invalidates immediately and returns undefined when latest snapshot entry on branch is malformed, with no fallback to older entries", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const validState: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						name: "valid-task",
						description: "Valid automation",
						runner: "bash",
						path: "script.sh",
						state: "ready",
						contract: createValidContract(),
						evidence: {
							scriptHash: "a".repeat(64),
							verifiedAt: new Date().toISOString(),
							verifierExitCode: 0,
							verifierStdout: "COMPLETED: VERIFIER_OK",
							verifierStderr: "",
							negativeControls: [
								{
									description: "Rejects invalid id",
									args: ["--invalid-id"],
									exitCode: 1,
									passed: true,
								},
							],
							workspaceCwd: tempDir,
						},
						workspaceCwd: tempDir,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
			};

			// 1. Append valid snapshot at revision 1
			appendTaskAutomationStateSnapshot(sessionManager, validState);
			const snapshot1 = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(snapshot1).toBeDefined();
			expect(snapshot1?.automations[0].name).toBe("valid-task");

			// 2. Append malformed custom entry as newest entry on the branch
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, {
				version: 2, // unsupported version / malformed payload
				corrupt: true,
			});

			// 3. getLatestTaskAutomationStateSnapshot MUST return undefined (invalidated), NOT fall back to revision 1!
			const snapshot2 = getLatestTaskAutomationStateSnapshot(sessionManager);
			expect(snapshot2).toBeUndefined();
		});

		it("dynamically resolves live SessionManager via getter on each append and getLatest call", () => {
			const sessionA = SessionManager.inMemory(tempDir);
			const sessionB = SessionManager.inMemory(tempDir);
			let currentSession = sessionA;

			const storagePort = createSessionTaskAutomationStoragePort(() => currentSession);

			const stateA: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [],
			};

			const stateB: TaskAutomationState = {
				version: 1,
				revision: 2,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [],
			};

			// Append to session A
			storagePort.appendSnapshot(stateA);
			expect(storagePort.getLatestSnapshot()?.revision).toBe(1);
			expect(getLatestTaskAutomationStateSnapshot(sessionA)?.revision).toBe(1);
			expect(getLatestTaskAutomationStateSnapshot(sessionB)).toBeUndefined();

			// Dynamically switch live session pointer to session B
			currentSession = sessionB;

			// Now getLatestSnapshot reads from session B (which has no snapshot yet)
			expect(storagePort.getLatestSnapshot()).toBeUndefined();

			// Append to session B
			storagePort.appendSnapshot(stateB);
			expect(storagePort.getLatestSnapshot()?.revision).toBe(2);
			expect(getLatestTaskAutomationStateSnapshot(sessionB)?.revision).toBe(2);

			// Verify session A was not mutated by write to session B
			expect(getLatestTaskAutomationStateSnapshot(sessionA)?.revision).toBe(1);
		});

		it("fails closed when live SessionManager resolver returns null/undefined or throws", () => {
			let liveManager: SessionManager | undefined;
			const storagePort = createSessionTaskAutomationStoragePort(() => liveManager as unknown as SessionManager);

			const validState: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [],
			};

			expect(() => storagePort.getLatestSnapshot()).toThrow(
				/Live SessionManager resolver returned undefined or null/,
			);
			expect(() => storagePort.appendSnapshot(validState)).toThrow(
				/Live SessionManager resolver returned undefined or null/,
			);

			const throwingPort = createSessionTaskAutomationStoragePort(() => {
				throw new Error("Session unavailable");
			});
			expect(() => throwingPort.getLatestSnapshot()).toThrow("Session unavailable");
			expect(() => throwingPort.appendSnapshot(validState)).toThrow("Session unavailable");
		});

		it("rejects snapshots with corrupted negative controls (exitCode 0, passed false, or missing fixtures)", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const baseValid: TaskAutomationDefinition = {
				name: "valid-task",
				description: "Valid automation",
				runner: "bash",
				path: "script.sh",
				state: "ready",
				contract: createValidContract(),
				evidence: {
					scriptHash: "a".repeat(64),
					verifiedAt: new Date().toISOString(),
					verifierExitCode: 0,
					verifierStdout: "COMPLETED: VERIFIER_OK",
					verifierStderr: "",
					negativeControls: [
						{
							description: "Rejects invalid id",
							args: ["--invalid-id"],
							exitCode: 1,
							passed: true,
						},
					],
					workspaceCwd: tempDir,
				},
				workspaceCwd: tempDir,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// 1. exitCode 0 on negative control must be rejected
			const corruptExit0: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						evidence: {
							...baseValid.evidence!,
							negativeControls: [
								{
									description: "Rejects invalid id",
									args: ["--invalid-id"],
									exitCode: 0,
									passed: true,
								},
							],
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: corruptExit0 });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();

			// 2. passed: false on negative control must be rejected
			const corruptPassedFalse: TaskAutomationState = {
				version: 1,
				revision: 2,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						evidence: {
							...baseValid.evidence!,
							negativeControls: [
								{
									description: "Rejects invalid id",
									args: ["--invalid-id"],
									exitCode: 1,
									passed: false,
								},
							],
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: corruptPassedFalse });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();
		});

		it("rejects snapshots with corrupted lastExecution (succeeded with non-zero exit code or missing completedAt)", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const baseValid: TaskAutomationDefinition = {
				name: "valid-task",
				description: "Valid automation",
				runner: "bash",
				path: "script.sh",
				state: "ready",
				contract: createValidContract(),
				workspaceCwd: tempDir,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// Succeeded with exitCode 1 must be rejected
			const corruptExitCode: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						lastExecution: {
							runId: "run-1",
							exitCode: 1,
							stdout: "output",
							stderr: "",
							durationMs: 10,
							startedAt: new Date().toISOString(),
							completedAt: new Date().toISOString(),
							outcome: "succeeded",
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: corruptExitCode });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();

			// Succeeded with empty completedAt must be rejected
			const corruptCompletedAt: TaskAutomationState = {
				version: 1,
				revision: 2,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						lastExecution: {
							runId: "run-2",
							exitCode: 0,
							stdout: "output",
							stderr: "",
							durationMs: 10,
							startedAt: new Date().toISOString(),
							completedAt: "   ",
							outcome: "succeeded",
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: corruptCompletedAt });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();
		});

		it("rejects snapshots with workspaceCwd mismatch or byte cap violations", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const baseValid: TaskAutomationDefinition = {
				name: "valid-task",
				description: "Valid automation",
				runner: "bash",
				path: "script.sh",
				state: "ready",
				contract: createValidContract(),
				evidence: {
					scriptHash: "a".repeat(64),
					verifiedAt: new Date().toISOString(),
					verifierExitCode: 0,
					verifierStdout: "COMPLETED: VERIFIER_OK",
					verifierStderr: "",
					negativeControls: [
						{
							description: "Rejects invalid id",
							args: ["--invalid-id"],
							exitCode: 1,
							passed: true,
						},
					],
					workspaceCwd: tempDir,
				},
				workspaceCwd: tempDir,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// Workspace cwd mismatch between definition and evidence
			const mismatchCwd: TaskAutomationState = {
				version: 1,
				revision: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						evidence: {
							...baseValid.evidence!,
							workspaceCwd: "/different/path",
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: mismatchCwd });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();

			// Byte cap violation on verifierStdout (> 4096 bytes)
			const oversizedStdout: TaskAutomationState = {
				version: 1,
				revision: 2,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				automations: [
					{
						...baseValid,
						evidence: {
							...baseValid.evidence!,
							verifierStdout: "x".repeat(MAX_OUTPUT_EXCERPT_BYTES + 1),
						},
					},
				],
			};
			sessionManager.appendCustomEntry(TASK_AUTOMATION_STATE_CUSTOM_TYPE, { version: 1, state: oversizedStdout });
			expect(getLatestTaskAutomationStateSnapshot(sessionManager)).toBeUndefined();
		});
	});

	// 8. Isolation Across Sessions, Branches, and Working Directories
	describe("8. Isolation Across Sessions, Branches, and Working Directories", () => {
		it("isolates automations between independent sessions", () => {
			const session1 = SessionManager.inMemory(tempDir);
			const session2 = SessionManager.inMemory(tempDir);

			const controller1 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => session1,
			});
			const controller2 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => session2,
			});

			controller1.author({
				name: "session-1-only",
				description: "Owned by session 1",
				runner: "bash",
				path: "s1.sh",
				contract: createValidContract(),
			});

			expect(controller1.getAutomation("session-1-only")).toBeDefined();
			expect(controller2.getAutomation("session-1-only")).toBeUndefined();
			expect(controller2.getAutomations().length).toBe(0);
		});

		it("asserts cwd isolation when the EXACT SAME bytes exist in both directories", async () => {
			// Invariant (Review § Acceptance #9 & #22): Same-byte script in another cwd must still be scoped!
			const dir1 = mkdtempSync(join(tmpdir(), "cwd-iso-1-"));
			const dir2 = mkdtempSync(join(tmpdir(), "cwd-iso-2-"));

			try {
				const scriptRelativePath = "work.sh";
				const scriptContent = "echo 'DETERMINISTIC SAME BYTES'";
				writeFileSync(join(dir1, scriptRelativePath), scriptContent, "utf8");
				// Both dir1 and dir2 have the EXACT SAME file bytes!
				writeFileSync(join(dir2, scriptRelativePath), scriptContent, "utf8");

				const session = SessionManager.inMemory(dir1);

				const controller1 = new TaskAutomationController({
					getCwd: () => dir1,
					getSessionManager: () => session,
					executor: async (_cmd, argv) => {
						if (argv.includes("--test")) {
							return {
								exitCode: 0,
								stdout: "COMPLETED: VERIFIER_OK",
								stderr: "",
								durationMs: 5,
								timedOut: false,
							};
						}
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					},
				});

				controller1.author({
					name: "admitted-cwd-script",
					description: "Validated specifically in dir1",
					runner: "bash",
					path: scriptRelativePath,
					contract: createValidContract(),
				});

				const val = await controller1.validate("admitted-cwd-script");
				expect(val.success).toBe(true);

				// In dir1, admitted scripts list includes the validated script
				const admitted1 = controller1.getAdmittedScripts();
				expect(admitted1.some((s) => s.name === "admitted-cwd-script")).toBe(true);

				// Controller 2 in dir2 reusing the session state MUST NOT inherit executable admission in dir2!
				const controller2 = new TaskAutomationController({
					getCwd: () => dir2,
					getSessionManager: () => session,
				});

				const admitted2 = controller2.getAdmittedScripts();
				// Scoped execution must not admit the script in dir2 without validation in dir2
				expect(admitted2.some((s) => s.name === "admitted-cwd-script")).toBe(false);
			} finally {
				rmSync(dir1, { recursive: true, force: true });
				rmSync(dir2, { recursive: true, force: true });
			}
		});
	});

	// 9. Task Step Binding & Direct Completion Check
	describe("9. Task Step Binding & Direct Completion Check", () => {
		it("blocks task step completion if automation has not yet executed successfully", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			controller.author({
				name: "step-bound-auto",
				description: "Bound to step-101",
				runner: "bash",
				path: "script.sh",
				contract: createValidContract(),
				binding: {
					stepId: "step-101",
					expectedArgs: [],
				},
			});

			const check1 = controller.verifyStepCompletionAllowed("step-101");
			expect(check1.allowed).toBe(false);
			expect(check1.reason).toContain(
				"Script readiness is not task success; verified execution is required before completion",
			);
		});

		it("enforces exact expectedArgs match in binding for step completion", async () => {
			const scriptPath = "args-check.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: "COMPLETED: ok", stderr: "", durationMs: 10, timedOut: false };
				},
			});

			controller.author({
				name: "args-bound-auto",
				description: "Bound with exact expectedArgs",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
				binding: {
					stepId: "step-exact-args",
					expectedArgs: ["--strict", "mode"],
				},
			});

			const val = await controller.validate("args-bound-auto");
			expect(val.success).toBe(true);

			// Run with mismatched args
			await controller.run("args-bound-auto", ["--loose", "mode"]);
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-exact-args", status: "completed" }]);
			}).toThrow(/expecting args/i);

			// Run with exact matching args
			await controller.run("args-bound-auto", ["--strict", "mode"]);
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-exact-args", status: "completed" }]);
			}).not.toThrow();
		});

		it("asserts direct completion check immediately fails after disk edit WITHOUT calling run first", async () => {
			// Invariant (Review § Acceptance #14 & #22): Completion evidence tied to exact current hash; direct completion check immediately after disk edit (no run first).
			const scriptPath = "script.sh";
			const fullPath = join(tempDir, scriptPath);
			writeFileSync(fullPath, "echo 'ORIGINAL CODE'", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					return { exitCode: 0, stdout: "COMPLETED: ok", stderr: "", durationMs: 10, timedOut: false };
				},
			});

			controller.author({
				name: "tamper-step-auto",
				description: "Tamper detection for step completion",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
				binding: {
					stepId: "step-55",
					expectedArgs: ["arg"],
				},
			});

			const val = await controller.validate("tamper-step-auto");
			expect(val.success).toBe(true);

			const run1 = await controller.run("tamper-step-auto", ["arg"]);
			expect(run1.outcome).toBe("succeeded");

			// Completed successfully: completion allowed
			expect(controller.verifyStepCompletionAllowed("step-55").allowed).toBe(true);

			// Direct edit on disk WITHOUT calling run() first!
			writeFileSync(fullPath, "echo 'TAMPERED CODE ON DISK'", "utf8");

			// Invariant: verifyStepCompletionAllowed MUST immediately check disk hash and deny!
			const checkDirect = controller.verifyStepCompletionAllowed("step-55");
			expect(checkDirect.allowed).toBe(false);
		});
	});

	// 10. Host Authorizer Enforcement
	describe("10. Host Authorizer Enforcement for Dangerous, Negative, and Ordinary Scripts", () => {
		it("refuses dangerous script execution and validation when host authorizer is missing", async () => {
			// Invariant (Review § Acceptance #10): Missing authorizer may NOT allow dangerous code!
			const scriptPath = "dangerous.sh";
			writeFileSync(join(tempDir, scriptPath), "echo rm", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			// Authorizer explicitly undefined
			const controllerNoAuth = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 1, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 1, timedOut: false };
				},
			});

			controllerNoAuth.author({
				name: "dangerous-no-auth",
				description: "Dangerous script without authorizer",
				runner: "bash",
				path: scriptPath,
				danger: true,
				contract: createValidContract(),
			});

			// Validation must fail closed when authorizer is missing for dangerous script
			const val = await controllerNoAuth.validate("dangerous-no-auth");
			expect(val.success).toBe(false);
			expect(val.reason).toMatch(/authoriz/i);

			// Real validation with configured authorizer to establish genuine ready state with valid hash & evidence
			const controllerWithAuth = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				authorize: async () => ({ authorized: true }),
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 1, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 1, timedOut: false };
				},
			});

			const valAuth = await controllerWithAuth.validate("dangerous-no-auth");
			expect(valAuth.success).toBe(true);
			expect(valAuth.state).toBe("ready");
			expect(valAuth.evidence?.scriptHash).toBeDefined();

			// Construct same-scope controller without authorizer; run must fail closed despite valid hash & evidence
			const controllerNoAuth2 = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			const runResult = await controllerNoAuth2.run("dangerous-no-auth", []);
			expect(runResult.outcome).toBe("failed");
			expect(runResult.error).toMatch(/authoriz/i);
		});

		it("consults configured authorizer for ordinary non-dangerous scripts and obeys refusal", async () => {
			// Invariant (Review § Acceptance #10): Configured authorizer MUST be consulted for ordinary scripts too.
			const scriptPath = "ordinary.sh";
			writeFileSync(join(tempDir, scriptPath), "echo normal", "utf8");

			let authorizeDecision = {
				authorized: false,
				reason: "Host policy blocks execution of ordinary script",
			};

			const authorizer: ToolkitScriptAuthorizer = async () => authorizeDecision;

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				authorize: authorizer,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 1, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 1, timedOut: false };
				},
			});

			controller.author({
				name: "ordinary-refused",
				description: "Non-dangerous script refused by authorizer",
				runner: "bash",
				path: scriptPath,
				danger: false,
				contract: createValidContract(),
			});

			// Validation of ordinary script must consult authorizer and obey refusal
			const val = await controller.validate("ordinary-refused");
			expect(val.success).toBe(false);
			expect(val.reason).toContain("Host policy blocks execution of ordinary script");

			// Temporarily authorize validation so automation reaches ready state
			authorizeDecision = { authorized: true, reason: "" };
			const valPassed = await controller.validate("ordinary-refused");
			expect(valPassed.success).toBe(true);

			// Now re-engage refusal: run of ordinary script in ready state must consult authorizer and obey refusal
			authorizeDecision = { authorized: false, reason: "Host policy blocks execution of ordinary script" };
			const runResult = await controller.run("ordinary-refused", []);
			expect(runResult.outcome).toBe("failed");
			expect(runResult.error).toContain("Host policy blocks execution of ordinary script");
		});

		it("authorizes every negative control fixture independently and fails validation if negative control is refused", async () => {
			// Invariant (Review § Acceptance #10): Validate positive AND every negative invocation through authorizer.
			const scriptPath = "script.sh";
			writeFileSync(join(tempDir, scriptPath), "echo ok", "utf8");

			const authorizedArgs: string[][] = [];
			const authorizer: ToolkitScriptAuthorizer = async (req) => {
				authorizedArgs.push([...req.args]);
				// Authorize positive test, but DENY negative control args
				if (req.args.includes("--invalid-id")) {
					return { authorized: false, reason: "Host policy refused negative control fixture" };
				}
				return { authorized: true };
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				authorize: authorizer,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "negative-auth-check",
				description: "Negative fixture authorization test",
				runner: "bash",
				path: scriptPath,
				danger: true,
				contract: createValidContract(),
			});

			const val = await controller.validate("negative-auth-check");
			// Negative control must be authorized; if denied, validation must fail
			expect(val.success).toBe(false);
			expect(val.reason).toContain("Host policy refused negative control fixture");
		});
	});

	// 11. executeAdmittedScript Failure Propagation
	describe("11. executeAdmittedScript Failure Propagation", () => {
		it("returns non-zero exitCode and failure details when underlying process exits 0 but output contract fails", async () => {
			const scriptPath = "format-check.sh";
			writeFileSync(join(tempDir, scriptPath), "echo 'NOT_JSON'", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return {
							exitCode: 0,
							stdout: JSON.stringify({ status: "COMPLETED: VERIFIER_OK" }),
							stderr: "",
							durationMs: 5,
							timedOut: false,
						};
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					// Underlying execution exits 0, but output violates JSON contract
					return { exitCode: 0, stdout: "PLAIN_TEXT_NOT_JSON", stderr: "", durationMs: 10, timedOut: false };
				},
			});

			controller.author({
				name: "json-script",
				description: "Requires JSON output contract",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract({
					outputs: {
						format: "json",
						description: "Mandatory valid JSON output",
						contains: "{",
					},
				}),
			});

			const val = await controller.validate("json-script");
			expect(val.success).toBe(true);

			// Direct invocation via executeAdmittedScript adapter
			const execution = await controller.executeAdmittedScript("json-script", ["--run"]);

			// Desired Invariant: underlying exit 0 MUST NOT return success exit 0 if output contract fails!
			expect(execution.exitCode).not.toBe(0);
			expect(execution.exitCode).toBe(1);
			expect(execution.stderr).toMatch(/json|output contract/i);
		});
	});

	// 12. Fine-Grained Concurrency & Per-Operation Fencing
	describe("12. Fine-Grained Concurrency & Per-Operation Fencing", () => {
		it("asserts unrelated automation mutation does not corrupt or discard another in-flight execution", async () => {
			const scriptA = "script-a.sh";
			const scriptB = "script-b.sh";
			writeFileSync(join(tempDir, scriptA), "echo a", "utf8");
			writeFileSync(join(tempDir, scriptB), "echo b", "utf8");

			const execAStarted = createDeferred<void>();
			const execAProceed = createDeferred<ScriptExecution>();

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					if (argv.includes("run-a")) {
						execAStarted.resolve();
						return execAProceed.promise;
					}
					return { exitCode: 0, stdout: "COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "auto-a",
				description: "Automation A",
				runner: "bash",
				path: scriptA,
				contract: createValidContract(),
			});
			controller.author({
				name: "auto-b",
				description: "Automation B",
				runner: "bash",
				path: scriptB,
				contract: createValidContract(),
			});

			const valA = await controller.validate("auto-a");
			expect(valA.success).toBe(true);
			const valB = await controller.validate("auto-b");
			expect(valB.success).toBe(true);

			// Start executing auto-a
			const runAPromise = controller.run("auto-a", ["run-a"]);
			await execAStarted.promise;

			// In-flight: mutate UNRELATED automation auto-b (bumps controller revision)
			controller.author({
				name: "auto-b",
				description: "Mutated Automation B during A run",
				runner: "bash",
				path: scriptB,
				contract: createValidContract({ effects: ["different effect"] }),
			});

			// Resolve auto-a execution successfully
			execAProceed.resolve({
				exitCode: 0,
				stdout: "COMPLETED: ok",
				stderr: "",
				durationMs: 20,
				timedOut: false,
			});

			const resultA = await runAPromise;

			// Desired Invariant: Per-operation fence must allow auto-a to succeed because auto-a itself was never mutated!
			expect(resultA.outcome).toBe("succeeded");
			expect(resultA.error).toBeUndefined();
			expect(controller.getAutomation("auto-a")?.state).toBe("ready");
			expect(controller.getAutomation("auto-a")?.lastExecution?.outcome).toBe("succeeded");
		});

		it("prevents execution of stale code when automation is re-authored during pending authorization before spawn", async () => {
			const scriptPath = "stale.sh";
			const fullPath = join(tempDir, scriptPath);
			writeFileSync(fullPath, "echo v1", "utf8");

			const authStarted = createDeferred<void>();
			const authProceed = createDeferred<{ authorized: boolean }>();
			let executorSpawned = false;

			let bypassAuth = true;
			const authorizer: ToolkitScriptAuthorizer = async () => {
				if (bypassAuth) return { authorized: true };
				authStarted.resolve();
				return authProceed.promise;
			};

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				authorize: authorizer,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					executorSpawned = true;
					return { exitCode: 0, stdout: "COMPLETED: ok", stderr: "", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "stale-auth-check",
				description: "Version 1",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			const val = await controller.validate("stale-auth-check");
			expect(val.success).toBe(true);
			bypassAuth = false;

			// Initiate run; authorizer will pause at authStarted
			const runPromise = controller.run("stale-auth-check", ["arg"]);
			await authStarted.promise;

			// SAME-BYTE contract-only replacement: DO NOT edit the file on disk!
			// Only re-author the contract (different preconditions, identical script bytes on disk)
			controller.author({
				name: "stale-auth-check",
				description: "Version 2 modified during auth (same script bytes)",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract({ preconditions: ["new precondition"] }),
			});

			// Complete authorization
			authProceed.resolve({ authorized: true });

			const runResult = await runPromise;

			// Desired Invariant: Stale execution must NOT succeed and stale code must not execute
			expect(runResult.outcome).toBe("failed");
			expect(executorSpawned).toBe(false);
		});

		it("fences or prevents concurrent overlapping validate and run on the same automation", async () => {
			const scriptPath = "overlap.sh";
			writeFileSync(join(tempDir, scriptPath), "echo overlap", "utf8");

			let executorSpawnCount = 0;
			const firstValidateStarted = createDeferred<void>();
			const firstValidateProceed = createDeferred<ScriptExecution>();

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					executorSpawnCount++;
					if (argv.includes("--test")) {
						firstValidateStarted.resolve();
						return firstValidateProceed.promise;
					}
					return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
				},
			});

			controller.author({
				name: "overlap-auto",
				description: "Test overlapping operations",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
			});

			// Start first validate
			const valPromise1 = controller.validate("overlap-auto");
			await firstValidateStarted.promise;
			const spawnsDuringFirst = executorSpawnCount;

			// In-flight: trigger a second overlapping run
			const runResult2 = await controller.run("overlap-auto", ["arg"]);
			// Overlapping run while in validating state must fail closed
			expect(runResult2.outcome).toBe("failed");
			expect(executorSpawnCount).toBe(spawnsDuringFirst);

			// In-flight: trigger overlapping validate-during-validate
			const valResultOverlapping = await controller.validate("overlap-auto");
			expect(valResultOverlapping.success).toBe(false);
			expect(executorSpawnCount).toBe(spawnsDuringFirst);

			// Complete first validate
			firstValidateProceed.resolve({
				exitCode: 0,
				stdout: "COMPLETED: VERIFIER_OK",
				stderr: "",
				durationMs: 10,
				timedOut: false,
			});

			const valResult1 = await valPromise1;
			// Assert original validation SUCCEEDS and reached ready state!
			expect(valResult1.success).toBe(true);
			expect(controller.getAutomation("overlap-auto")?.state).toBe("ready");
		});
	});

	// 13. Detached State and Dynamic Scope Switch Negative Controls
	describe("13. Detached State and Dynamic Scope Switch Negative Controls", () => {
		it("asserts input object mutation after authoring does not affect internal controller state", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			const expectedArgs = ["--flag", "val1"];
			const preconditions = ["db up"];
			const input: AuthorTaskAutomationInput = {
				name: "detached-input-auto",
				description: "Testing detached input",
				runner: "bash",
				path: "script.sh",
				contract: createValidContract({ preconditions }),
				binding: {
					stepId: "step-detach",
					expectedArgs,
				},
			};

			controller.author(input);

			// Mutate external input arrays
			expectedArgs.push("--injected-flag");
			preconditions.push("injected precondition");

			const stored = controller.getAutomation("detached-input-auto");
			expect(stored).toBeDefined();
			expect(stored?.binding?.expectedArgs).toEqual(["--flag", "val1"]);
			expect(stored?.contract.preconditions).toEqual(["db up"]);
		});

		it("asserts state and automation getters resist caller mutation", () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
			});

			controller.author({
				name: "getter-detach-auto",
				description: "Original description",
				runner: "bash",
				path: "script.sh",
				contract: createValidContract(),
				binding: { stepId: "step-1", expectedArgs: ["a"] },
			});

			const state = controller.getState();
			// Attempt to mutate retrieved state
			try {
				(state.automations as unknown as TaskAutomationDefinition[])[0] = {
					...state.automations[0],
					name: "corrupted",
				};
			} catch {
				// Object.freeze throws, which is also passing detached/immutable invariant
			}

			const freshState = controller.getState();
			expect(freshState.automations[0].name).toBe("getter-detach-auto");

			const singleAuto = controller.getAutomation("getter-detach-auto");
			try {
				(singleAuto as unknown as { description: string }).description = "MUTATED EXTERNAL";
			} catch {
				// Object.freeze throws
			}

			expect(controller.getAutomation("getter-detach-auto")?.description).toBe("Original description");
		});

		it("clears old registrations when dynamic branch or session switches to one without a snapshot on the same controller", () => {
			let currentBranch = "branch-a";
			const currentSession = "session-1";

			// Storage port that stores per-branch
			const branchStorage = new Map<string, TaskAutomationState>();
			const storagePort = {
				appendSnapshot: (state: TaskAutomationState) => {
					branchStorage.set(`${currentSession}:${currentBranch}`, state);
					return "id";
				},
				getLatestSnapshot: () => {
					return branchStorage.get(`${currentSession}:${currentBranch}`);
				},
			};

			const controller = new TaskAutomationController({
				context: {
					getCwd: () => tempDir,
					getBranchId: () => currentBranch,
					getSessionId: () => currentSession,
				},
				storage: storagePort,
			});

			controller.author({
				name: "branch-a-only",
				description: "Created on branch-a",
				runner: "bash",
				path: "s.sh",
				contract: createValidContract(),
			});

			expect(controller.getAutomations().length).toBe(1);
			expect(controller.getAutomation("branch-a-only")).toBeDefined();

			// Switch branch dynamically to branch-b on the SAME controller instance
			currentBranch = "branch-b";

			// Invariant (Review § Acceptance #9 & ensureRefreshedScope):
			// Switching to a branch without a snapshot MUST clear registrations, not retain branch-a automations!
			expect(controller.getAutomations().length).toBe(0);
			expect(controller.getAutomation("branch-a-only")).toBeUndefined();
			expect(controller.getState().automations.length).toBe(0);
		});
	});

	// 14. Step Binding Retiring and Cancellation Lifecycle
	describe("14. Step Binding Retiring and Cancellation Lifecycle", () => {
		it("allows parent user cancellation to retire bound failed steps without everlasting latches", async () => {
			const scriptPath = "failing-script.sh";
			writeFileSync(join(tempDir, scriptPath), "exit 1", "utf8");

			const sessionManager = SessionManager.inMemory(tempDir);
			const controller = new TaskAutomationController({
				getCwd: () => tempDir,
				getSessionManager: () => sessionManager,
				executor: async (_cmd, argv) => {
					if (argv.includes("--test")) {
						return { exitCode: 0, stdout: "COMPLETED: VERIFIER_OK", stderr: "", durationMs: 5, timedOut: false };
					}
					if (argv.includes("--invalid-id")) {
						return { exitCode: 1, stdout: "", stderr: "ERROR: invalid id", durationMs: 5, timedOut: false };
					}
					// Runtime fails
					return { exitCode: 1, stdout: "", stderr: "Fatal runtime error", durationMs: 10, timedOut: false };
				},
			});

			controller.author({
				name: "fail-bound-auto",
				description: "Bound to failing step",
				runner: "bash",
				path: scriptPath,
				contract: createValidContract(),
				binding: {
					stepId: "step-to-cancel",
					expectedArgs: [],
				},
			});

			const val = await controller.validate("fail-bound-auto");
			expect(val.success).toBe(true);
			const runRes = await controller.run("fail-bound-auto", []);
			expect(runRes.outcome).toBe("failed");

			// Invariant 1: Marking as completed is blocked
			const checkCompleted = controller.verifyStepCompletionAllowed("step-to-cancel");
			expect(checkCompleted.allowed).toBe(false);

			// Invariant 2: Parent cancellation/retirement is ALLOWED and does not throw
			expect(() => {
				controller.assertTaskStepsTransition([], [{ id: "step-to-cancel", status: "cancelled" }]);
			}).not.toThrow();

			// Invariant 3: Unrelated completed step can transition when cancelled step is alongside it
			expect(() => {
				controller.assertTaskStepsTransition(
					[],
					[
						{ id: "step-to-cancel", status: "cancelled" },
						{ id: "step-unrelated", status: "completed" },
					],
				);
			}).not.toThrow();

			// Invariant 4: No everlasting latch - if script is rebound to another step, step-to-cancel is unlatched
			controller.bindStep("fail-bound-auto", {
				stepId: "step-rebound",
				expectedArgs: [],
			});

			const checkUnlatched = controller.verifyStepCompletionAllowed("step-to-cancel");
			expect(checkUnlatched.allowed).toBe(true);
		});
	});
});
