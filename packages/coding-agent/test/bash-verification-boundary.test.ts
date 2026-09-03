import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	it.skipIf(process.platform === "win32")(
		"keys verification by the persistent shell's effective cwd, while preserving same-cwd identity",
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
			const tool = createBashTool(repoA, { sessionKey });
			const failed = await tool.execute("fail-in-repo-a", { command: "./coverage-verification-harness.sh" });
			expect(failed).toMatchObject({ isError: true, errorKind: "operation_outcome" });

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
			exec: async () => ({ exitCode: 0 }),
		};
		const tool = createBashTool(process.cwd(), {
			operations,
			spawnHook: (context) => ({ ...context, env: { ...context.env, PI_TEST_HOOK_MARK: "1" } }),
		});
		const result = await tool.execute("verify-with-env-hook", { command: "npx vitest run test/a.test.ts" });
		expect(result.details?.piVerification).toMatchObject({ version: 1, status: "passed" });
	});
});
