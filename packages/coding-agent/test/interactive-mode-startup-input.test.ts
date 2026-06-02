import { describe, expect, it, vi } from "vitest";
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
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	buildUserInputSubmission: (text: string) => UserInputSubmission;
	onInputCallback?: (submission: UserInputSubmission) => void;
	pendingUserInputs: UserInputSubmission[];
};

type InputContext = {
	onInputCallback?: (submission: UserInputSubmission) => void;
	pendingUserInputs: UserInputSubmission[];
};

type ClipboardImageContext = {
	pendingClipboardImages: Array<{ label: string; content: unknown }>;
	clipboardImageCounter: number;
	takeClipboardImagesForText: (text: string) => unknown[] | undefined;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<UserInputSubmission>;
	buildUserInputSubmission(this: ClipboardImageContext, text: string): UserInputSubmission;
	takeClipboardImagesForText(this: ClipboardImageContext, text: string): unknown[] | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		buildUserInputSubmission: (text: string) => ({ text }),
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
			pendingClipboardImages: [
				{ label: "[Image #1]", content: firstImage },
				{ label: "[Image #2]", content: secondImage },
			],
			clipboardImageCounter: 2,
			takeClipboardImagesForText: (text: string) =>
				interactiveModePrototype.takeClipboardImagesForText.call(context, text),
		};

		expect(interactiveModePrototype.buildUserInputSubmission.call(context, "describe [Image #2]")).toEqual({
			text: "describe [Image #2]",
			images: [secondImage],
		});
		expect(context.pendingClipboardImages).toEqual([]);
		expect(context.clipboardImageCounter).toBe(0);
	});
});
