import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(import.meta.dirname, "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	for (const candidate of fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"]) {
		if (spawnSync(candidate, ["--version"], { encoding: "utf-8" }).status === 0) return candidate;
	}
	return null;
}

function notFoundMessage(python: string, argv: string[]): string {
	const script = [
		"import json, sys",
		"from exec import command_not_found_message",
		"sys.stdout.write(command_not_found_message(json.loads(sys.argv[1])))",
	].join("\n");
	const result = spawnSync(python, ["-B", "-c", script, JSON.stringify(argv)], {
		cwd: ENGINE_DIR,
		encoding: "utf-8",
		env: { ...process.env, PYTHONPATH: ENGINE_DIR },
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

describe("windows shell engine cmd.exe dialect hints", () => {
	const python = resolvePython();
	it.skipIf(python === null)("names the bash spelling when a cmd.exe builtin is not found", () => {
		if (!python) return;
		expect(notFoundMessage(python, ["dir", "/b"])).toBe(
			"dir: command not found (cmd.exe builtin; in bash use ls -1 (for dir /b), ls -R (for dir /s), ls -la)\n",
		);
		expect(notFoundMessage(python, ["FINDSTR", "/i", "x"])).toContain("in bash use grep -n");
		expect(notFoundMessage(python, ["nosuchtool", "--flag"])).toBe("nosuchtool: command not found\n");
	});
});
