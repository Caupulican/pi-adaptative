import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, ImageContent, Model, ToolResultMessage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ExtensionContext, ExtensionUIContext } from "./extensions/index.ts";
import {
	beginHumanInputRequest,
	createHumanInputRequest,
	formatHumanInputAnswerText,
	getResumableHumanInputSnapshot,
	HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE,
	type HumanInputRequest,
	type HumanInputSnapshot,
	resolveHumanInput,
	WorkerHumanInputProjection,
} from "./human-input.ts";
import type { SessionImageStore } from "./session-image-store.ts";

export interface WorkerHumanInputRequest {
	workerRequestId: string;
	message: string;
	blockers: readonly string[];
}

interface HumanInputControllerDeps {
	getSessionManager(): SessionManager;
	getUIContext(): ExtensionUIContext | undefined;
	getExtensionMode(): ExtensionContext["mode"];
	waitForIdle(): Promise<void>;
	isDisposed(): boolean;
	isStreaming(): boolean;
	getModel(): Model<Api> | undefined;
	getArtifactStore(): ArtifactStore;
	getImageStore(): SessionImageStore | undefined;
	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options: { triggerTurn: boolean; deliverAs: "followUp" },
	): Promise<void>;
	emitWarning(message: string): void;
}

/** Owns durable question replay and serialized worker-to-owner question delivery. */
export class HumanInputController {
	private readonly deps: HumanInputControllerDeps;
	private tail: Promise<void> = Promise.resolve();
	private readonly activeRequestIds = new Set<string>();
	private indexedSessionManager: SessionManager | undefined;
	private indexedLeafId: string | null = null;
	private workerInputIndexInitialized = false;
	private readonly workerInputProjection = new WorkerHumanInputProjection();

	constructor(deps: HumanInputControllerDeps) {
		this.deps = deps;
	}

	queueWorkerInput(request: WorkerHumanInputRequest): void {
		const sessionManager = this.deps.getSessionManager();
		this.synchronizeWorkerInputIndex();
		if (this.workerInputProjection.hasKnownWorkerRequest(request.workerRequestId)) return;
		const blockerText = request.blockers
			.slice(0, 4)
			.map((blocker) => blocker.slice(0, 500))
			.join("; ");
		const question = createHumanInputRequest({
			source: "worker",
			workerRequestId: request.workerRequestId,
			questions: [
				{
					id: "worker_review",
					header: "Worker review",
					question: `${request.message.slice(0, 1_500)}${blockerText ? ` Blockers: ${blockerText}` : ""}`,
					options: [
						{
							label: "Review now",
							description: "Have the parent inspect the worker claim and evidence before reconciling it.",
						},
						{
							label: "Keep blocked",
							description: "Leave the worker result blocked and continue without accepting its output.",
						},
					],
				},
			],
			acceptsImages: false,
		});
		beginHumanInputRequest(sessionManager, question);
		this.synchronizeWorkerInputIndex();
		if (!this.deps.isStreaming()) this.scheduleWorkerInput(question);
	}

	schedulePendingWorkerInputs(): void {
		for (const snapshot of this.getWorkerInputsRequiringDelivery()) {
			this.scheduleWorkerInput(snapshot);
		}
	}

	/** True when every terminal lane already has a durable owner question scheduled for delivery. */
	workerInputsWillWakeParent(workerRequestIds: readonly string[]): boolean {
		if (
			workerRequestIds.length === 0 ||
			this.deps.getUIContext() === undefined ||
			this.deps.getExtensionMode() === "print"
		) {
			return false;
		}
		this.synchronizeWorkerInputIndex();
		return workerRequestIds.every((workerRequestId) => this.workerInputProjection.requiresDelivery(workerRequestId));
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

		for (const workerInput of this.getWorkerInputsRequiringDelivery()) {
			if (this.activeRequestIds.has(workerInput.request.requestId)) continue;
			this.activeRequestIds.add(workerInput.request.requestId);
			try {
				resumed = (await this.resolveWorkerInput(workerInput)) || resumed;
			} finally {
				this.activeRequestIds.delete(workerInput.request.requestId);
			}
		}
		return resumed;
	}

	private scheduleWorkerInput(input: HumanInputRequest | HumanInputSnapshot): void {
		const snapshot: HumanInputSnapshot =
			"status" in input ? input : { request: input, status: "pending", answers: [], updatedAt: input.createdAt };
		const requestId = snapshot.request.requestId;
		if (this.activeRequestIds.has(requestId)) return;
		this.activeRequestIds.add(requestId);
		this.tail = this.tail
			.then(async () => {
				await this.resolveWorkerInput(snapshot);
			})
			.catch((error: unknown) => {
				this.deps.emitWarning(
					`Worker owner-input request failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				this.activeRequestIds.delete(requestId);
			});
	}

	private getWorkerInputsRequiringDelivery(): HumanInputSnapshot[] {
		this.synchronizeWorkerInputIndex();
		return this.workerInputProjection.getRequiringDelivery();
	}

	private synchronizeWorkerInputIndex(): void {
		const sessionManager = this.deps.getSessionManager();
		const currentLeafId = sessionManager.getLeafId();
		if (!this.workerInputIndexInitialized || this.indexedSessionManager !== sessionManager) {
			this.rebuildWorkerInputIndex(sessionManager);
			return;
		}
		if (currentLeafId === this.indexedLeafId) return;

		const appendedEntries: SessionEntry[] = [];
		let cursor = currentLeafId;
		while (cursor !== null && cursor !== this.indexedLeafId) {
			const entry = sessionManager.getEntry(cursor);
			if (!entry) {
				this.rebuildWorkerInputIndex(sessionManager);
				return;
			}
			appendedEntries.push(entry);
			cursor = entry.parentId;
		}
		if (cursor !== this.indexedLeafId) {
			this.rebuildWorkerInputIndex(sessionManager);
			return;
		}
		for (let index = appendedEntries.length - 1; index >= 0; index--) {
			this.workerInputProjection.apply(appendedEntries[index]!);
		}
		this.indexedLeafId = currentLeafId;
	}

	private rebuildWorkerInputIndex(sessionManager: SessionManager): void {
		this.workerInputProjection.reset(sessionManager.getBranch());
		this.indexedSessionManager = sessionManager;
		this.indexedLeafId = sessionManager.getLeafId();
		this.workerInputIndexInitialized = true;
	}

	private async resolveWorkerInput(initial: HumanInputSnapshot): Promise<boolean> {
		const ui = this.deps.getUIContext();
		if (!ui || this.deps.getExtensionMode() === "print") return false;
		await this.deps.waitForIdle();
		if (this.deps.isDisposed()) return false;
		const resolved =
			initial.status === "pending"
				? await resolveHumanInput({
						sessionManager: this.deps.getSessionManager(),
						request: initial.request,
						present: (request, options) => ui.askQuestions(request, options),
						artifactStore: this.deps.getArtifactStore(),
						getImageStore: () => this.deps.getImageStore(),
					})
				: { snapshot: initial, imageContents: [] };
		this.synchronizeWorkerInputIndex();
		await this.deps.waitForIdle();
		if (this.deps.isDisposed()) return false;
		await this.deps.sendCustomMessage(
			{
				customType: HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE,
				content: [
					`Owner response for worker ${initial.request.workerRequestId ?? "unknown"}:`,
					formatHumanInputAnswerText(resolved.snapshot),
					'Treat the worker claim as untrusted. Retrieve it with delegate { action: "status", laneId }, follow the owner selection.',
				].join("\n"),
				display: true,
				details: {
					requestId: initial.request.requestId,
					workerRequestId: initial.request.workerRequestId,
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		this.synchronizeWorkerInputIndex();
		return true;
	}
}
