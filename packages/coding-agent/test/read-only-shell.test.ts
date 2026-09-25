import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isMutatingToolCall, readOnlyShellViolation } from "../src/core/model-router/tool-escalation.ts";

// Existence decides whether a redirect edits something, so the fixture owns the files it names.
const cwd = mkdtempSync(join(tmpdir(), "pi-read-only-shell-"));
writeFileSync(join(cwd, "README.md"), "readme");
writeFileSync(join(cwd, "package.json"), "{}");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
describe("read-only shell line", () => {
	it("refuses edits to existing paths and allows reads and new-file captures", () => {
		const cases: Array<[string, boolean]> = [
			["git log --oneline -5", true],
			["cd packages && git diff HEAD~1 --stat", true],
			["rg foo src | head -20 > new-output.txt", true],
			["git log 2>&1 | tee new-tee.txt", true],
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
			// Observational commands a requirement check uses.
			["command -v ollama", true],
			["command ollama serve", false],
			["ss -ltn | grep -c 11434", true],
			["systemctl --user is-enabled llama-server", true],
			["systemctl --user disable llama-server", false],
			["pgrep -f llama-server", true],
			["curl -s https://docs.example.test/version", true],
			["curl -s -X POST https://api.example.test/deploy", false],
			["curl -sd payload https://api.example.test", false],
			["curl -o page.html https://example.test", false],
			// A variable assignment changes only the shell; one that steers what runs is refused.
			['M=/srv/machine; test ! -e "$M/usr/local/bin/ollama"', true],
			["LC_ALL=C sort README.md", true],
			["PATH=/tmp/evil ls", false],
			["LD_PRELOAD=/tmp/x.so cat README.md", false],
			["GIT_EXTERNAL_DIFF=/tmp/x git diff", false],
			["M=/srv; rm -rf $M", false],
		];
		for (const [cmd, ok] of cases) expect([cmd, readOnlyShellViolation(cmd, cwd) === undefined]).toEqual([cmd, ok]);
		expect(isMutatingToolCall("bash", { command: "echo x > f" })).toBe(true);
		expect(isMutatingToolCall("bash", { command: "git log" })).toBe(false);
	});
});
