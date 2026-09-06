import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationObligationTracker } from "@caupulican/pi-agent-core/verification-obligations";
import { afterEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

const cleanupDirectories: string[] = [];
const cleanupSessionKeys: string[] = [];

afterEach(async () => {
	for (const sessionKey of cleanupSessionKeys.splice(0)) {
		await disposeShellExecutionSessionAndWait(sessionKey);
	}
	for (const directory of cleanupDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function verificationId(result: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>): string {
	const verification = result.details?.piVerification;
	expect(verification).toMatchObject({ version: 1, id: expect.any(String) });
	return verification!.id;
}

describe("bash verification boundary", () => {
	it.each([
		["No test files found, exiting with code 1\n", true],
		["Tests 1 failed (1)\n", false],
		["runner interrupted without a summary\n", false],
	] as const)("links a corrected invocation only to a proved setup failure: %s", async (initialOutput, clears) => {
		// Windows tmpdir may use RUNNER~1; use the literal long path rather than an opaque tilde spelling.
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-setup-repair-")));
		cleanupDirectories.push(root);
		const wrong = join(root, "wrong");
		const corrected = join(root, "corrected");
		let executions = 0;
		const tool = createBashTool(root, {
			// This adapter models a persistent POSIX shell; Windows routing owns a different cwd state.
			platform: "linux",
			pathFlavor: process.platform === "win32" ? "win32" : "posix",
			operations: {
				exec: async (_command, _cwd, options) => {
					const first = executions++ === 0;
					options.onData(Buffer.from(first ? initialOutput : "Tests 1 passed (1)\n"));
					return { exitCode: first ? 1 : 0, initialCwd: wrong, cwd: first ? wrong : corrected };
				},
			},
		});
		const command = "npx vitest run test/focused.test.ts";
		const failed = await tool.execute("setup-failed", { command });
		const repaired = await tool.execute("setup-repaired", {
			command: `cd '${corrected.replaceAll("\\", "/").replaceAll("'", "'\\''")}' && ${command}`,
			repairOf: verificationId(failed),
		});
		expect(executions).toBe(2);
		expect(repaired.details?.piVerification).toMatchObject({
			status: "passed",
			outcome: "executed",
			repairOf: verificationId(failed),
		});
		expect(repaired.details?.piVerification?.repairGroup).toBe(failed.details?.piVerification?.repairGroup);
		expect(verificationId(repaired)).not.toBe(verificationId(failed));
		const tracker = new VerificationObligationTracker(
			[failed, repaired].map((result, index) => ({
				role: "toolResult",
				toolCallId: `check-${index}`,
				toolName: "bash",
				timestamp: index,
				content: result.content,
				details: result.details,
				isError: result.isError === true,
			})),
		);
		expect(tracker.getActiveIds()).toEqual(clears ? [] : [verificationId(failed)]);
	});

	it.each([false, true])("observes complete raw output independently of fullOutput=%s", async (fullOutput) => {
		const root = mkdtempSync(join(tmpdir(), "pi-vitest-output-boundary-"));
		cleanupDirectories.push(root);
		for (const passed of [false, true]) {
			const tool = createBashTool(root, {
				outputDirectory: root,
				operations: {
					exec: async (_command, _cwd, options) => {
						options.onData(Buffer.from(passed ? "Tests 1 passed (1)\n" : "Tests 3 skipped (3)\n"));
						options.onData(Buffer.from("ordinary log output\n".repeat(3_000)));
						return { exitCode: 0 };
					},
				},
			});
			const result = await tool.execute("raw-verification-witness", { command: "vitest run", fullOutput });
			expect(result.details?.piVerification?.status).toBe(passed ? "passed" : "failed");
			expect(result.isError === true).toBe(!passed);
		}
	});

	it.each([
		"npm exec -- vitest run",
		"pnpm exec vitest run",
		"yarn vitest run",
		"bunx vitest run",
		"node ../../node_modules/vitest/dist/cli.js --run",
	])("checks empty results from direct runner adapter %s", async (command) => {
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("No test files found, exiting with code 0\n"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("adapter-empty-run", { command });
		expect(result.details?.piVerification?.status).toBe("failed");
	});

	it.each([
		["No test files found, exiting with code 0\n", false, "setup_failed"],
		[" Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n", false, "unconfirmed"],
		[" RUN v5.0.0 /workspace\n", false, "unconfirmed"],
		[" Test Files  1 passed (1)\n      Tests  2 passed (2)\n", true, "executed"],
	] as const)("requires executed Vitest tests before certifying exit zero: %s", async (output, passed, outcome) => {
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(output));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("vitest-outcome", {
			command: "npx vitest run test/a.test.ts --passWithNoTests",
		});
		expect(result.details?.piVerification?.status).toBe(passed ? "passed" : "failed");
		expect(result.details?.piVerification?.outcome).toBe(outcome);
		expect(result.isError === true).toBe(!passed);
	});

	it.skipIf(process.platform === "win32")(
		"preserves identity across a relative cd and corrected rerun, without clearing another project's failure",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-bash-verification-cwd-"));
			cleanupDirectories.push(root);
			const repoAPath = join(root, "repo-a");
			const repoBPath = join(root, "repo-b");
			mkdirSync(repoAPath);
			mkdirSync(repoBPath);
			const repoA = realpathSync(repoAPath);
			const repoB = realpathSync(repoBPath);
			for (const [directory, exitCode] of [
				[repoA, 1],
				[repoB, 0],
			] as const) {
				const script = join(directory, "coverage-verification-harness.sh");
				writeFileSync(script, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
				chmodSync(script, 0o755);
			}

			const sessionKey = `bash-verification-cwd-${Math.random().toString(36).slice(2)}`;
			cleanupSessionKeys.push(sessionKey);
			const tool = createBashTool(realpathSync(root), { sessionKey });
			const failed = await tool.execute("fail-in-repo-a", {
				command: "cd repo-a && ./coverage-verification-harness.sh",
			});
			expect(failed).toMatchObject({ isError: true, errorKind: "operation_outcome" });
			writeFileSync(join(repoA, "coverage-verification-harness.sh"), "#!/usr/bin/env bash\nexit 0\n");
			const repaired = await tool.execute("pass-in-repo-a", { command: "./coverage-verification-harness.sh" });
			expect(repaired.details?.piVerification?.status).toBe("passed");
			expect(verificationId(repaired)).toBe(verificationId(failed));

			await tool.execute("cd-to-repo-b", { command: `cd '${repoB.replaceAll("'", "'\\''")}'` });
			const passedInRepoB = await tool.execute("pass-in-repo-b", { command: "./coverage-verification-harness.sh" });
			const passedAgainInRepoB = await tool.execute("pass-again-in-repo-b", {
				command: "./coverage-verification-harness.sh",
			});

			expect(verificationId(failed)).not.toBe(verificationId(passedInRepoB));
			expect(verificationId(passedInRepoB)).toBe(verificationId(passedAgainInRepoB));
		},
	);

	it("does not emit a passed verification when the shell has no exit code", async () => {
		const operations: BashOperations = {
			exec: async () => ({ exitCode: null }),
		};
		const tool = createBashTool(process.cwd(), { operations });

		const verification = await tool.execute("verification-null-exit", {
			command: "npm run coverage:verification-harness",
		});
		const ordinary = await tool.execute("ordinary-null-exit", { command: "echo ordinary" });

		expect(verification).toMatchObject({ isError: true, errorKind: "tool_failure" });
		expect(verification.details?.piVerification).toMatchObject({ version: 1, status: "failed" });
		expect(ordinary).toMatchObject({ isError: true, errorKind: "tool_failure" });
		expect(ordinary.details?.piVerification).toBeUndefined();
	});
	it("records verification when a spawn hook only adjusts the environment (the live configuration)", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from(" Test Files  1 passed (1)\n      Tests  1 passed (1)\n"));
				return { exitCode: 0 };
			},
		};
		const tool = createBashTool(process.cwd(), {
			operations,
			spawnHook: (context) => ({ ...context, env: { ...context.env, PI_TEST_HOOK_MARK: "1" } }),
		});
		const result = await tool.execute("verify-with-env-hook", { command: "npx vitest run test/a.test.ts" });
		expect(result.details?.piVerification).toMatchObject({ version: 1, status: "passed" });
	});

	it("does not certify a test that a spawn hook replaces with an unrelated command", async () => {
		const tool = createBashTool(process.cwd(), {
			operations: { exec: async () => ({ exitCode: 0 }) },
			spawnHook: (context) => ({ ...context, command: "echo no tests executed" }),
		});
		const result = await tool.execute("rewritten-test", { command: "npx vitest run test/a.test.ts" });
		expect(result.details?.piVerification).toBeUndefined();
	});

	it("does not invent verification context when a stateful adapter reports its initial cwd unavailable", async () => {
		const tool = createBashTool(process.cwd(), {
			operations: { exec: async () => ({ exitCode: 0, initialCwd: undefined, cwd: "/unknown/final" }) },
		});
		const result = await tool.execute("unknown-cwd", { command: "npx vitest run test/a.test.ts" });
		expect(result.details?.piVerification).toBeUndefined();
	});

	it("does not certify a different execution directory selected by shell state such as CDPATH", async () => {
		const tool = createBashTool("/workspace", {
			platform: "linux",
			operations: { exec: async () => ({ exitCode: 0, initialCwd: "/workspace", cwd: "/external/package" }) },
		});
		const result = await tool.execute("redirected-cd", { command: "cd package && npm test" });
		expect(result.details?.piVerification).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("checks a real persistent shell's CDPATH redirection", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-verification-cdpath-")));
		cleanupDirectories.push(root);
		const external = join(root, "external");
		const project = join(external, "package");
		mkdirSync(project, { recursive: true });
		const script = join(project, "verification.sh");
		writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(script, 0o755);
		const sessionKey = `verification-cdpath-${Math.random().toString(36).slice(2)}`;
		cleanupSessionKeys.push(sessionKey);
		const tool = createBashTool(root, { sessionKey });
		await tool.execute("set-cdpath", { command: `export CDPATH='${external.replaceAll("'", "'\\''")}'` });
		const redirected = await tool.execute("redirected-verification", { command: "cd package && ./verification.sh" });
		expect(redirected.isError).not.toBe(true);
		expect(redirected.details?.piVerification).toBeUndefined();
		const direct = await tool.execute("direct-verification", { command: "./verification.sh" });
		expect(direct.details?.piVerification?.status).toBe("passed");
	});
});
