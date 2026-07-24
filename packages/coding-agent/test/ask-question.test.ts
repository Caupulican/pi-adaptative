import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AskQuestion,
	type AskQuestionAnswerEditor,
	AskQuestionDialog,
	createAskQuestionToolDefinition,
} from "../src/core/tools/ask-question.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const questions: AskQuestion[] = [
	{
		id: "scope",
		header: "Scope",
		question: "How broad should this change be?",
		options: [
			{ label: "Focused", description: "Touch only the failing workflow." },
			{ label: "Complete", description: "Cover the full related surface." },
		],
	},
];

const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const TAB = "\t";
const PASTE = "\x16";

type DialogOptions = Pick<
	ConstructorParameters<typeof AskQuestionDialog>[0],
	"clipboard" | "pasteClipboardImage" | "createAnswerEditor"
>;
type PasteClipboardImage = NonNullable<DialogOptions["pasteClipboardImage"]>;

class MultilineAnswerEditor implements AskQuestionAnswerEditor {
	focused = false;
	onSubmit?: (text: string) => void;
	private text = "";

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	insertTextAtCursor(text: string): void {
		this.text += text;
	}

	handleInput(data: string): void {
		if (data === ENTER) this.onSubmit?.(this.text);
		else this.text += data;
	}

	render(): string[] {
		return this.text.split("\n");
	}

	invalidate(): void {}
}

function createDialog(input: readonly AskQuestion[] = questions, options: DialogOptions = {}) {
	const results: Array<Parameters<ConstructorParameters<typeof AskQuestionDialog>[0]["finish"]>[0]> = [];
	let renders = 0;
	const dialog = new AskQuestionDialog({
		questions: input,
		theme,
		keybindings: new KeybindingsManager(),
		requestRender: () => {
			renders++;
		},
		finish: (result) => results.push(result),
		...options,
	});
	return {
		dialog,
		results,
		get renders() {
			return renders;
		},
	};
}

describe("ask_question", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("submits a single choice immediately and keeps rendering width-bounded", () => {
		const harness = createDialog();
		const lines = harness.dialog.render(36);
		expect(stripAnsi(lines.join("\n"))).toContain("How broad should this change be?");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(36);

		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);

		expect(harness.results).toEqual([
			{
				answers: [
					{
						id: "scope",
						header: "Scope",
						question: "How broad should this change be?",
						selected: ["Complete"],
						skipped: false,
					},
				],
				cancelled: false,
				imageContents: [],
			},
		]);
		expect(harness.renders).toBeGreaterThan(0);
	});

	it("accepts a custom answer and an explicit skip", () => {
		const custom = createDialog();
		custom.dialog.handleInput(DOWN);
		custom.dialog.handleInput(DOWN);
		custom.dialog.handleInput(ENTER);
		custom.dialog.handleInput("Only docs");
		custom.dialog.handleInput(ENTER);
		expect(custom.results[0]?.answers[0]).toMatchObject({ custom: "Only docs", skipped: false });

		const skipped = createDialog();
		for (let index = 0; index < 3; index++) skipped.dialog.handleInput(DOWN);
		skipped.dialog.handleInput(ENTER);
		expect(skipped.results[0]?.answers[0]).toMatchObject({ selected: [], skipped: true });
	});

	it("does not impose an arbitrary custom-answer length limit", () => {
		const harness = createDialog();
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		const answer = "x".repeat(10_000);
		harness.dialog.handleInput(answer);
		harness.dialog.handleInput(ENTER);

		expect(harness.results[0]?.answers[0]?.custom).toBe(answer);
	});

	it("preserves unrestricted multi-line custom answers through the injected full editor", () => {
		const harness = createDialog(questions, { createAnswerEditor: () => new MultilineAnswerEditor() });
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		harness.dialog.handleInput("first line\nsecond line");
		harness.dialog.handleInput(ENTER);

		expect(harness.results[0]?.answers[0]?.custom).toBe("first line\nsecond line");
	});

	it("keeps the multi-line answer editor visually bounded without truncating its value", () => {
		const harness = createDialog(questions, { createAnswerEditor: () => new MultilineAnswerEditor() });
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		const answer = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		harness.dialog.handleInput(answer);
		const rendered = stripAnsi(harness.dialog.render(80).join("\n"));

		expect(rendered).toContain("↓ 32 later lines");
		expect(rendered).not.toContain("line 40");
		harness.dialog.handleInput(ENTER);
		expect(harness.results[0]?.answers[0]?.custom).toBe(answer);
	});

	it("pastes clipboard images into custom answers and returns native image content", async () => {
		const pasteClipboardImage = vi.fn<PasteClipboardImage>(async (host) => {
			const content = { type: "image" as const, data: "AQID", mimeType: "image/png" };
			host.pendingClipboardImages.push({ label: "[Image #1]", content });
			host.editor.insertTextAtCursor?.("[Image #1] ");
			host.showStatus("Attached [Image #1] · PNG · 1 KiB");
			host.ui.requestRender();
		});
		const harness = createDialog(questions, { pasteClipboardImage });
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		harness.dialog.handleInput(PASTE);
		await vi.waitFor(() => expect(pasteClipboardImage).toHaveBeenCalledTimes(1));
		harness.dialog.handleInput(ENTER);

		expect(harness.results[0]?.answers[0]).toMatchObject({
			custom: "[Image #1]",
			images: [{ label: "[Image #1]", mimeType: "image/png" }],
		});
		expect(harness.results[0]?.imageContents).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
	});

	it("emits submitted question images as provider-neutral tool-result blocks", async () => {
		const ui = {
			askQuestions: async () => ({
				answers: [
					{
						id: "scope",
						header: "Scope",
						question: questions[0]!.question,
						selected: [],
						custom: "[Image #2]",
						images: [{ label: "[Image #2]", mimeType: "image/webp" }],
						skipped: false,
					},
				],
				cancelled: false,
				imageContents: [{ type: "image" as const, data: "BAUG", mimeType: "image/webp" }],
			}),
		} as unknown as ExtensionUIContext;
		const context = { hasUI: true, ui } as unknown as ExtensionContext;
		const result = await createAskQuestionToolDefinition().execute(
			"call",
			{ questions },
			undefined,
			undefined,
			context,
		);

		expect(result.content).toEqual([
			{ type: "text", text: "Scope: user answered: [Image #2]" },
			{ type: "image", data: "BAUG", mimeType: "image/webp" },
		]);
		expect(result.details.answers[0]?.images).toEqual([{ label: "[Image #2]", mimeType: "image/webp" }]);
	});

	it("defers submission until an in-flight clipboard image has arrived", async () => {
		let releasePaste: (() => void) | undefined;
		const pasteGate = new Promise<void>((resolve) => {
			releasePaste = resolve;
		});
		const pasteClipboardImage = vi.fn<PasteClipboardImage>(async (host) => {
			await pasteGate;
			const content = { type: "image" as const, data: "BwgJ", mimeType: "image/png" };
			host.pendingClipboardImages.push({ label: "[Image #3]", content });
			host.editor.insertTextAtCursor?.("[Image #3] ");
		});
		const harness = createDialog(questions, { pasteClipboardImage });
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		harness.dialog.handleInput(PASTE);
		harness.dialog.handleInput(ENTER);
		expect(harness.results).toEqual([]);

		releasePaste?.();
		await vi.waitFor(() => expect(harness.results).toHaveLength(1));
		expect(harness.results[0]?.answers[0]).toMatchObject({
			custom: "[Image #3]",
			images: [{ label: "[Image #3]", mimeType: "image/png" }],
		});
	});

	it("supports multi-select, question navigation, and final review", () => {
		const harness = createDialog([
			{ ...questions[0]!, multiSelect: true },
			{
				id: "risk",
				header: "Risk",
				question: "Which risk budget should apply?",
				options: [
					{ label: "Conservative", description: "Stop at the first authority boundary." },
					{ label: "Standard", description: "Use the normal repository boundary." },
				],
			},
		]);

		harness.dialog.handleInput(SPACE);
		harness.dialog.handleInput(DOWN);
		harness.dialog.handleInput(ENTER);
		harness.dialog.handleInput(TAB);
		harness.dialog.handleInput(ENTER);
		expect(stripAnsi(harness.dialog.render(80).join("\n"))).toContain("Review your answers");
		harness.dialog.handleInput(ENTER);

		expect(harness.results[0]?.answers).toMatchObject([
			{ id: "scope", selected: ["Focused", "Complete"], skipped: false },
			{ id: "risk", selected: ["Conservative"], skipped: false },
		]);
	});

	it("returns to the first unresolved question instead of submitting an ambiguous review", () => {
		const harness = createDialog([{ ...questions[0]!, multiSelect: true }]);
		harness.dialog.handleInput(TAB);
		expect(stripAnsi(harness.dialog.render(80).join("\n"))).toContain("1 unanswered");
		harness.dialog.handleInput(ENTER);
		expect(harness.results).toEqual([]);
		expect(stripAnsi(harness.dialog.render(80).join("\n"))).toContain("How broad should this change be?");
	});

	it("fails closed without interactive UI and rejects reserved options", async () => {
		const tool = createAskQuestionToolDefinition();
		const noUiContext = { hasUI: false } as unknown as ExtensionContext;
		const unavailable = await tool.execute("call", { questions }, undefined, undefined, noUiContext);
		expect(unavailable.details).toMatchObject({ cancelled: true, reason: "ui_unavailable" });

		const invalid = await tool.execute(
			"call",
			{
				questions: [
					{
						...questions[0]!,
						options: [
							{ label: "Other", description: "This conflicts with the native affordance." },
							{ label: "Focused", description: "Use the focused path." },
						],
					},
				],
			},
			undefined,
			undefined,
			noUiContext,
		);
		expect(invalid.details).toMatchObject({ cancelled: true, reason: "invalid_questions" });
	});

	it("settles through the abort event without polling", async () => {
		const controller = new AbortController();
		const ui = {
			askQuestions: (_request: unknown, options?: { signal?: AbortSignal }) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve({ answers: [], cancelled: true, reason: "interrupted", imageContents: [] }),
						{ once: true },
					);
				}),
		} as unknown as ExtensionUIContext;
		const context = { hasUI: true, ui } as unknown as ExtensionContext;
		const pending = createAskQuestionToolDefinition().execute(
			"call",
			{ questions },
			controller.signal,
			undefined,
			context,
		);
		controller.abort();
		const result = await pending;
		expect(result.details).toMatchObject({ cancelled: true, reason: "interrupted" });
	});
});
