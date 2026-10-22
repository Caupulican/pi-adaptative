import { join } from "node:path";

/** `<agentDir>/state` -- durable machine-managed state. Deleting it loses real history, not just cache. */
export function stateDir(agentDir: string): string {
	return join(agentDir, "state");
}

/** `<agentDir>/state/<segments…>` */
export function stateFile(agentDir: string, ...segments: string[]): string {
	return join(stateDir(agentDir), ...segments);
}

/** `<agentDir>/sessions` -- session transcript storage (large, established; not a "loose file"). */
export function sessionsDir(agentDir: string): string {
	return join(agentDir, "sessions");
}
