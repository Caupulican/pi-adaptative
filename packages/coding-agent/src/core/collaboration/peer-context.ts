import { isAbsolute } from "node:path";
import { CollaborationJobStore } from "./job-store.ts";
import type { CollaborationQuestionReceipt } from "./result-claim.ts";

export type { CollaborationQuestionReceipt } from "./result-claim.ts";

/** One bootstrap owner for finite CLI commands and native input observation. Credentials stay closed over. */
export function createCollaborationPeerContext(env: NodeJS.ProcessEnv = process.env) {
	const directory = env.PI_COLLABORATION_STATE_DIR;
	const parent = env.PI_COLLABORATION_PARENT_ID;
	const jobId = env.PI_COLLABORATION_JOB_ID;
	const senderId = env.PI_COLLABORATION_AGENT_ID;
	const token = env.PI_COLLABORATION_PEER_TOKEN;
	const fields = [directory, parent, jobId, senderId, token];
	if (fields.every((field) => field === undefined)) return undefined;
	if (
		!directory ||
		!isAbsolute(directory) ||
		!parent ||
		!jobId ||
		!senderId ||
		!token ||
		fields.some((field) => !field || field.length > 4096 || field.includes("\0"))
	)
		throw new Error("Missing or invalid collaboration peer launch context.");
	const store = new CollaborationJobStore(directory, parent);
	return {
		current: () => store.currentPeerTurn(jobId, senderId, token),
		send: (recipientId: string, messageId: string, text: string) =>
			store.enqueuePeerMessage(jobId, { senderId, token, recipientId, messageId, text }),
		report: (claim: unknown) => store.reportTurn(jobId, { senderId, token, claim }),
		waiting: (requestId: string, evidence: string) =>
			store.beginPeerQuestion(jobId, { senderId, token, requestId, evidence }),
		settled: (receipt: CollaborationQuestionReceipt) => store.clearPeerQuestion(jobId, { senderId, token, receipt }),
	};
}
