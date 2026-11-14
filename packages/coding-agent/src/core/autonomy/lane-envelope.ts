/**
 * The capability envelope a profile's authority runs under: the capabilities and tools its plan was granted, its denied
 * paths and write roots when the envelope itself holds them, and its cost bound. A worker lane's run carries it
 * (from its execution grant and tool surface), and so does a session that runs a bot made from a profile (from the
 * contract's authority), held there by the session's tool gate as its ceiling.
 */
import type { HarnessCapability } from "../capability-contract.ts";
import type { CapabilityEnvelope } from "./contracts.ts";

export function laneCapabilityEnvelope(args: {
	readonly id: string;
	readonly profileId: string;
	readonly capabilities: readonly HarnessCapability[];
	readonly allowedTools: readonly string[];
	readonly deniedTools?: readonly string[];
	/**
	 * The roots its writes stay in when this envelope scopes them. `filesystem.write` needs both the grant and a non-empty
	 * scope: an unscoped write grant is refused here, not discovered at validation time. Unset when another envelope scopes
	 * the writes (a session's write-scope envelope, which leaves its reads to its read scope).
	 */
	readonly writePaths?: readonly string[];
	/** Unset when another envelope denies them (a session's private-path envelope, with its own readable exemptions). */
	readonly deniedPaths?: readonly string[];
	readonly maxUsd?: number;
	/** When a run was issued it; a session's ceiling, part of what defines the session, carries none. */
	readonly createdAt?: string;
}): CapabilityEnvelope {
	return {
		id: args.id,
		profileId: args.profileId,
		capabilities: [...args.capabilities],
		...(args.writePaths ? { allowedPaths: [...args.writePaths] } : {}),
		...(args.deniedPaths ? { deniedPaths: [...args.deniedPaths] } : {}),
		allowedTools: [...args.allowedTools],
		...(args.deniedTools ? { deniedTools: [...args.deniedTools] } : {}),
		...(args.maxUsd !== undefined ? { maxEstimatedUsd: args.maxUsd } : {}),
		...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
	};
}
