/**
 * Context Files (AGENTS.md)
 *
 * Context files provide project-specific instructions injected into the startup prompt.
 */

import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@caupulican/pi-adaptative";

// Disable context files entirely by returning an empty list in agentsFilesOverride.
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
