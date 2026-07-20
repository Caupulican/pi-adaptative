import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(__dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function resolveAbsolutePython(python: string): string {
	const result = spawnSync(python, ["-c", "import sys; sys.stdout.write(sys.executable)"], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`failed to resolve absolute python path: ${result.stderr}`);
	return result.stdout.trim();
}

function runProbe(python: string, program: string): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("pi-shell-engine proc (external-command spawn + deadline kill)", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	const pyPath = resolveAbsolutePython(python);

	it("spawns an external command in the requested cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proc-"));
		const program = `
import sys, subprocess, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from state import ShellState
import proc

state = ShellState(cwd=${JSON.stringify(dir)}, env={"PATH": os.environ.get("PATH", "")})
child = proc.spawn_external(
    [${JSON.stringify(pyPath)}, "-c", "import os,sys; sys.stdout.write(os.getcwd())"],
    state, subprocess.DEVNULL, subprocess.PIPE, subprocess.PIPE, None,
)
out, _ = child.communicate()
sys.stdout.write(out.decode("utf-8"))
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(dir);
	});

	it("spawns an external command with the requested env (not the ambient process env)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proc-"));
		const program = `
import sys, subprocess, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from state import ShellState
import proc

state = ShellState(cwd=${JSON.stringify(dir)}, env={"PATH": os.environ.get("PATH", ""), "PI_TEST_VAR": "hello-engine"})
child = proc.spawn_external(
    [${JSON.stringify(pyPath)}, "-c", "import os,sys; sys.stdout.write(os.environ.get('PI_TEST_VAR',''))"],
    state, subprocess.DEVNULL, subprocess.PIPE, subprocess.PIPE, None,
)
out, _ = child.communicate()
sys.stdout.write(out.decode("utf-8"))
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("hello-engine");
	});

	it("a breached deadline kills a sleeping child and reports exit code 124", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-proc-"));
		const program = `
import sys, subprocess, os, time
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from state import ShellState
import proc

state = ShellState(cwd=${JSON.stringify(dir)}, env={"PATH": os.environ.get("PATH", "")})
child = proc.spawn_external(
    [${JSON.stringify(pyPath)}, "-c", "import time; time.sleep(30)"],
    state, subprocess.DEVNULL, subprocess.DEVNULL, subprocess.DEVNULL, time.monotonic() + 0.3,
)
code = proc.wait_with_deadline(child, time.monotonic() - 100)
sys.stdout.write(str(code))
sys.stdout.write(",")
sys.stdout.write(str(child.poll()))
`;
		const start = Date.now();
		const result = runProbe(python, program);
		const elapsedMs = Date.now() - start;
		expect(result.status).toBe(0);
		const [code, polled] = result.stdout.trim().split(",");
		expect(code).toBe("124");
		expect(polled).not.toBe("None");
		expect(elapsedMs).toBeLessThan(10_000);
	});

	it("resolve_external finds the requested interpreter via an absolute path", () => {
		const program = `
import sys, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
import proc

resolved = proc.resolve_external(${JSON.stringify(pyPath)}, {"PATH": os.environ.get("PATH", "")})
sys.stdout.write(resolved or "")
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(pyPath);
	});

	it("resolve_external returns None for an unknown command", () => {
		const program = `
import sys, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
import proc

resolved = proc.resolve_external("definitely-not-a-real-command-xyz", {"PATH": os.environ.get("PATH", "")})
sys.stdout.write("none" if resolved is None else resolved)
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("none");
	});

	it("resolve_external finds a bare name over a PATH-dirs list (manual resolution, not just absolute)", () => {
		const program = `
import sys, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
import proc

pyDir, pyName = os.path.split(${JSON.stringify(pyPath)})
resolved = proc.resolve_external(pyName, {"PATH": pyDir})
sys.stdout.write(resolved or "none")
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(pyPath);
	});

	it("architect fix #11: resolve_external never reads or mutates os.environ (thread-safe manual resolution)", () => {
		const program = `
import sys, os, threading
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
import proc

before_path = os.environ.get("PATH")
before_pathext = os.environ.get("PATHEXT")
os.environ.pop("PATH", None)
os.environ.pop("PATHEXT", None)

pyDir, pyName = os.path.split(${JSON.stringify(pyPath)})
results = [None] * 20
errors = []

def worker(i):
    try:
        # Concurrent calls with DIFFERENT env dicts: a shared os.environ mutation would
        # race across these threads and could resolve the wrong PATH for some of them.
        env = {"PATH": pyDir} if i % 2 == 0 else {"PATH": "/definitely/not/a/real/dir"}
        results[i] = proc.resolve_external(pyName, env)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))

threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
for t in threads: t.start()
for t in threads: t.join()

ok = (
    not errors
    and os.environ.get("PATH") is None
    and os.environ.get("PATHEXT") is None
    and all(results[i] == ${JSON.stringify(pyPath)} for i in range(0, 20, 2))
    and all(results[i] is None for i in range(1, 20, 2))
)
sys.stdout.write("ok" if ok else "FAIL:" + repr((errors, os.environ.get("PATH"), results)))

if before_path is not None:
    os.environ["PATH"] = before_path
if before_pathext is not None:
    os.environ["PATHEXT"] = before_pathext
`;
		const result = runProbe(python, program);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("ok");
	});
});
