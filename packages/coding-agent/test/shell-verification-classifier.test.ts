import { describe, expect, it } from "vitest";
import { classifyShellVerificationCommand } from "../src/core/tools/shell-test-command.ts";

describe("shell verification classifier", () => {
	it("groups explicit setup corrections only within the host workspace and identical verification stages", () => {
		const command = "npx vitest run test/focused.test.ts --pool=forks";
		const original = classifyShellVerificationCommand(
			command,
			"/workspace/project/packages/wrong",
			"/workspace/project",
		);
		const corrected = classifyShellVerificationCommand(
			`cd packages/right && ${command}`,
			"/workspace/project",
			"/workspace/project",
		);
		expect(original?.repairGroup).toMatch(/^shell-repair-/);
		expect(corrected?.repairGroup).toBe(original?.repairGroup);
		expect(corrected?.id).not.toBe(original?.id);
		for (const [source, initialCwd, workspace] of [
			[command, "/workspace/other/packages/right", "/workspace/other"],
			[`${command} --testNamePattern=other`, "/workspace/project", "/workspace/project"],
			[`${command} --project=other`, "/workspace/project", "/workspace/project"],
			[`${command} && npm run check`, "/workspace/project", "/workspace/project"],
			[`${command} ''`, "/workspace/project", "/workspace/project"],
		]) {
			expect(classifyShellVerificationCommand(source, initialCwd, workspace)?.repairGroup).not.toBe(
				original?.repairGroup,
			);
		}
		for (const [source, initialCwd, workspace] of [
			[command, "/workspace/project-sibling", "/workspace/project"],
			[`cd ../external && ${command}`, "/workspace/project", "/workspace/project"],
			["vitest run $TEST_FILTER", "/workspace/project", "/workspace/project"],
			["NODE_ENV=test vitest run test/focused.test.ts", "/workspace/project", "/workspace/project"],
		]) {
			expect(classifyShellVerificationCommand(source, initialCwd, workspace)?.repairGroup).toBeUndefined();
		}
		expect(classifyShellVerificationCommand(command, "/workspace/project")?.repairGroup).toBeUndefined();
	});

	it("keeps drive-relative cd opaque because another drive's cwd is shell state", () => {
		const opaque = classifyShellVerificationCommand("cd C:package && npm test", "D:/workspace");
		expect(opaque).toBeDefined();
		expect(opaque?.cwd).toBeUndefined();
		const absolute = classifyShellVerificationCommand("cd C:/package && npm test", "D:/workspace");
		expect(absolute?.cwd).toBe("C:\\package");
		expect(opaque?.id).not.toBe(absolute?.id);
	});
	it("identifies equivalent reruns from their initial cwd and argument vector", () => {
		const command = "npx vitest run test/tool-failure-memory.test.ts --pool=forks";
		const direct = classifyShellVerificationCommand(command, "/workspace/project/packages/agent");
		expect(direct).toBeDefined();
		for (const [source, cwd] of [
			[`cd packages/agent && ${command}`, "/workspace/project"],
			[`cd /workspace/project/packages/agent && ${command}`, "/workspace/elsewhere"],
			[`npx  vitest run 'test/tool-failure-memory.test.ts' --pool=forks`, "/workspace/project/packages/agent"],
		]) {
			expect(classifyShellVerificationCommand(source, cwd)?.id).toBe(direct?.id);
		}
		for (const [source, cwd] of [
			[command, "/workspace/other-project/packages/agent"],
			[`${command} --testNamePattern=other`, "/workspace/project/packages/agent"],
			[`${command} ''`, "/workspace/project/packages/agent"],
			[`${command} && npm run check`, "/workspace/project/packages/agent"],
		]) {
			const different = classifyShellVerificationCommand(source, cwd);
			expect(different).toBeDefined();
			expect(different?.id).not.toBe(direct?.id);
		}
	});
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
	])("retains the complete all-verification chain under one aggregate id: %s", (command) => {
		const cwd = "/workspace/project";
		const classification = classifyShellVerificationCommand(command, cwd);

		expect(classification).toMatchObject({ kind: "test", id: expect.any(String) });
		expect(classifyShellVerificationCommand(command, cwd)?.id).toBe(classification?.id);
		expect(classifyShellVerificationCommand("npm test", cwd)?.id).not.toBe(classification?.id);
		expect(classifyShellVerificationCommand("npm run check", cwd)?.id).not.toBe(classification?.id);
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
