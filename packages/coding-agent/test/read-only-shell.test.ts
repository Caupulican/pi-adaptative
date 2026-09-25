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
			// env is judged by the command it runs; node runs arbitrary code beyond version and syntax checks.
			["env", true],
			["env -u HOME LC_ALL=C sort README.md", true],
			["env python3 -c 'import os; os.remove(\"x\")'", false],
			["env PATH=/tmp/evil ls", false],
			["env -S 'cat README.md'", false],
			["node --version", true],
			["node --check src/index.js", true],
			["node -e \"require('fs').unlinkSync('x')\"", false],
			["node --test", false],
		];
		for (const [cmd, ok] of cases) expect([cmd, readOnlyShellViolation(cmd, cwd) === undefined]).toEqual([cmd, ok]);
		expect(isMutatingToolCall("bash", { command: "echo x > f" })).toBe(true);
		expect(isMutatingToolCall("bash", { command: "git log" })).toBe(false);
	});

	it("admits a run of the project's tests only when asked, and never one that rewrites files", () => {
		const cases: Array<[string, boolean]> = [
			["node --test", true],
			["npx vitest run test/slug.test.ts", true],
			["npm test", true],
			["npm run test:unit | tail -5", true],
			["CI=1 pytest -q tests/test_slug.py", true],
			["python3 -m pytest -q", true],
			["go test ./...", true],
			["cargo test", true],
			["npx vitest run -u", false],
			["npx jest --updateSnapshot", false],
			["vitest --watch", false],
			["npm test && rm -rf dist", false],
			["PATH=/tmp/evil npm test", false],
			["node --test $(ls)", false],
		];
		for (const [cmd, ok] of cases)
			expect([cmd, readOnlyShellViolation(cmd, cwd, { admitTestRuns: true }) === undefined]).toEqual([cmd, ok]);
		expect(readOnlyShellViolation("npm test", cwd)).toBeDefined();
	});
});
