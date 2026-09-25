import "../../../scripts/vitest-worker-parent-exit.ts";
import "./test-launch-env-setup.ts";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { removeTreeSync } from "../src/core/util/remove-tree.ts";
import { SHARED_TEST_RUNTIME_ROOT } from "./global-test-runtimes.ts";
import { launchEnvBackup } from "./test-launch-env-setup.ts";

/**
 * Rebuildable runtimes are shared by the whole run, not isolated per file: each fresh agent dir
 * otherwise installs its own CPython into `runtimes/python` from a cold `cache/uv` the first time a
 * Windows test reaches the shell engine. That per-file download stalled Windows CI tests for 30-70 s
 * (captured by ci-hang-diagnostics-setup.ts). The shared directory is provisioned once per run by
 * global-test-runtimes.ts. User state (settings, auth, sessions) stays isolated.
 */
const SHARED_RUNTIME_LINKS: ReadonlyArray<readonly string[]> = [["runtimes"], ["cache", "uv"]];

function linkSharedRuntimes(agentDir: string): void {
	for (const segments of SHARED_RUNTIME_LINKS) {
		const target = join(SHARED_TEST_RUNTIME_ROOT, ...segments);
		const link = join(agentDir, ...segments);
		mkdirSync(target, { recursive: true });
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(target, link, "junction");
	}
}

/** Remove the links themselves first, so deleting the agent dir never reaches the shared runtimes. */
function removeAgentDir(agentDir: string): void {
	for (const segments of SHARED_RUNTIME_LINKS) {
		const link = join(agentDir, ...segments);
		try {
			if (lstatSync(link).isSymbolicLink()) rmSync(link);
		} catch {
			// Never created, or already removed.
		}
	}
	removeTreeSync(agentDir);
}

interface AgentDirIsolationState {
	originalAgentDir: string | undefined;
	pendingCleanup: Set<string>;
}

const isolationStateKey = Symbol.for("pi-adaptative.test-agent-dir-isolation");
let isolationState = Reflect.get(process, isolationStateKey) as AgentDirIsolationState | undefined;
if (!isolationState) {
	isolationState = { originalAgentDir: process.env[ENV_AGENT_DIR], pendingCleanup: new Set() };
	Reflect.set(process, isolationStateKey, isolationState);
	process.once("exit", () => {
		for (const path of isolationState?.pendingCleanup ?? []) {
			removeAgentDir(path);
		}
	});
}

const isolatedAgentDir = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "pi-agent-test-")));
isolationState.pendingCleanup.add(isolatedAgentDir);
linkSharedRuntimes(isolatedAgentDir);
process.env[ENV_AGENT_DIR] = isolatedAgentDir;

afterAll(() => {
	for (const [key, value] of launchEnvBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (isolationState.originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = isolationState.originalAgentDir;
	}
	removeAgentDir(isolatedAgentDir);
	isolationState.pendingCleanup.delete(isolatedAgentDir);
});
