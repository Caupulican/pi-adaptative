import { HARNESS_LAUNCH_ENV_KEYS } from "../src/core/harness-environment.ts";

// This module must evaluate before config.ts reads and caches installed-package metadata.
export const launchEnvBackup = new Map<string, string | undefined>();
for (const key of HARNESS_LAUNCH_ENV_KEYS) {
	launchEnvBackup.set(key, process.env[key]);
	delete process.env[key];
}
