import type { Api, ImageContent, Model, ToolResultMessage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../kernel/index.ts";
import type { SessionManager } from "../kernel/node.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import { clarificationAnsweredEvent, type GoalClarificationEvent } from "./goals/goal-clarification-log.ts";
import {
	DEFAULT_OWNER_WAIT_TIMEOUT_MS,
	formatHumanInputAnswerText,
	getResumableHumanInputEntry,
	type HumanInputSnapshot,
	OWNER_UNAVAILABLE_REASON,
	resolveHumanInput,
	restoreHumanInputImages,
	unansweredOwnerQuestionText,
} from "./human-input.ts";
import { type HumanInputRequest, humanInputToolName } from "./human-input-request.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { isSessionAppendAnchorCurrent, type SessionAppendAnchor } from "./session-snapshot.ts";

interface HumanInputControllerDeps {
	getSessionManager(): SessionManager;
	getUIContext(): ExtensionUIContext | undefined;
	isHandoff?(): boolean;
	isDisposed(): boolean;
	isStreaming(): boolean;
	getModel(): Model<Api> | undefined;
	getArtifactStore(): ArtifactStore;
	getImageStore(): SessionImageStore | undefined;
	runAgentPrompt(messages: AgentMessage | AgentMessage[], signal: AbortSignal): Promise<void>;
	/** Durable objective-side clarification writer, for a question that outlived its own process. */
	recordObjectiveClarification?(objectiveId: string, event: GoalClarificationEvent): void;
	recordOwnerFollowUp?(request: HumanInputRequest, reason: string): string | undefined;
}

interface HumanInputReplay {
	readonly sessionManager: SessionManager;
	readonly anchor: SessionAppendAnchor;
	readonly cancellation: AbortController;
	readonly completion: Promise<boolean>;
	readonly preparation: Promise<void>;
	readonly finishPreparation: () => void;
	snapshotEntryId: string;
	invalidated: boolean;
	foregroundStarted: boolean;
}

class StaleHumanInputReplayError extends Error {}

/** Owns durable ask_question replay after a restart or idle resume.
 * Worker review stays on the edge: parent wake is the terminal handoff, not an owner question latch. */
export class HumanInputController {
	private readonly deps: HumanInputControllerDeps;
	private replay: HumanInputReplay | undefined;

	constructor(deps: HumanInputControllerDeps) {
		this.deps = deps;
	}

	resumePending(): Promise<boolean> {
		if (this.replay) return this.replay.foregroundStarted ? Promise.resolve(false) : this.replay.completion;
		if (this.deps.isDisposed() || this.deps.isStreaming()) return Promise.resolve(false);
		const sessionManager = this.deps.getSessionManager();
		const pending = getResumableHumanInputEntry(sessionManager);
		if (!pending) return Promise.resolve(false);
		const completion = Promise.withResolvers<boolean>();
		const preparation = Promise.withResolvers<void>();
		const replay: HumanInputReplay = {
			sessionManager,
			anchor: { sessionId: sessionManager.getSessionId(), leafId: sessionManager.getLeafId() },
			cancellation: new AbortController(),
			completion: completion.promise,
			preparation: preparation.promise,
			finishPreparation: preparation.resolve,
			snapshotEntryId: pending.entryId,
			invalidated: false,
			foregroundStarted: false,
		};
		// Install before UI or activity callbacks can reenter resume/abort/dispose.
		this.replay = replay;
		void this.runReplay(replay, pending.snapshot).then(
			(result) => {
				if (this.replay === replay) this.replay = undefined;
				completion.resolve(result);
			},
			(error: unknown) => {
				if (this.replay === replay) this.replay = undefined;
				completion.reject(error);
			},
		);
		return completion.promise;
	}

	/** Owner interruption may checkpoint cancellation, but cannot start another model turn. */
	interrupt(reason: string): void {
		this.replay?.cancellation.abort(reason);
	}

	/** Context loss forbids writes. Join only preparation; an admitted run has its own shutdown owner. */
	invalidate(reason: string): Promise<void> {
		const replay = this.replay;
		if (!replay) return Promise.resolve();
		replay.invalidated = true;
		replay.cancellation.abort(reason);
		return replay.preparation;
	}

	private isCurrent(replay: HumanInputReplay): boolean {
		return (
			this.replay === replay &&
			!replay.invalidated &&
			!this.deps.isDisposed() &&
			this.deps.getSessionManager() === replay.sessionManager &&
			isSessionAppendAnchorCurrent(replay.sessionManager, replay.anchor) &&
			getResumableHumanInputEntry(replay.sessionManager)?.entryId === replay.snapshotEntryId
		);
	}

	private assertCurrent(replay: HumanInputReplay): void {
		if (!this.isCurrent(replay))
			throw new StaleHumanInputReplayError("Human-input replay no longer owns its request");
	}

	private async runReplay(replay: HumanInputReplay, pending: HumanInputSnapshot): Promise<boolean> {
		try {
			return await this.resumeRequest(replay, pending);
		} catch (error) {
			if (error instanceof StaleHumanInputReplayError || replay.cancellation.signal.aborted) return false;
			throw error;
		} finally {
			replay.finishPreparation();
		}
	}

	private async resumeRequest(replay: HumanInputReplay, pending: HumanInputSnapshot): Promise<boolean> {
		this.assertCurrent(replay);
		const sessionManager = replay.sessionManager;
		const ui = this.deps.getUIContext();
		let resumed = false;

		if (pending?.request.toolCallId) {
			let snapshot = pending;
			let imageContents: readonly ImageContent[] = [];
			if (pending.status === "pending") {
				const elapsed = Date.now() - Date.parse(pending.request.createdAt);
				const timeoutMs =
					ui && !this.deps.isHandoff?.()
						? Math.max(0, DEFAULT_OWNER_WAIT_TIMEOUT_MS - (Number.isFinite(elapsed) ? elapsed : 0))
						: 0;
				const resolved = await resolveHumanInput({
					sessionManager,
					request: {
						...pending.request,
						acceptsImages: this.deps.getModel()?.input.includes("image") ?? false,
					},
					present: (request, options) =>
						ui
							? ui.askQuestions(request, options)
							: Promise.resolve({ answers: [], cancelled: true, reason: "ui_unavailable", imageContents: [] }),
					artifactStore: this.deps.getArtifactStore(),
					getImageStore: () => this.deps.getImageStore(),
					signal: replay.cancellation.signal,
					assertCurrent: () => this.assertCurrent(replay),
					timeoutMs,
				});
				replay.snapshotEntryId = resolved.snapshotEntryId;
				snapshot = resolved.snapshot;
				imageContents = resolved.imageContents;
			} else if (pending.status === "answered") {
				imageContents = restoreHumanInputImages(snapshot, this.deps.getImageStore());
			}
			this.assertCurrent(replay);
			if (replay.cancellation.signal.aborted) return false;

			// The objective that asked this question may be several process lifetimes away; its ledger
			// is settled here, from the same snapshot the tool result is built from.
			const objectiveId = snapshot.request.objectiveId;
			if (objectiveId && snapshot.status !== "pending") {
				this.deps.recordObjectiveClarification?.(
					objectiveId,
					clarificationAnsweredEvent({
						requestId: snapshot.request.requestId,
						answerText: formatHumanInputAnswerText(snapshot),
						cancelled: snapshot.status === "cancelled",
						now: snapshot.updatedAt,
					}),
				);
			}

			const answerImageCount = snapshot.answers.reduce((total, answer) => total + (answer.images?.length ?? 0), 0);
			const modelAcceptsImages = this.deps.getModel()?.input.includes("image") ?? false;
			const missingImageNotice =
				answerImageCount > imageContents.length
					? `\n\n[${answerImageCount - imageContents.length} attached image(s) could not be restored from durable storage.]`
					: "";
			const unsupportedImageNotice =
				imageContents.length > 0 && !modelAcceptsImages
					? "\n\n[Attached images were retained but not sent because the selected model does not accept image input.]"
					: "";
			this.assertCurrent(replay);
			if (replay.cancellation.signal.aborted) return false;
			const ownerFollowUp =
				snapshot.status === "pending"
					? this.deps.recordOwnerFollowUp?.(
							snapshot.request,
							this.deps.isHandoff?.()
								? "Owner question deferred under full handoff; no decision was granted."
								: OWNER_UNAVAILABLE_REASON,
						)
					: undefined;
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: pending.request.toolCallId,
				toolName: humanInputToolName(pending.request.toolName),
				content: [
					{
						type: "text",
						text: `${snapshot.status === "pending" ? unansweredOwnerQuestionText(ownerFollowUp) : formatHumanInputAnswerText(snapshot)}${missingImageNotice}${unsupportedImageNotice}`,
					},
					...(modelAcceptsImages ? imageContents : []),
				],
				details: {
					questions: snapshot.request.questions,
					answers: snapshot.answers,
					cancelled: snapshot.status === "cancelled",
					...(snapshot.status === "pending" ? { reason: "owner_unavailable" } : {}),
					...(snapshot.reason ? { reason: snapshot.reason } : {}),
				},
				isError: false,
				timestamp: Date.now(),
			};
			this.assertCurrent(replay);
			if (replay.cancellation.signal.aborted) return false;
			replay.foregroundStarted = true;
			const run = this.deps.runAgentPrompt(toolResult, replay.cancellation.signal);
			replay.finishPreparation();
			await run;
			resumed = true;
		}

		return resumed;
	}
}
