import { describe, expect, it } from "vitest";
import { isMutatingToolCall, readOnlyShellViolation } from "../src/core/model-router/tool-escalation.ts";

const cwd = "/home/caudev/GitHub/mine/pi-adaptative";
describe("ro", () => {
	it("cases", () => {
		const cases: Array<[string, boolean]> = [
			["git log --oneline -5", true],
			["cd packages && git diff HEAD~1 --stat", true],
			["rg foo src | head -20 > /tmp/claude-new-out-xyz.txt", true],
			["git log 2>&1 | tee /tmp/claude-new-tee-xyz.txt", true],
			["cat README.md > README.md", false],
			["echo hi >> package.json", false],
			["sed -i s/a/b/ README.md", false],
			["sed -n 1,5p README.md", true],
			["rm -rf dist", false],
			["git checkout .", false],
			["git branch", true],
			["git branch -a", true],
			["git branch newbranch", false],
			["git tag -l 'v0.*'", true],
			["git tag v9", false],
			["tsc --noEmit -p .", true],
			["tsc -p .", false],
			["find . -name x -delete", false],
			["ls $(pwd)", false],
			["npm install", false],
			["python3 x.py", false],
		];
		for (const [cmd, ok] of cases) expect([cmd, readOnlyShellViolation(cmd, cwd) === undefined]).toEqual([cmd, ok]);
		expect(isMutatingToolCall("bash", { command: "echo x > f" })).toBe(true);
		expect(isMutatingToolCall("bash", { command: "git log" })).toBe(false);
	});
});
