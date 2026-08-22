import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

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
			rmSync(path, { recursive: true, force: true });
		}
	});
}

const isolatedAgentDir = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "pi-agent-test-")));
isolationState.pendingCleanup.add(isolatedAgentDir);
process.env[ENV_AGENT_DIR] = isolatedAgentDir;

afterAll(() => {
	if (isolationState.originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = isolationState.originalAgentDir;
	}
	rmSync(isolatedAgentDir, { recursive: true, force: true });
	isolationState.pendingCleanup.delete(isolatedAgentDir);
});
