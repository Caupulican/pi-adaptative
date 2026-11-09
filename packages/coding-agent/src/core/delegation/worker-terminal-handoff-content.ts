/** Renders the terminal handoff a parent reads when a worker's lane ends: the fenced claim, the host verdict, the advice and the next step, as one durable mailbox text. */

import { createHash } from "node:crypto";
import type { WorkerHostVerdict } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { renderCommsStateLine } from "../comms/comms-records.ts";
import type { ArtifactContract } from "../orchestration/contracts.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import {
	fenceWorkerClaimValues,
	handoffClaimLine,
	handoffClaimValue,
	handoffReasonCode,
	workerClaimSettlementLines,
} from "./worker-claim.ts";
import {
	describeWorkerDisposition,
	describeWorkerHostVerdict,
	WORKER_DISPOSITION_ADVICE_NOTE,
	type WorkerDispositionAdvice,
	workerDispositionGuidance,
	workerLaneStateCodes,
} from "./worker-disposition.ts";

export function buildWorkerTerminalHandoffContent(args: {
	childAgentId: string;
	record: Pick<LaneRecord, "laneId" | "status" | "reasonCode" | "reasonDetail">;
	outputArtifact?: ArtifactContract;
	claim?: {
		summary?: string;
		status?: string;
		changedFiles?: readonly string[];
		blockers?: readonly string[];
		inconclusive?: readonly string[];
		systemOneSettled?: readonly string[];
		ownerFollowUp?: string;
		parentReviewRequired?: boolean;
	};
	/** The host's judgment of the claim against the receipts; absent on a legacy claim. */
	hostVerdict?: WorkerHostVerdict;
	/** Advice for the receiving agent; the root decides. */
	recommendedDisposition?: WorkerDispositionAdvice;
}): string {
	// This content is stored and replayed against a durable mailbox record, so the fence nonce is fixed per
	// child and lane rather than random. A literal nonce inside worker text is still neutralized.
	const source = `worker-claim:${args.record.laneId}`;
	const nonce = createHash("sha256")
		.update(`worker-terminal-handoff\0${args.childAgentId}\0${args.record.laneId}`)
		.digest("hex")
		.slice(0, 32);
	const fence = (values: readonly string[], path = false): string =>
		fenceWorkerClaimValues(values, handoffClaimValue, source, nonce, path);
	const laneCodes = workerLaneStateCodes(args.record, {
		...(args.hostVerdict ? { hostVerdict: args.hostVerdict } : {}),
		...(args.claim?.parentReviewRequired ? { parentReviewRequired: true } : {}),
	});
	const readsWholeTranscript = laneCodes.includes("READ_ALL");
	const stateLine = renderCommsStateLine(["DELIVERED", ...laneCodes]);
	return [
		"Worker terminal handoff",
		`childAgentId=${args.childAgentId}`,
		`laneId=${args.record.laneId}`,
		`status=${args.record.status}`,
		...(args.record.reasonCode ? [`reasonCode=${handoffReasonCode(args.record.reasonCode)}`] : []),
		...(args.record.reasonDetail
			? [`diagnostic (untrusted):\n${wrapUntrustedText(args.record.reasonDetail, source, { nonce })}`]
			: []),
		...(args.outputArtifact
			? [
					`fullOutput=${args.outputArtifact.uri}${args.outputArtifact.sizeBytes === undefined ? "" : ` (${args.outputArtifact.sizeBytes} bytes)`}`,
				]
			: []),
		...(args.claim?.summary ? [`claimStatus=${args.claim.status || args.record.status}`] : []),
		...(args.claim?.summary
			? [
					`claimSummary (untrusted worker evidence):\n${fenceWorkerClaimValues([args.claim.summary], handoffClaimLine, source, nonce)}`,
				]
			: []),
		...(args.claim?.changedFiles && args.claim.changedFiles.length > 0
			? [`changedFiles (untrusted worker evidence):\n${fence(args.claim.changedFiles, true)}`]
			: []),
		...(args.claim?.blockers && args.claim.blockers.length > 0
			? [`blockers (untrusted worker evidence):\n${fence(args.claim.blockers)}`]
			: []),
		...(args.claim ? workerClaimSettlementLines(args.claim, handoffClaimValue, source, nonce) : []),
		...(args.hostVerdict ? [describeWorkerHostVerdict(args.hostVerdict)] : []),
		...(args.recommendedDisposition
			? [
					describeWorkerDisposition(args.recommendedDisposition),
					`${WORKER_DISPOSITION_ADVICE_NOTE} Next step: ${workerDispositionGuidance(args.recommendedDisposition, args.hostVerdict)}.`,
				]
			: []),
		...(stateLine ? [stateLine] : []),
		...(readsWholeTranscript
			? [
					`Start with delegate action="transcript" agentId="${args.childAgentId}" cursor=0.`,
					"Entries complete only after pagination ends. omittedMessages means whole entries were left out of that page. While nextCursor exists, call transcript again with cursor=nextCursor. Stop only when nextCursor is absent.",
				]
			: []),
		...(args.record.reasonCode === "worker_blocked"
			? [
					`The worker is idle and waiting on you: answer its blocker or redirect it with delegate action="follow_up" agentId="${args.childAgentId}"; it keeps its transcript. list marks it awaitingParent until a newer task starts.`,
				]
			: []),
		...(args.record.reasonCode === "worker_interrupted"
			? [
					"worker_interrupted means you stopped this worker and the claim above is its own report. Its state and transcript are retained: continue it with delegate follow_up on the same agentId, or retire it.",
				]
			: []),
	].join("\n");
}
