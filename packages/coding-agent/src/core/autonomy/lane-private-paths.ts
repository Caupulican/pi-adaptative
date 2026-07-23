import path from "node:path";
import { configFile, getWorkRoot, sessionsDir, stateDir } from "../agent-paths.ts";

export function getPrivateLaneDeniedPaths(cwd: string, agentDir: string): string[] {
	return [
		configFile(agentDir, "auth.json"),
		configFile(agentDir, "MEMORY.md"),
		configFile(agentDir, "USER.md"),
		configFile(agentDir, "settings.json"),
		configFile(agentDir, "models.json"),
		sessionsDir(agentDir),
		stateDir(agentDir),
		getWorkRoot(agentDir),
		path.join(cwd, ".pi", "settings.json"),
	];
}
