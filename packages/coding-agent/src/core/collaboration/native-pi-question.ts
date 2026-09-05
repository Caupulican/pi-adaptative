import { MAX_MANAGED_LANE_SUMMARY_BYTES } from "../extensions/types.ts";
import type { HumanInputRequest } from "../human-input.ts";
import { boundCollaborationEvidence } from "./job-store.ts";
import { type CollaborationQuestionReceipt, createCollaborationPeerContext } from "./peer-context.ts";

const MAX_PENDING_NATIVE_QUESTIONS = 32;

export interface NativePiQuestionReporter {
	waiting(request: HumanInputRequest): void;
	settled(requestId: string): void;
}

/** Optional authenticated question transport. Failure cannot cancel or answer the native UI. */
export function createNativePiQuestionReporter(
	env: NodeJS.ProcessEnv,
	onError: ((error: Error) => void) | undefined,
	resolveContext: (
		env: NodeJS.ProcessEnv,
	) =>
		| Pick<NonNullable<ReturnType<typeof createCollaborationPeerContext>>, "waiting" | "settled">
		| undefined = createCollaborationPeerContext,
): NativePiQuestionReporter | undefined {
	let warned = false;
	const warn = () => {
		if (warned) return;
		warned = true;
		try {
			onError?.(
				new Error(
					"Full collaboration question transport is unavailable; the native question remains open. No answer was invented or replayed.",
				),
			);
		} catch {
			/* The transport observer never owns the native foreground. */
		}
	};
	let context: ReturnType<typeof resolveContext>;
	try {
		context = resolveContext(env);
	} catch {
		warn();
		return undefined;
	}
	if (!context) return undefined;
	const peer = context;
	const receipts = new Map<string, CollaborationQuestionReceipt>();
	return {
		waiting(request) {
			try {
				if (!receipts.has(request.requestId) && receipts.size >= MAX_PENDING_NATIVE_QUESTIONS) {
					warn();
					return;
				}
				const payload = JSON.stringify({
					requestId: request.requestId,
					acceptsImages: request.acceptsImages,
					questions: request.questions.map(({ id, header, question, multiSelect, options }) => ({
						id,
						header,
						question,
						multiSelect,
						options: options.map(({ label, description }) => ({ label, description })),
					})),
				});
				const evidence =
					Buffer.byteLength(payload) <= MAX_MANAGED_LANE_SUMMARY_BYTES
						? payload
						: boundCollaborationEvidence(
								`Question details exceed ${MAX_MANAGED_LANE_SUMMARY_BYTES} bytes; incomplete preview follows. Do not answer from incomplete choices; request a smaller question.\n${payload}`,
							);
				const receipt = peer.waiting(request.requestId, evidence);
				if (receipt) receipts.set(request.requestId, receipt);
			} catch {
				warn();
			}
		},
		settled(requestId) {
			const receipt = receipts.get(requestId);
			if (!receipt) return;
			// The native owner has settled it even if durable clearing fails; never retain a retry queue.
			receipts.delete(requestId);
			try {
				peer.settled(receipt);
			} catch {
				warn();
			}
		},
	};
}
