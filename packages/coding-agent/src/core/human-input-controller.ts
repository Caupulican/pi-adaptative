import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, ImageContent, Model, ToolResultMessage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import { formatHumanInputAnswerText, getResumableHumanInputSnapshot, resolveHumanInput } from "./human-input.ts";
import type { SessionImageStore } from "./session-image-store.ts";

interface HumanInputControllerDeps {
	getSessionManager(): SessionManager;
	getUIContext(): ExtensionUIContext | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	getModel(): Model<Api> | undefined;
	getArtifactStore(): ArtifactStore;
	getImageStore(): SessionImageStore | undefined;
	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
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
		if (!ui) return false;
		let resumed = false;

		if (pending?.request.toolCallId) {
			let snapshot = pending;
			let imageContents: readonly ImageContent[] = [];
			if (pending.status === "pending") {
				const resolved = await resolveHumanInput({
					sessionManager,
					request: {
						...pending.request,
						acceptsImages: this.deps.getModel()?.input.includes("image") ?? false,
					},
					present: (request, options) => ui.askQuestions(request, options),
					artifactStore: this.deps.getArtifactStore(),
					getImageStore: () => this.deps.getImageStore(),
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
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: pending.request.toolCallId,
				toolName: pending.request.toolName ?? "ask_question",
				content: [
					{
						type: "text",
						text: `${formatHumanInputAnswerText(snapshot)}${missingImageNotice}${unsupportedImageNotice}`,
					},
					...(modelAcceptsImages ? imageContents : []),
				],
				details: {
					questions: snapshot.request.questions,
					answers: snapshot.answers,
					cancelled: snapshot.status === "cancelled",
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
