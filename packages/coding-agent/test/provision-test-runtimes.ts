/**
 * Provisions the shared test runtimes (run by global-test-runtimes.ts in a child process whose
 * agent dir is the shared directory): the managed uv and the uv-managed Python the Windows shell
 * engine needs. Tests then find both warm instead of installing them inside a test's time budget.
 */
import { ensurePythonRuntime } from "../src/core/python-runtime.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

const uv = await ensureTool("uv", true);
const python = await ensurePythonRuntime({ silent: true });
process.stdout.write(
	`${JSON.stringify({ uv: uv ?? null, python: python.status === "ready" ? python.pythonPath : python.reason })}\n`,
);
if (!uv || python.status !== "ready") process.exitCode = 1;
