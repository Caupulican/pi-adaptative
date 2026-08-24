import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyShellVerificationCommand } from "../src/core/tools/shell-test-command.ts";

describe("shell verification classifier", () => {
	it.each([
		"vitest --run test/focused.test.ts",
		"jest test/focused.test.ts --runInBand",
		"pytest tests/test_focused.py",
		"node --test test/focused.test.ts",
		"npm test -- test/focused.test.ts",
		"npm run check",
		"npm run coverage:verification-harness",
		"npm run verification",
		"pnpm run coverage",
		"pnpm run verification",
		"yarn run coverage",
		"yarn run verification",
		"bun run coverage",
		"bun run verification",
		"./test.sh packages/ai/test/validation.test.ts",
		"cd packages/agent && vitest --run test/tool-failure-memory.test.ts",
		"set -o pipefail; npm test | tee /tmp/focused-test.log",
	])("recognizes one conservative verification command: %s", (command) => {
		const classification = classifyShellVerificationCommand(command, "/workspace/project");

		expect(classification).toMatchObject({ kind: "test", id: expect.any(String) });
		expect(classification?.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		expect(classification?.id.length).toBeLessThanOrEqual(256);
	});

	it.each([
		"npm test && npm run check",
		"cd packages/agent && vitest --run test/tool-failure-memory.test.ts && npm run check",
		"set -o pipefail; npm test | tee /tmp/focused-test.log && npm run check",
	])("recognizes an all-verification chain under one exact aggregate id: %s", (command) => {
		const cwd = "/workspace/project";
		const classification = classifyShellVerificationCommand(command, cwd);

		expect(classification).toEqual({
			kind: "test",
			id: `shell-test-${createHash("sha256").update(cwd).update("\0").update(command).digest("base64url")}`,
		});
	});

	it("keeps the verification id stable only for the exact command and working directory", () => {
		const command = "cd packages/agent && vitest --run test/tool-failure-memory.test.ts";
		const initial = classifyShellVerificationCommand(command, "/workspace/project");
		const repeated = classifyShellVerificationCommand(command, "/workspace/project");
		const differentCommand = classifyShellVerificationCommand(`${command} --reporter=dot`, "/workspace/project");
		const differentCwd = classifyShellVerificationCommand(command, "/workspace/other-project");

		expect(initial).toMatchObject({ kind: "test", id: expect.any(String) });
		expect(repeated?.id).toBe(initial?.id);
		expect(differentCommand?.id).not.toBe(initial?.id);
		expect(differentCwd?.id).not.toBe(initial?.id);
	});

	it.each([
		"echo 'npm test'",
		"rg 'vitest --run' packages/coding-agent",
		"false",
		"npm test && echo cleanup-complete",
		"echo test; false",
		"cd packages/agent; npm run check",
		"npm test; npm run check",
		"cd packages/agent || npm test",
		"npm test || npm run check",
		"npm test > /tmp/test.log",
		"npm test | tee /tmp/test.log",
		"set -o pipefail; npm test | tee /tmp/test.log; npm run check",
		"set -o pipefail; npm test | tee /tmp/test.log && echo cleanup-complete",
		"npm test; npm test",
		"npm run build",
		"pnpm run deploy",
		"yarn run cleanup",
		"bun run generate",
		"| npm test",
	])("rejects a shell command that only mentions or obscures a test: %s", (command) => {
		expect(classifyShellVerificationCommand(command, "/workspace/project")).toBeUndefined();
	});
});
