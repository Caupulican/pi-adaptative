import { join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir } from "../../config.ts";
import { getWorkRunDir } from "../../utils/work-directory.ts";

/** The `pi-collaboration` work run under the agent directory. Its lease is held by the coordinator only. */
export const COLLABORATION_WORK_RUN = { category: "background", tenant: "pi-collaboration", runId: "state" } as const;

/**
 * The managed collaboration state directory: the `jobs` directory of the work run. A pure path. The coordinator holds
 * the run's lease through getProcessWorkRun, and getWorkRunDir joins the same segments that acquisition creates, so both
 * name the same directory. Members and the peer CLI resolve it here without writing a lease or pruning sibling runs.
 */
export function collaborationStateDirectory(agentDir: string = getAgentDir()): string {
	const { category, tenant, runId } = COLLABORATION_WORK_RUN;
	return join(getWorkRunDir(agentDir, category, tenant, runId), "jobs");
}

/**
 * The agent directory when the process overrides it through the environment, and undefined for the default. A peer
 * command carries that directory so a shell that does not inherit the variable still resolves the same root.
 */
export function collaborationAgentDirOverride(): string | undefined {
	return process.env[ENV_AGENT_DIR] ? getAgentDir() : undefined;
}
