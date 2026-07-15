import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireWorkRun } from "../../packages/coding-agent/src/utils/work-directory.ts";

export function getScriptAgentDir(env = process.env) {
	return (
		env.PI_ADAPTATIVE_CODING_AGENT_DIR ||
		env["PI-ADAPTATIVE_CODING_AGENT_DIR"] ||
		env.PI_CODING_AGENT_DIR ||
		env.PI_AGENT_DIR ||
		join(homedir(), ".pi", "agent")
	);
}

export function acquireScriptWorkRun(category, tenant, options = {}) {
	return acquireWorkRun({
		agentDir: getScriptAgentDir(options.env),
		category,
		tenant,
		runId: options.runId,
		retention: options.retention,
	});
}

export function removeScriptWorkRun(workRun) {
	workRun.release();
	rmSync(workRun.path, { recursive: true, force: true });
}
