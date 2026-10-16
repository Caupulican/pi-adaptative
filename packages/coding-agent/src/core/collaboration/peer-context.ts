import { watch } from "node:fs";
import { basename } from "node:path";
import { canonicalizeWatchDir } from "../../utils/fs-watch.ts";
import type { ProcessParentOwnershipSource } from "../process-matrix/runtime.ts";
import type { CollaborationWorkerRefusal } from "./job-record.ts";
import { CollaborationJobStore } from "./job-store.ts";
import { hasPeerCredentialDirectory, readPeerCredentialFile } from "./peer-credential-store.ts";
import type { CollaborationQuestionReceipt } from "./result-claim.ts";
import { collaborationStateDirectory } from "./state-directory.ts";

export type { CollaborationQuestionReceipt } from "./result-claim.ts";

/**
 * One member's address. The state root is resolved by the process that uses it; the credential is read from its file
 * and is carried here only for a team admitted before the credential contract (`legacyToken`), whose members still
 * hold the token in their launch environment. That token is honored only while the team has no credential directory,
 * so it cannot authenticate a team admitted under the contract.
 */
export interface CollaborationPeerAddress {
	stateDirectory: string;
	parentSessionId: string;
	jobId: string;
	senderId: string;
	legacyToken?: string;
}

/** The environment of a pre-contract member: the state root and token were both set, with the identifiers. */
const LEGACY_TOKEN_ENV = "PI_COLLABORATION_PEER_TOKEN";
const LEGACY_STATE_DIR_ENV = "PI_COLLABORATION_STATE_DIR";

/**
 * An in-process Pi member's address, from the identifiers its pane was started with. Absent when none were given;
 * partial identifiers are an error. The pre-contract environment is read only when its token is present.
 */
export function collaborationPeerAddressFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): CollaborationPeerAddress | undefined {
	const parentSessionId = env.PI_COLLABORATION_PARENT_ID;
	const jobId = env.PI_COLLABORATION_JOB_ID;
	const senderId = env.PI_COLLABORATION_AGENT_ID;
	const legacyToken = env[LEGACY_TOKEN_ENV];
	const legacyStateDirectory = env[LEGACY_STATE_DIR_ENV];
	const fields = [parentSessionId, jobId, senderId];
	if (fields.every((field) => field === undefined) && legacyToken === undefined) return undefined;
	if (!parentSessionId || !jobId || !senderId)
		throw new Error("Missing or invalid collaboration peer launch context.");
	if (legacyToken !== undefined) {
		if (!legacyStateDirectory) throw new Error("Missing or invalid collaboration peer launch context.");
		return {
			stateDirectory: legacyStateDirectory,
			parentSessionId,
			jobId,
			senderId,
			legacyToken,
		};
	}
	return { stateDirectory: collaborationStateDirectory(), parentSessionId, jobId, senderId };
}

/** The in-process member's context. Absent outside a collaboration member. */
export function createCollaborationPeerContext(env: NodeJS.ProcessEnv = process.env) {
	const address = collaborationPeerAddressFromEnv(env);
	return address ? createCollaborationPeerAuthority(address) : undefined;
}

/** The credential for one operation: the member's file, or the pre-contract token while its team has no directory. */
function memberCredential(address: CollaborationPeerAddress): string {
	const { stateDirectory, jobId, senderId, legacyToken } = address;
	if (legacyToken !== undefined && !hasPeerCredentialDirectory(stateDirectory, jobId)) return legacyToken;
	return readPeerCredentialFile(stateDirectory, jobId, senderId);
}

/** One bootstrap owner for finite CLI commands and native input observation. Credentials are read per use. */
export function createCollaborationPeerAuthority(address: CollaborationPeerAddress) {
	const { stateDirectory, parentSessionId, jobId, senderId } = address;
	const fields = [stateDirectory, parentSessionId, jobId, senderId];
	if (fields.some((field) => field.length > 4096 || field.includes("\0")))
		throw new Error("Invalid collaboration peer address.");
	const store = new CollaborationJobStore(stateDirectory, parentSessionId);
	// Read at each use, never cached: a member's credential file is removed when the member closes, and no copy of
	// the credential outlives that file in this process.
	const token = () => memberCredential(address);
	const parentOwnership: ProcessParentOwnershipSource = {
		read: () => store.getPeerParentOwnership(jobId, senderId, token()),
		subscribe: (changed, onError) => {
			const file = basename(store.path(jobId));
			const watcher = watch(canonicalizeWatchDir(stateDirectory), { persistent: false }, (_event, name) => {
				if (name === null || name.toString() === file) changed();
			});
			watcher.on("error", (error) => {
				watcher.close();
				onError(error);
			});
			return () => watcher.close();
		},
	};
	return {
		parentOwnership,
		current: () => store.currentPeerTurn(jobId, senderId, token()),
		send: (recipientId: string, messageId: string, text: string) =>
			store.enqueuePeerMessage(jobId, { senderId, token: token(), recipientId, messageId, text }),
		report: (claim: unknown) => store.reportTurn(jobId, { senderId, token: token(), claim }),
		refuse: (refusal: CollaborationWorkerRefusal) =>
			store.recordPeerRefusal(jobId, { senderId, token: token(), refusal }),
		notice: (notice: string) => store.recordPeerNotice(jobId, { senderId, token: token(), notice }),
		waiting: (requestId: string, evidence: string) =>
			store.beginPeerQuestion(jobId, { senderId, token: token(), requestId, evidence }),
		settled: (receipt: CollaborationQuestionReceipt) =>
			store.clearPeerQuestion(jobId, { senderId, token: token(), receipt }),
	};
}
