import type { Candidate, FinishReason } from "@google/genai";
import type { GoogleGenAiResponse } from "./google-streaming.ts";
import { type GoogleUsageMetadata, mergeGoogleUsage } from "./google-usage.ts";

type AntigravityCandidate = Omit<Candidate, "finishReason"> & {
	finishReason?: string;
	continuationToken?: string;
};

export interface AntigravityStreamEvent {
	candidates?: AntigravityCandidate[];
	usageMetadata?: unknown;
	usageCredits?: GoogleGenAiResponse["usageCredits"];
	responseId?: string;
}

const MAX_CONTINUATIONS = 32;
const MAX_CHECKPOINT_RETRIES = 3;

/** Owns checkpoints and cumulative usage for one native CCPA generation. */
export class AntigravityContinuationState {
	private readonly outputLimit: number | undefined;
	private readonly maxCheckpointRetries: number;
	private checkpoint: string | undefined;
	private continuationCount = 0;
	private checkpointRetries = 0;
	private priorThoughts = 0;
	private priorAnswers = 0;
	private initialUsage: GoogleUsageMetadata | undefined;
	private legUsage: GoogleUsageMetadata | undefined;
	private lastUsage: GoogleUsageMetadata | undefined;
	private lastResponseId: string | undefined;
	private hasCheckpoint = false;
	private checkpointThoughts = 0;
	private checkpointAnswers = 0;
	private sawCandidate = false;
	private unsafeOutput = false;
	private lastFinish: string | undefined;
	private suppressedFinish = false;
	private forwardedTerminal = false;
	private lastRetryError: unknown;

	constructor(outputLimit: number | undefined, maxRetries?: number) {
		if (maxRetries !== undefined && !Number.isFinite(maxRetries)) throw new Error("Invalid Antigravity retry count");
		this.outputLimit = outputLimit;
		this.maxCheckpointRetries = Math.min(
			MAX_CHECKPOINT_RETRIES,
			Math.max(0, Math.floor(maxRetries ?? MAX_CHECKPOINT_RETRIES)),
		);
	}

	get continuationToken(): string {
		if (!this.checkpoint) throw new Error("Antigravity continuation has no checkpoint");
		return this.checkpoint;
	}

	get retryCount(): number {
		return this.checkpointRetries;
	}

	record(event: AntigravityStreamEvent): GoogleGenAiResponse {
		const candidate = event.candidates?.[0];
		if (candidate) {
			this.sawCandidate = true;
			this.lastRetryError = undefined;
			const hasOutput = candidate.content?.parts?.some(
				(part) =>
					(part.text?.length ?? 0) > 0 ||
					part.functionCall !== undefined ||
					part.functionResponse !== undefined ||
					part.inlineData !== undefined ||
					part.fileData !== undefined ||
					part.executableCode !== undefined ||
					part.codeExecutionResult !== undefined ||
					part.toolCall !== undefined ||
					part.toolResponse !== undefined ||
					part.audioTranscription !== undefined,
			);
			const finish = candidate.finishReason;
			if (hasOutput && (!finish || finish === "FINISH_REASON_UNSPECIFIED")) this.suppressedFinish = false;
			if (candidate.continuationToken) {
				if (this.checkpoint !== candidate.continuationToken) this.checkpointRetries = 0;
				this.checkpoint = candidate.continuationToken;
				this.hasCheckpoint = true;
				this.unsafeOutput = false;
			} else if (hasOutput) {
				this.unsafeOutput = true;
			}
			if (finish && finish !== "FINISH_REASON_UNSPECIFIED") {
				this.lastFinish = finish;
				this.suppressedFinish = this.canContinue();
			}
		}
		let usageMetadata: GoogleUsageMetadata | undefined;
		if (event.usageMetadata !== undefined) {
			const snapshot = mergeGoogleUsage(this.legUsage, event.usageMetadata);
			if (this.sawCandidate) {
				this.legUsage = snapshot;
				if (this.continuationCount === 0) this.initialUsage = snapshot;
				this.lastUsage = this.projectUsage(snapshot);
				usageMetadata = this.lastUsage;
			} else if (this.continuationCount === 0) {
				usageMetadata = snapshot;
			} else if (this.lastUsage) {
				// A resumed leg's pre-candidate usage repeats the already accounted prefix.
				usageMetadata = this.projectUsage(snapshot, this.lastUsage);
			}
			// Usage arriving with the terminal candidate participates in its output bound.
			if (candidate?.finishReason) this.suppressedFinish = this.canContinue();
		}
		if (this.hasCheckpoint && !this.unsafeOutput) {
			this.checkpointThoughts = this.legUsage?.thoughtsTokenCount ?? 0;
			this.checkpointAnswers = this.legUsage?.candidatesTokenCount ?? 0;
		}
		let candidates: GoogleGenAiResponse["candidates"];
		if (event.candidates) {
			candidates = event.candidates.map((entry, index) => {
				const { continuationToken: _token, ...projected } = entry;
				if (index === 0 && this.suppressedFinish && this.isContinuableFinish(entry.finishReason)) {
					delete projected.finishReason;
					delete projected.finishMessage;
				} else if (entry.finishReason === "CONTINUATION") {
					projected.finishReason = "MAX_TOKENS";
				}
				if (index === 0 && projected.finishReason && projected.finishReason !== "FINISH_REASON_UNSPECIFIED") {
					this.forwardedTerminal = true;
				}
				return projected as Candidate;
			});
		}
		this.lastResponseId = event.responseId ?? this.lastResponseId;
		return {
			candidates,
			...(usageMetadata !== undefined
				? {
						usageMetadata,
						...(this.sawCandidate || this.continuationCount > 0 ? { usageMetadataMode: "replace" as const } : {}),
					}
				: {}),
			...(event.usageCredits !== undefined ? { usageCredits: event.usageCredits } : {}),
			responseId: event.responseId,
		};
	}

	/** Normal EOF only advances a resumable finish with a checkpoint in this leg. */
	finishLeg(): "continue" | "complete" | GoogleGenAiResponse {
		if (this.canContinue()) {
			this.commitLeg(false);
			return "continue";
		}
		if (this.suppressedFinish) return this.maxTokensResponse();
		if (this.forwardedTerminal) return "complete";
		if (this.lastRetryError !== undefined) throw this.lastRetryError;
		throw new Error("Antigravity stream ended without a terminal response");
	}

	/** Admission is separate from the adapter's existing provider-error classification. */
	resumeAfterError(error: unknown, dialFailure: boolean): boolean {
		if (
			!this.checkpoint ||
			this.unsafeOutput ||
			(this.lastFinish !== undefined && !this.suppressedFinish) ||
			this.continuationCount >= MAX_CONTINUATIONS ||
			this.checkpointRetries >= this.maxCheckpointRetries ||
			!this.hasOutputAllowance()
		)
			return false;
		this.checkpointRetries++;
		if (!dialFailure) this.commitLeg(true);
		this.lastRetryError = error;
		return true;
	}

	finishBudgetError(): GoogleGenAiResponse | undefined {
		if (this.continuationCount > 0 && !this.unsafeOutput) return this.maxTokensResponse();
		return undefined;
	}

	private isContinuableFinish(finish: string | undefined): boolean {
		return finish === "CONTINUATION" || finish === "MAX_TOKENS";
	}

	private canContinue(): boolean {
		return (
			this.isContinuableFinish(this.lastFinish) &&
			this.hasCheckpoint &&
			!this.unsafeOutput &&
			this.checkpoint !== undefined &&
			this.continuationCount < MAX_CONTINUATIONS &&
			this.hasOutputAllowance()
		);
	}

	private hasOutputAllowance(): boolean {
		const output =
			this.priorThoughts +
			this.priorAnswers +
			(this.legUsage?.thoughtsTokenCount ?? 0) +
			(this.legUsage?.candidatesTokenCount ?? 0);
		return !this.outputLimit || this.outputLimit <= 0 || output < this.outputLimit;
	}

	private commitLeg(checkpointOnly: boolean): void {
		this.priorThoughts += checkpointOnly ? this.checkpointThoughts : (this.legUsage?.thoughtsTokenCount ?? 0);
		this.priorAnswers += checkpointOnly ? this.checkpointAnswers : (this.legUsage?.candidatesTokenCount ?? 0);
		this.continuationCount++;
		this.legUsage = undefined;
		this.hasCheckpoint = false;
		this.checkpointThoughts = 0;
		this.checkpointAnswers = 0;
		this.sawCandidate = false;
		this.lastFinish = undefined;
		this.suppressedFinish = false;
		this.forwardedTerminal = false;
	}

	private projectUsage(current: GoogleUsageMetadata, prefix?: GoogleUsageMetadata): GoogleUsageMetadata {
		const initial = prefix ?? this.initialUsage ?? current;
		const promptTokenCount = initial.promptTokenCount ?? 0;
		const cachedContentTokenCount = initial.cachedContentTokenCount ?? 0;
		const thoughtsTokenCount = prefix?.thoughtsTokenCount ?? this.priorThoughts + (current.thoughtsTokenCount ?? 0);
		const candidatesTokenCount =
			prefix?.candidatesTokenCount ?? this.priorAnswers + (current.candidatesTokenCount ?? 0);
		// Native CCPA rewrites these five totals and retains the other fields as leg snapshots.
		return mergeGoogleUsage(undefined, {
			...current,
			promptTokenCount,
			cachedContentTokenCount,
			thoughtsTokenCount,
			candidatesTokenCount,
			totalTokenCount: promptTokenCount + thoughtsTokenCount + candidatesTokenCount,
			promptTokensDetails: initial.promptTokensDetails,
			cacheTokensDetails: initial.cacheTokensDetails,
			toolUsePromptTokensDetails: initial.toolUsePromptTokensDetails,
		});
	}

	private maxTokensResponse(): GoogleGenAiResponse {
		return {
			candidates: [{ finishReason: "MAX_TOKENS" as FinishReason }],
			usageMetadata: this.lastUsage,
			usageMetadataMode: "replace",
			responseId: this.lastResponseId,
		};
	}
}
