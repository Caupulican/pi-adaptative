import { HARNESS_LAUNCH_ENV_KEYS } from "../src/core/harness-environment.ts";

// This module must evaluate before config.ts reads and caches installed-package metadata.
export const launchEnvBackup = new Map<string, string | undefined>();
// A checkout's tests do not own the hosting terminal or its worker grants. Remove these before
// importing any runtime owner, even when Vitest is invoked directly instead of through test.sh.
const launchKeys = new Set(HARNESS_LAUNCH_ENV_KEYS);
for (const key of Object.keys(process.env)) {
	if (
		/^(?:HERDR_|PI_COLLABORATION_|PI_PARENT_|PI_WORKTREE_|PI_WORKER_)/i.test(key) ||
		/^(?:PI_SESSION_ROLE|PI_ORCHESTRATION_AGENT_ID|PI_TASK_REF)$/i.test(key)
	)
		launchKeys.add(key);
}
for (const key of launchKeys) {
	launchEnvBackup.set(key, process.env[key]);
	delete process.env[key];
}
