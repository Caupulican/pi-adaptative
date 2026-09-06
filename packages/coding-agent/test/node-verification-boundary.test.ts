import { VerificationObligationTracker } from "@caupulican/pi-agent-core/verification-obligations";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { verificationCwdFixture } from "./fixtures/session-failures.ts";

const passingOutput =
	"# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";

describe("runner-neutral Node verification boundary", () => {
	it.each([
		[verificationCwdFixture.setupOutput, "setup_failed", true],
		[passingOutput.replace("# pass 1", "# pass 0").replace("# fail 0", "# fail 1"), "executed", false],
		["runner interrupted", "unconfirmed", false],
	] as const)("links only a proven setup correction: %s", async (initialOutput, outcome, clears) => {
		const fixture = verificationCwdFixture;
		let calls = 0;
		const tool = createBashTool(fixture.workspaceRoot, {
			platform: "linux",
			operations: {
				exec: async (_command, _cwd, options) => {
					const first = calls++ === 0;
					options.onData(Buffer.from(first ? initialOutput : passingOutput));
					const cwd = first ? fixture.incorrectCwd : fixture.correctedCwd;
					return { exitCode: first ? 1 : 0, initialCwd: cwd, cwd };
				},
			},
		});
		const failed = await tool.execute("fixture-failed", { command: fixture.command });
		expect(failed.details?.piVerification?.outcome).toBe(outcome);
		const repaired = await tool.execute("fixture-repaired", {
			command: fixture.command,
			repairOf: failed.details?.piVerification?.id,
		});
		expect(repaired.details?.piVerification).toMatchObject({ status: "passed", outcome: "executed" });
		const tracker = new VerificationObligationTracker(
			[failed, repaired].map((result, index) => ({
				role: "toolResult",
				toolCallId: `fixture-${index}`,
				toolName: "bash",
				content: result.content,
				details: result.details,
				isError: result.isError === true,
				timestamp: index,
			})),
		);
		expect(tracker.getActiveIds()).toEqual(clears ? [] : [failed.details?.piVerification?.id]);
	});
	it.each([
		"",
		"# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n",
		passingOutput.replace("# pass 1", "# pass 0").replace("# skipped 0", "# skipped 1"),
		passingOutput.replace("# tests 1", "# tests 2"),
		passingOutput.replace("# duration_ms 1\n", ""),
	])("does not certify exit zero without complete executed tests: %j", async (output) => {
		const tool = createBashTool(verificationCwdFixture.workspaceRoot, {
			platform: "linux",
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(output));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("fixture-unconfirmed", { command: verificationCwdFixture.command });
		expect(result.details?.piVerification?.status).toBe("failed");
	});
});
