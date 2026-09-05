import { decodeCollaborationUsageClaim } from "../core/collaboration/launch-profile.ts";
import { createCollaborationPeerContext } from "../core/collaboration/peer-context.ts";
import type { CollaborationPeerReceipt } from "../core/collaboration/peer-protocol.ts";
import type { CollaborationResultClaim } from "../core/collaboration/result-claim.ts";

/** Finite mailbox submission only; no model, backend process, output peek, or prompt replay. */
export function runCollaborationPeer(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): CollaborationPeerReceipt | CollaborationResultClaim | { turnId: string } {
	if (
		!(args[0] === "send" && args.length === 4) &&
		!(args[0] === "report" && [4, 5].includes(args.length)) &&
		!(args[0] === "current" && args.length === 1)
	)
		throw new Error(
			"Usage: --collaboration-peer send <recipientId> <messageId> <text> | current | report <turnId> <done|blocked> <evidence> [usage-json]",
		);
	if (args.some((arg) => arg.length > 16384 || arg.includes("\0")))
		throw new Error("Invalid collaboration peer arguments.");
	const context = createCollaborationPeerContext(env);
	if (!context) throw new Error("Missing collaboration peer launch context.");
	if (args[0] === "current") return context.current();
	if (args[0] === "report") {
		const usage = args[4] === undefined ? undefined : decodeCollaborationUsageClaim(JSON.parse(args[4]));
		return context.report({ turnId: args[1], status: args[2], evidence: args[3], ...(usage ? { usage } : {}) });
	}
	return context.send(args[1], args[2], args[3]);
}
