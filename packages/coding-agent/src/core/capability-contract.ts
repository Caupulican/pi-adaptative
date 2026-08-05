/** Canonical semantic authority vocabulary shared by every harness plane. */
export const HARNESS_CAPABILITIES = [
	"filesystem.read",
	"filesystem.write",
	"process.exec",
	"network.http",
	"service.mcp",
	"credentials.use",
	"tests.execute",
	"worktree.read",
	"worktree.mutate",
	"memory.query",
	"memory.mutate",
	"settings.read",
	"settings.write",
	"skill.read",
	"skill.write",
	"source.read",
	"source.write",
	"research.execute",
	"workflow.plan",
	"workflow.delegate",
	"policy.modify",
	"learning.propose",
	"publish.execute",
] as const;

export type HarnessCapability = (typeof HARNESS_CAPABILITIES)[number];
