import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(import.meta.dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function translate(python: string, path: string, windows: boolean): string {
	const program = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from paths import translate_posix_drive_path
sys.stdout.write(json.dumps(translate_posix_drive_path(json.loads(${JSON.stringify(JSON.stringify(path))}), windows=${windows ? "True" : "False"})))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`engine crashed: ${result.stderr}`);
	return JSON.parse(result.stdout) as string;
}

describe("pi-shell-engine paths.py", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	it("maps Git-Bash and WSL drive roots onto Windows drives, only on Windows", () => {
		expect(translate(python, "/c/Program Files (x86)/tool.exe", true)).toBe("C:/Program Files (x86)/tool.exe");
		expect(translate(python, "/mnt/d/repo/file.txt", true)).toBe("D:/repo/file.txt");
		expect(translate(python, "/c", true)).toBe("/c");
		expect(translate(python, "/usr/bin/env", true)).toBe("/usr/bin/env");
		expect(translate(python, "C:/already", true)).toBe("C:/already");
		expect(translate(python, "/c/Program Files", false)).toBe("/c/Program Files");
	});
});
