import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { isPathWithinScope, pathScopesOverlap, safeRealpathSync } from "../autonomy/path-scope.ts";
import { lendableToolSurface } from "../default-tool-surface.ts";
import type { ParentExecutionContext } from "../delegation/parent-execution-context.ts";
import { workerMachinePathRoots } from "../delegation/worker-machine-scope.ts";
import { lendsMemoryReadTool } from "../memory/worker-memory-tools.ts";
import type { ExecutionGrant, ToolCapabilityManifest } from "../orchestration/contracts.ts";
import { ExecutionPolicyCompiler } from "../orchestration/policy-compiler.ts";
import {
	getToolCapabilityPolicy,
	requiredEnvelopeCapabilities,
	resolveProfileToolCapabilities,
} from "../tool-capability-policy.ts";

export const PROACTIVITY_READ_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"repo_read",
	"memory_read",
	"zoom",
	"date",
] as const;
export type ProactivityInvestigationHost = Pick<
	ParentExecutionContext,
	| "getCwd"
	| "getAgentDir"
	| "getForegroundToolNames"
	| "getActiveOrchestrationProfile"
	| "getCapabilityEnvelope"
	| "createLaneMemoryBroker"
	| "getSharedLaneToolOptions"
	| "checkOperation"
	| "settleOwnerPolicy"
>;

/** Captures the real foreground surface, then only intersects optional policy and the finite read surface. */
export class ProactivityReadAuthority {
	readonly cwd: string;
	readonly grant: ExecutionGrant;
	readonly manifests: readonly ToolCapabilityManifest[];
	readonly assertCurrent: () => void;

	constructor(host: ProactivityInvestigationHost) {
		const cwd = host.getCwd();
		const agentDir = host.getAgentDir();
		const foreground = [...(host.getForegroundToolNames?.() ?? [])];
		const profile = structuredClone(host.getActiveOrchestrationProfile?.());
		const envelope = structuredClone(host.getCapabilityEnvelope());
		this.cwd = cwd;
		this.assertCurrent = () => {
			if (
				cwd !== host.getCwd() ||
				agentDir !== host.getAgentDir() ||
				!isDeepStrictEqual(foreground, host.getForegroundToolNames?.() ?? []) ||
				!isDeepStrictEqual(profile, host.getActiveOrchestrationProfile?.()) ||
				!isDeepStrictEqual(envelope, host.getCapabilityEnvelope())
			)
				throw new Error("Proactive read authority changed.");
		};
		const lends = (surface: readonly string[], tool: string): boolean =>
			lendableToolSurface(surface).includes(tool) || lendsMemoryReadTool(surface, tool);
		const tools = PROACTIVITY_READ_TOOLS.filter(
			(tool) =>
				lends(foreground, tool) &&
				(!profile || lends(profile.toolNames, tool)) &&
				(!envelope?.allowedTools || lends(envelope.allowedTools, tool)) &&
				!envelope?.deniedTools?.includes(tool),
		);
		this.manifests = tools.flatMap((toolName) => {
			const policy = getToolCapabilityPolicy(toolName);
			const ceiling =
				profile && envelope
					? profile.capabilityCeiling.filter((capability) => envelope.capabilities.includes(capability))
					: (profile?.capabilityCeiling ?? envelope?.capabilities);
			const capabilities = ceiling
				? resolveProfileToolCapabilities({ capabilityCeiling: ceiling }, toolName)
				: requiredEnvelopeCapabilities(toolName);
			if (!policy || !capabilities) return [];
			return [
				{
					toolName,
					moduleSpecifier: `builtin:${toolName}`,
					capabilities,
					roles: ["explorer" as const],
					enforcements: policy.enforcements,
				},
			];
		});
		const candidates = envelope?.allowedPaths?.map((entry) => resolve(cwd, entry)) ?? workerMachinePathRoots(cwd);
		const focused = profile?.workspacePath ? resolve(cwd, profile.workspacePath) : undefined;
		const readPaths = focused
			? candidates.flatMap((root) =>
					isPathWithinScope(root, focused) ? [root] : isPathWithinScope(focused, root) ? [focused] : [],
				)
			: candidates;
		const deniedPaths = [
			...getPrivateLaneDeniedPaths(cwd, agentDir),
			...(envelope?.deniedPaths ?? []).map((entry) => resolve(cwd, entry)),
		];
		if (readPaths.length > 128 || deniedPaths.length > 128)
			throw new Error("Proactive path policy exceeds its bounded scope limit.");
		const capabilities = [...new Set(this.manifests.flatMap((manifest) => manifest.capabilities))];
		const id = `proactivity:${randomUUID()}`;
		const compiled = new ExecutionPolicyCompiler().compile({
			objectiveId: id,
			taskId: id,
			attemptId: id,
			subjectId: id,
			role: "explorer",
			requiredCapabilities: capabilities,
			authorityCapabilities: capabilities,
			requestedTools: this.manifests.map((manifest) => manifest.toolName),
			toolManifests: this.manifests,
			readPaths,
			deniedPaths,
			writePaths: [],
			requestedBudget: profile?.budget,
			authorityBudget: profile?.budget,
			policyVersion: "proactive-read-v1",
		});
		if (compiled.outcome !== "allow")
			throw new Error(`Proactive read authority refused: ${compiled.reasonCodes.join(", ")}`);
		this.grant = compiled.grant;
	}

	/** The canonical resolver bounds missing-parent and symlink recursion to 32 hops. */
	authorizePath(path: string, subtree = false): void {
		this.assertCurrent();
		const lexical = resolve(this.cwd, path);
		const canonical = safeRealpathSync(lexical);
		const allowed = this.grant.readPaths.flatMap((root) => [resolve(this.cwd, root), safeRealpathSync(root)]);
		for (const target of [lexical, canonical]) {
			if (!allowed.some((root) => isPathWithinScope(target, root)))
				throw new Error("Proactive read is outside its path grant.");
			for (const denied of this.grant.deniedPaths) {
				for (const root of [resolve(this.cwd, denied), safeRealpathSync(denied)]) {
					if (subtree ? pathScopesOverlap(target, root) : isPathWithinScope(target, root))
						throw new Error("Proactive read intersects a private or denied path.");
				}
			}
		}
	}
}
