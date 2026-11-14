/**
 * The environment a session's own commands (bash, python, run_process) run in, decided by the session's private path
 * scope. A session that keeps the owner's credentials out (`credentialExposure: "deny"`, a bot's) runs its commands as a
 * worker's run does (`createWorkerRunEnvironment`): credential-named variables and the owner's vault session stripped
 * except the owner's `PI_WORKER_PASS_ENV` grant, `PI_SESSION_ROLE=worker` so a `pi` it starts is no root, a scratch temp
 * directory, and an ownership marker whose processes still running are ended when the session closes. The credential
 * manager's project environment is never added to such a session's commands. A worker process's own environment was
 * built by its launcher, so it only goes without that project environment. Any other session's commands carry the
 * credential manager's environment for their working directory, and never the vault session.
 */

import { interfaceText } from "../language/interface-text.ts";
import type { CredentialExposureMode } from "../secrets/credential-exposure-guard.ts";
import { isWorkerSession } from "../session-role.ts";
import type { BashSpawnHook } from "../tools/bash.ts";
import { laneRunsOffline } from "./lane-shell-scope.ts";
import { createWorkerRunEnvironment, listReapedProcesses } from "./worker-run-environment.ts";
import type { SessionPrivatePathScope } from "./worker-session-private-scope.ts";

const VAULT_SESSION_VARIABLE = "BW_SESSION";

export interface SessionCommandEnvironment {
	/**
	 * How the session meets an owner credential: a worker process, and a session whose scope says so, never; the owner's
	 * own session sees masked values.
	 */
	readonly credentialExposure: CredentialExposureMode;
	readonly spawnHook: BashSpawnHook;
	readonly python: {
		readonly environment: (cwd: string) => NodeJS.ProcessEnv;
		readonly omitEnvironmentVariables: readonly string[];
	};
	readonly runProcess: {
		readonly environment: (cwd: string) => NodeJS.ProcessEnv;
		readonly attributionEnvironment?: Readonly<NodeJS.ProcessEnv>;
	};
	/**
	 * End what the session's commands left running and remove their scratch directory; `holdWarning` receives the owner's
	 * notice of the processes that were ended.
	 */
	dispose(holdWarning?: (message: string) => void): void;
}

/**
 * `label` names the run's processes and the commits they make (the session's shell key); `credentialEnvironment` is the
 * credential manager's environment for a working directory, added only where credentials are not denied.
 */
export function createSessionCommandEnvironment(
	scope: SessionPrivatePathScope | undefined,
	label: string,
	credentialEnvironment: (cwd: string) => Record<string, string> | undefined,
): SessionCommandEnvironment {
	const workerProcess = isWorkerSession();
	const credentialExposure: CredentialExposureMode = workerProcess ? "deny" : (scope?.credentialExposure ?? "mock");
	const denied = credentialExposure === "deny";
	const readOnly = scope?.readOnlyShell === true;
	let stopped: readonly string[] = [];
	const run =
		denied && !workerProcess
			? createWorkerRunEnvironment(
					label,
					(processes) => {
						stopped = processes;
					},
					{
						offline: laneRunsOffline({ readOnly, shellReadOnly: readOnly, network: scope?.network === true }),
						readOnly,
					},
				)
			: undefined;
	const added = (cwd: string): NodeJS.ProcessEnv => (denied ? {} : (credentialEnvironment(cwd) ?? {}));
	return {
		credentialExposure,
		spawnHook: (context) => {
			const hooked = run ? run.spawnHook(context) : context;
			const env = { ...hooked.env, ...added(hooked.cwd) };
			delete env[VAULT_SESSION_VARIABLE];
			return { ...hooked, env };
		},
		python: {
			environment: (cwd) => ({ ...added(cwd), ...run?.attributionEnvironment }),
			omitEnvironmentVariables: [...new Set([VAULT_SESSION_VARIABLE, ...(run?.omittedEnvironmentVariables ?? [])])],
		},
		runProcess: { environment: added, ...(run ? { attributionEnvironment: run.attributionEnvironment } : {}) },
		dispose: (holdWarning) => {
			run?.dispose();
			if (stopped.length === 0) return;
			holdWarning?.(interfaceText().notices.sessionProcessesStopped(stopped.length, listReapedProcesses(stopped)));
			stopped = [];
		},
	};
}
