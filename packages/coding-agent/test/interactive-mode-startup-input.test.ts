import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { type Api, getModel, type ImageContent, type Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { QueuedInput } from "../src/core/pending-input-queue-controller.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type UserInputSubmission = {
	text: string;
	images?: unknown[];
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	shutdown: () => Promise<void>;
	handleSecretsCommand: () => Promise<void>;
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isRetrying: boolean;
		isBashRunning: boolean;
		getSteeringMessages: () => readonly string[];
		getFollowUpMessages: () => readonly string[];
		takeQueuedMessages: () => { steering: QueuedInput[]; followUp: QueuedInput[] };
		abort: (reason?: string) => Promise<void>;
		waitForForegroundIdle: () => Promise<void>;
		model: Model<Api>;
		readonly thinkingLevel: ThinkingLevel;
		settingsManager: {
			getFastModeEnabled(provider: string): boolean | undefined;
			setFastModeEnabled(provider: string, enabled: boolean): void;
		};
		setThinkingLevel(level: ThinkingLevel, options?: { persistSettings?: boolean }): void;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	showStatus: (message: string) => void;
	footer: { invalidate: () => void };
	compactionQueuedMessages: { text: string; mode: "steer" | "followUp"; images?: ImageContent[] }[];
	activityLane?: { announce: (label: string, status?: string) => void };
	hasQueuedMessages: () => boolean;
	sendQueuedMessagesNow: () => Promise<void>;
	flushPendingBashComponents: () => void;
	buildUserInputSubmission: (text: string) => UserInputSubmission;
	takeClipboardImagesForText: (text: string) => unknown[] | undefined;
	queueCompactionMessage: (text: string, mode: "steer" | "followUp", images?: unknown[]) => void;
	refreshAutonomyFooterStatus: () => void;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
	onInputCallback?: (submission: UserInputSubmission) => void;
	pendingUserInputs: UserInputSubmission[];
};

type InputContext = {
	onInputCallback?: (submission: UserInputSubmission) => void;
	pendingUserInputs: UserInputSubmission[];
};

type ClipboardImageContext = {
	clipboardQueue: {
		pendingClipboardImages: Array<{ label: string; content: unknown }>;
		clipboardImageCounter: number;
	};
	clipboardImageStore?: { resolveReferences: (text: string) => unknown[] };
	takeClipboardImagesForText: (text: string) => unknown[] | undefined;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	hasQueuedMessages(this: SubmitContext): boolean;
	sendQueuedMessagesNow(this: SubmitContext): Promise<void>;
	getUserInput(this: InputContext): Promise<UserInputSubmission>;
	buildUserInputSubmission(this: ClipboardImageContext, text: string): UserInputSubmission;
	takeClipboardImagesForText(this: ClipboardImageContext, text: string): unknown[] | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	let thinkingLevel: ThinkingLevel = "high";
	const fastMode = new Map<string, boolean>();
	const queued: { steering: QueuedInput[]; followUp: QueuedInput[] } = { steering: [], followUp: [] };
	return {
		compactionQueuedMessages: [],
		activityLane: { announce: vi.fn() },
		hasQueuedMessages: interactiveModePrototype.hasQueuedMessages,
		sendQueuedMessagesNow: interactiveModePrototype.sendQueuedMessagesNow,
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		shutdown: vi.fn(async () => {}),
		handleSecretsCommand: vi.fn(async () => {}),
		session: {
			isCompacting: false,
			isStreaming: false,
			isRetrying: false,
			isBashRunning: false,
			getSteeringMessages: () => queued.steering.map((entry) => entry.text),
			getFollowUpMessages: () => queued.followUp.map((entry) => entry.text),
			takeQueuedMessages: vi.fn(() => {
				const taken = { steering: queued.steering, followUp: queued.followUp };
				queued.steering = [];
				queued.followUp = [];
				return taken;
			}),
			abort: vi.fn(async () => {}),
			waitForForegroundIdle: vi.fn(async () => {}),
			model: getModel("xai", "grok-4.6"),
			get thinkingLevel() {
				return thinkingLevel;
			},
			settingsManager: {
				getFastModeEnabled: (provider) => fastMode.get(provider),
				setFastModeEnabled: (provider, enabled) => fastMode.set(provider, enabled),
			},
			setThinkingLevel: (level) => {
				thinkingLevel = level;
			},
			prompt: vi.fn(async () => {}),
		},
		showStatus: vi.fn(),
		footer: { invalidate: vi.fn() },
		flushPendingBashComponents: vi.fn(),
		buildUserInputSubmission: (text: string) => ({ text }),
		takeClipboardImagesForText: vi.fn(() => undefined),
		queueCompactionMessage: vi.fn(),
		refreshAutonomyFooterStatus: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("queues every submitted message as steering while streaming", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/reload");

		expect(context.session.prompt).toHaveBeenCalledWith("/reload", {
			streamingBehavior: "steer",
			images: undefined,
			processSlashCommands: false,
		});
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("sends the queued messages now on an empty Enter while streaming: interrupt first, then one prompt with the images", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const order: string[] = [];
		(context.session.abort as ReturnType<typeof vi.fn>).mockImplementation(async (reason?: string) => {
			order.push(`abort:${reason}`);
		});
		(context.session.waitForForegroundIdle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("foreground idle");
		});
		(context.session.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
			order.push(`prompt:${text}`);
		});
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("stop and confirm");
		await context.defaultEditor.onSubmit?.(">> then run the payments suite");
		// Fill the fake session queue the way the real one would after those two prompts.
		(context.session.takeQueuedMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce({
			steering: [{ text: "stop and confirm", images: [image] }],
			followUp: [{ text: "then run the payments suite" }],
		});
		context.session.getSteeringMessages = () => ["stop and confirm"];
		order.length = 0;

		await context.defaultEditor.onSubmit?.("");

		expect(order).toEqual([
			"abort:send now",
			"foreground idle",
			"prompt:stop and confirm\n\nthen run the payments suite",
		]);
		expect(context.session.prompt).toHaveBeenLastCalledWith("stop and confirm\n\nthen run the payments suite", {
			images: [image],
			processSlashCommands: false,
		});
		expect(context.activityLane?.announce).toHaveBeenCalledWith(
			"Interrupting to send 2 queued messages now",
			"neutral",
		);
	});

	it("does nothing on an empty Enter when nothing is queued, when idle, or during compaction", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		context.session.isStreaming = true;
		await context.defaultEditor.onSubmit?.("   ");
		expect(context.session.abort).not.toHaveBeenCalled();
		expect(context.session.prompt).not.toHaveBeenCalled();

		context.session.isStreaming = false;
		context.session.getSteeringMessages = () => ["waiting"];
		await context.defaultEditor.onSubmit?.("");
		expect(context.session.abort).not.toHaveBeenCalled();

		context.session.isStreaming = true;
		context.session.isCompacting = true;
		await context.defaultEditor.onSubmit?.("");
		expect(context.session.abort).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Compaction in progress; queued messages are sent when it ends");
	});

	it("queues every submitted message as steering while compacting", async () => {
		const context = createSubmitContext();
		context.session.isCompacting = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/reload");

		expect(context.queueCompactionMessage).toHaveBeenCalledWith("/reload", "steer", undefined);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("treats /quit and /exit as local shutdown commands", async () => {
		for (const command of ["/quit", "/exit"]) {
			const context = createSubmitContext();
			interactiveModePrototype.setupEditorSubmitHandler.call(context);

			await context.defaultEditor.onSubmit?.(command);

			expect(context.shutdown).toHaveBeenCalledTimes(1);
			expect(context.session.prompt).not.toHaveBeenCalled();
			expect(context.editor.setText).toHaveBeenCalledWith("");
		}
	});

	it("opens the private credential menu without sending /secrets to the model", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/secrets");

		expect(context.handleSecretsCommand).toHaveBeenCalledTimes(1);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "secrets")).toBe(true);
	});

	it("handles /fast locally without sending it to the model", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/fast on");

		expect(context.session.thinkingLevel).toBe("high");
		expect(context.showStatus).toHaveBeenCalledWith("Fast mode on: Grok requests priority processing.");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	it("lets /quit and /exit bypass steering and compaction queues", async () => {
		for (const state of ["streaming", "compacting"] as const) {
			for (const command of ["/quit", "/exit"]) {
				const context = createSubmitContext();
				context.session.isStreaming = state === "streaming";
				context.session.isCompacting = state === "compacting";
				interactiveModePrototype.setupEditorSubmitHandler.call(context);

				await context.defaultEditor.onSubmit?.(command);

				expect(context.shutdown).toHaveBeenCalledTimes(1);
				expect(context.session.prompt).not.toHaveBeenCalled();
				expect(context.queueCompactionMessage).not.toHaveBeenCalled();
			}
		}
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("collects only clipboard images whose labels are still present", () => {
		const firstImage = { type: "image", data: "aaa", mimeType: "image/png" };
		const secondImage = { type: "image", data: "bbb", mimeType: "image/png" };
		const context: ClipboardImageContext = {
			clipboardQueue: {
				pendingClipboardImages: [
					{ label: "[Image #1]", content: firstImage },
					{ label: "[Image #2]", content: secondImage },
				],
				clipboardImageCounter: 2,
			},
			takeClipboardImagesForText: (text: string) =>
				interactiveModePrototype.takeClipboardImagesForText.call(context, text),
		};

		expect(interactiveModePrototype.buildUserInputSubmission.call(context, "describe [Image #2]")).toEqual({
			text: "describe [Image #2]",
			images: [secondImage],
		});
		expect(context.clipboardQueue.pendingClipboardImages).toEqual([]);
		expect(context.clipboardQueue.clipboardImageCounter).toBe(0);
	});

	it("resolves a later natural-language reference from the session image store", () => {
		const storedImage = { type: "image", data: "stored", mimeType: "image/png" };
		const context: ClipboardImageContext = {
			clipboardQueue: { pendingClipboardImages: [], clipboardImageCounter: 0 },
			clipboardImageStore: { resolveReferences: () => [storedImage] },
			takeClipboardImagesForText: (text: string) =>
				interactiveModePrototype.takeClipboardImagesForText.call(context, text),
		};

		expect(interactiveModePrototype.buildUserInputSubmission.call(context, "look at the image")).toEqual({
			text: "look at the image",
			images: [storedImage],
		});
	});
});
