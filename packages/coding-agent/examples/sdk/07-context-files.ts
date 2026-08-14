/**
 * Context Files (AGENTS.md)
 *
 * Global ~/.pi/agent context files are injected at startup. Repository files are
 * off until the directory/project opts in (`projectContextFiles: "on-demand"`),
 * then listed by path and read on demand. Override the list to add virtual files
 * or hide project ones.
 */

import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@caupulican/pi-adaptative";

// Override the discovered list (global files plus on-demand project paths).
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	agentsFilesOverride: (current) => ({
		agentsFiles: [...current.agentsFiles, { path: "/virtual/AGENTS.md", content: "Virtual project instructions" }],
	}),
});
await loader.reload();

// Discover AGENTS.md files walking up from cwd
const discovered = loader.getAgentsFiles().agentsFiles;
console.log("Discovered context files:");
for (const file of discovered) {
	console.log(`  - ${file.path}`);
}

const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${discovered.length + 1} context files`);
session.dispose();
