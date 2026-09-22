import "../../../scripts/vitest-worker-parent-exit.ts";
import "./test-launch-env-setup.ts";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { removeTreeSync } from "../src/core/util/remove-tree.ts";
import { launchEnvBackup } from "./test-launch-env-setup.ts";

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
			removeTreeSync(path);
		}
	});
}

const isolatedAgentDir = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "pi-agent-test-")));
isolationState.pendingCleanup.add(isolatedAgentDir);
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
	removeTreeSync(isolatedAgentDir);
	isolationState.pendingCleanup.delete(isolatedAgentDir);
});
