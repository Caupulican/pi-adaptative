/**
 * What an authority can do to the working repository, and which tool calls the session observes,
 * taken from the capability catalogue and host-owned tool metadata. Model arguments cannot choose
 * either answer.
 *
 * Each capability carries two separate answers in one table:
 * - `potential`, the effect readiness reasons about:
 *   - "none": proven not to change the repository: path-scoped reads, queries and semantic judgment;
 *   - "typed_paths": changes only the paths a path-scope boundary admits;
 *   - "opaque": anything else. Processes, network and MCP services, credentials, delegation to other
 *     agents, settings, policy, learning, research and publishing can change the repository through
 *     effects no boundary here bounds. Memory and planning mutations write the agent directory and
 *     the session store, which a configuration may place inside the repository, so they are opaque
 *     too. An unclassified effect is never read as none.
 * - `observedCall`, the owner's observation policy for a tool call: only path writes, worktree
 *   mutation, sources, skills, processes and test runs are observed. An opaque capability outside it
 *   is unobserved by policy, which does not make it proven read-only: an in-repository agent or
 *   session store, or an extension tool outside a delivery, can change the repository unobserved.
 * A tool takes the strongest potential effect of its capabilities; typed path writes stay typed only
 * under path-scope enforcement alone, and a tool the catalogue does not know is opaque.
 */
import type { HarnessCapability } from "../capability-contract.ts";
import { getToolCapabilityPolicy, toolCapabilityRequirementClauses } from "../tool-capability-policy.ts";

export type RepositoryEffect = "typed_owned_write" | "observe" | "none";
export type HostRepositoryEffect = "none" | "observe" | "typed_paths";
export type RepositoryEffectClass = "none" | "typed_paths" | "opaque";

interface CapabilityRepositoryPolicy {
	readonly potential: RepositoryEffectClass;
	readonly observedCall: boolean;
}

const CAPABILITY_REPOSITORY_POLICY: Readonly<Record<HarnessCapability, CapabilityRepositoryPolicy>> = {
	"filesystem.read": { potential: "none", observedCall: false },
	"worktree.read": { potential: "none", observedCall: false },
	"repo.read": { potential: "none", observedCall: false },
	"source.read": { potential: "none", observedCall: false },
	"skill.read": { potential: "none", observedCall: false },
	"settings.read": { potential: "none", observedCall: false },
	"memory.query": { potential: "none", observedCall: false },
	"semantic.judge": { potential: "none", observedCall: false },
	"filesystem.write": { potential: "typed_paths", observedCall: true },
	"worktree.mutate": { potential: "typed_paths", observedCall: true },
	"source.write": { potential: "typed_paths", observedCall: true },
	"skill.write": { potential: "typed_paths", observedCall: true },
	"process.exec": { potential: "opaque", observedCall: true },
	"tests.execute": { potential: "opaque", observedCall: true },
	"network.http": { potential: "opaque", observedCall: false },
	"service.mcp": { potential: "opaque", observedCall: false },
	"credentials.use": { potential: "opaque", observedCall: false },
	"memory.mutate": { potential: "opaque", observedCall: false },
	"workflow.plan": { potential: "opaque", observedCall: false },
	"settings.write": { potential: "opaque", observedCall: false },
	"research.execute": { potential: "opaque", observedCall: false },
	"workflow.delegate": { potential: "opaque", observedCall: false },
	"policy.modify": { potential: "opaque", observedCall: false },
	"learning.propose": { potential: "opaque", observedCall: false },
	"publish.execute": { potential: "opaque", observedCall: false },
};

const EFFECT_STRENGTH: Readonly<Record<RepositoryEffectClass, number>> = { none: 0, typed_paths: 1, opaque: 2 };

/** The strongest of `classes`; none when there are none. */
export function strongestRepositoryEffect(classes: readonly RepositoryEffectClass[]): RepositoryEffectClass {
	return classes.reduce<RepositoryEffectClass>(
		(strongest, effect) => (EFFECT_STRENGTH[effect] > EFFECT_STRENGTH[strongest] ? effect : strongest),
		"none",
	);
}

export function capabilityRepositoryEffect(capability: HarnessCapability): RepositoryEffectClass {
	return CAPABILITY_REPOSITORY_POLICY[capability].potential;
}

/** Every capability alternative of the tool's invocation counts: the caller may hold any of them. */
export function toolRepositoryEffect(toolName: string, args?: unknown): RepositoryEffectClass {
	const policy = getToolCapabilityPolicy(toolName);
	if (!policy) return "opaque";
	const effect = strongestRepositoryEffect(
		toolCapabilityRequirementClauses(toolName, args).flat().map(capabilityRepositoryEffect),
	);
	if (effect !== "typed_paths") return effect;
	return policy.enforcements.length > 0 && policy.enforcements.every((enforcement) => enforcement === "path-scope")
		? "typed_paths"
		: "opaque";
}

/** The observation the session applies to one tool call under the owner's observation policy. */
export function repositoryEffectForCall(input: {
	readonly toolName: string;
	readonly args: unknown;
	readonly deliveryActive: boolean;
	readonly hostEffect?: HostRepositoryEffect;
}): RepositoryEffect {
	if (input.hostEffect === "none") return "none";
	if (input.hostEffect === "typed_paths") return "typed_owned_write";
	if (input.hostEffect === "observe") return "observe";
	const name = input.toolName.toLowerCase();
	if (name === "tool_task" || name === "repo_read") return "none";
	if (name === "edit" || name === "write" || name === "edit-diff") return "typed_owned_write";
	const clauses = toolCapabilityRequirementClauses(name, input.args);
	if (clauses.length === 0) return input.deliveryActive ? "observe" : "none";
	return clauses.flat().some((capability) => CAPABILITY_REPOSITORY_POLICY[capability].observedCall)
		? "observe"
		: "none";
}
