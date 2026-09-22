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
	"repo.read",
	"memory.query",
	"memory.mutate",
	/** Ask the host-brokered semantic judge (System One) for a verdict. Credentials never leave the host,
	 * nothing local changes, and the harness already sends the same kind of state for System One. */
	"semantic.judge",
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
