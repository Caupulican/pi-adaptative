import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, ImageContent, Model, ToolResultMessage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import { clarificationAnsweredEvent, type GoalClarificationEvent } from "./goals/goal-clarification-log.ts";
import {
	DEFAULT_OWNER_WAIT_TIMEOUT_MS,
	formatHumanInputAnswerText,
	getResumableHumanInputSnapshot,
	type HumanInputRequest,
	OWNER_UNAVAILABLE_REASON,
	resolveHumanInput,
	unansweredOwnerQuestionText,
} from "./human-input.ts";
import type { SessionImageStore } from "./session-image-store.ts";

interface HumanInputControllerDeps {
	getSessionManager(): SessionManager;
	getUIContext(): ExtensionUIContext | undefined;
	isHandoff?(): boolean;
	isDisposed(): boolean;
	isStreaming(): boolean;
	getModel(): Model<Api> | undefined;
	getArtifactStore(): ArtifactStore;
	getImageStore(): SessionImageStore | undefined;
	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
	/** Durable objective-side clarification writer, for a question that outlived its own process. */
	recordObjectiveClarification?(objectiveId: string, event: GoalClarificationEvent): void;
	recordOwnerFollowUp?(request: HumanInputRequest, reason: string): string | undefined;
}

/** Owns durable ask_question replay after a restart or idle resume.
 * Worker review stays on the edge: parent wake is the terminal handoff, not an owner question latch. */
export class HumanInputController {
	private readonly deps: HumanInputControllerDeps;

	constructor(deps: HumanInputControllerDeps) {
		this.deps = deps;
	}

	async resumePending(): Promise<boolean> {
		if (this.deps.isDisposed() || this.deps.isStreaming()) return false;
		const sessionManager = this.deps.getSessionManager();
		const pending = getResumableHumanInputSnapshot(sessionManager);
		const ui = this.deps.getUIContext();
		if (!pending) return false;
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
					timeoutMs,
				});
				snapshot = resolved.snapshot;
				imageContents = resolved.imageContents;
			} else if (pending.status === "answered") {
				const imageStore = this.deps.getImageStore();
				if (imageStore) {
					const referencedText = snapshot.answers
						.flatMap((answer) => [answer.custom ?? "", ...(answer.images?.map((image) => image.label) ?? [])])
						.join(" ");
					imageContents = imageStore.resolveReferences(referencedText);
				}
			}

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
				toolName: pending.request.toolName ?? "ask_question",
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
			await this.deps.runAgentPrompt(toolResult);
			resumed = true;
		}

		return resumed;
	}
}
