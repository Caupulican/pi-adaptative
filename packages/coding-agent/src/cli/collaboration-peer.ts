import { isAbsolute } from "node:path";
import { decodeCollaborationUsageClaim } from "../core/collaboration/launch-profile.ts";
import {
	type CollaborationPeerAddress,
	collaborationPeerAddressFromEnv,
	createCollaborationPeerAuthority,
} from "../core/collaboration/peer-context.ts";
import type { CollaborationPeerReceipt } from "../core/collaboration/peer-protocol.ts";
import type { CollaborationResultClaim } from "../core/collaboration/result-claim.ts";
import { collaborationStateDirectory } from "../core/collaboration/state-directory.ts";

const USAGE =
	"Usage: --collaboration-peer [--agent-dir <absoluteDirectory>] <parentSessionId> <jobId> <agentId> send <recipientId> <messageId> <text> | current | report <turnId> <done|blocked> <evidence> [usage-json]";
/** The subcommand first: an invocation from a team admitted before the peer credential contract. */
const PRE_CONTRACT_SUBCOMMANDS = ["send", "current", "report"];

function commandShapeIsValid(command: readonly string[]): boolean {
	return (
		(command[0] === "send" && command.length === 4) ||
		(command[0] === "report" && [4, 5].includes(command.length)) ||
		(command[0] === "current" && command.length === 1)
	);
}

/**
 * Finite mailbox submission only; no model, backend process, output peek, or prompt replay. The state root is this
 * process's managed root unless the command names the agent directory it was launched with. The credential is read
 * from the member's credential file, never from arguments. Only a pre-contract invocation reads the launch
 * environment, and only for a team that has no credential directory.
 */
export function runCollaborationPeer(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): CollaborationPeerReceipt | CollaborationResultClaim | { turnId: string } {
	if (args.some((arg) => arg.length > 16384 || arg.includes("\0")))
		throw new Error("Invalid collaboration peer arguments.");
	if (PRE_CONTRACT_SUBCOMMANDS.includes(args[0] ?? "")) {
		const address = collaborationPeerAddressFromEnv(env);
		if (address?.legacyToken === undefined)
			throw new Error(
				"This command predates the peer credential contract and needs its team's launch environment; the team must be relaunched.",
			);
		return dispatch(address, args);
	}
	let rest = args;
	let agentDirectory: string | undefined;
	if (rest[0] === "--agent-dir") {
		agentDirectory = rest[1];
		if (!agentDirectory || !isAbsolute(agentDirectory)) throw new Error(USAGE);
		rest = rest.slice(2);
	}
	const [parentSessionId, jobId, senderId, ...command] = rest;
	if (!parentSessionId || !jobId || !senderId) throw new Error(USAGE);
	return dispatch(
		{
			stateDirectory: collaborationStateDirectory(agentDirectory),
			parentSessionId,
			jobId,
			senderId,
		},
		command,
	);
}

function dispatch(
	address: CollaborationPeerAddress,
	command: readonly string[],
): CollaborationPeerReceipt | CollaborationResultClaim | { turnId: string } {
	if (!commandShapeIsValid(command)) throw new Error(USAGE);
	const context = createCollaborationPeerAuthority(address);
	if (command[0] === "current") return context.current();
	if (command[0] === "report") {
		const usage = command[4] === undefined ? undefined : decodeCollaborationUsageClaim(JSON.parse(command[4]));
		return context.report({
			turnId: command[1],
			status: command[2],
			evidence: command[3],
			...(usage ? { usage } : {}),
		});
	}
	return context.send(command[1], command[2], command[3]);
}
