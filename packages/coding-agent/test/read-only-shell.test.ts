import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMutatingToolCall, readOnlyShellViolation } from "../src/core/model-router/tool-escalation.ts";
import { tempDir } from "./temp-dir.ts";

// Existence decides whether a redirect edits something, so the fixture owns the files it names.
const cwd = tempDir("pi-read-only-shell-");
writeFileSync(join(cwd, "README.md"), "readme");
writeFileSync(join(cwd, "package.json"), "{}");
describe("read-only shell line", () => {
	it("inspects a non-login shell's command and retains its authority boundary", () => {
		const cases: Array<[string, boolean]> = [
			['bash -c "grep -q proof README.md && grep -c current_exe README.md"', true],
			["sh -c 'git status --short'", true],
			["bash -c \"sh -c 'cat README.md'\"", true],
			["bash -c \"sh -c 'dash -c pwd'\"", false],
			["bash -c \"sh -c 'cat README.md > README.md'\"", false],
			["bash --noprofile --norc -c 'pwd && git log --oneline -5'", true],
			["bash -c 'rm -rf README.md'", false],
			["bash -lc 'cat README.md'", false],
			["BASH_ENV=/tmp/script bash -c 'cat README.md'", false],
			["bash -c 'cat README.md' extra", false],
			["bash script.sh", false],
		];
		for (const [command, allowed] of cases) {
			expect([command, readOnlyShellViolation(command, cwd) === undefined]).toEqual([command, allowed]);
			expect(isMutatingToolCall("bash", { command })).toBe(!allowed);
		}
		expect(readOnlyShellViolation("bash -c 'cargo test'", cwd, { admitTestRuns: true })).toBeUndefined();
		expect(readOnlyShellViolation("bash -c 'cargo test'", cwd)).toBeDefined();
		expect(readOnlyShellViolation("bash -c 'cargo test && rm file'", cwd, { admitTestRuns: true })).toBeDefined();
	});
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

	it("admits bounded read-only SSH inspection and rejects opaque or mutating remote execution", () => {
		const cases: Array<[string, boolean]> = [
			["ssh -o BatchMode=yes -o ConnectTimeout=15 work pwd", true],
			["ssh -o BatchMode=yes work 'git -C /repo status --short'", true],
			[
				"ssh -o BatchMode=yes work '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \"Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root\"'",
				true,
			],
			["ssh work", false],
			["ssh work 'rm -rf /repo'", false],
			["ssh work \"git -c alias.status='!rm -rf /repo' status\"", false],
			["ssh -o ProxyCommand='sh -c echo' work pwd", false],
			["ssh work 'bash -lc \"cat /etc/hosts\"'", false],
		];
		for (const [cmd, ok] of cases) expect([cmd, readOnlyShellViolation(cmd, cwd) === undefined]).toEqual([cmd, ok]);
	});
});
