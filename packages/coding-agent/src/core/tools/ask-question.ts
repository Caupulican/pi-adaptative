import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Component,
	CURSOR_MARKER,
	Input,
	type Keybinding,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import {
	bindClipboardQueue,
	type ClipboardInputHost,
	type ClipboardQueueState,
	type PendingClipboardImage,
} from "../../modes/interactive/clipboard-input.ts";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import { defineTool } from "../extensions/types.ts";
import {
	beginHumanInputRequest,
	createHumanInputRequest,
	formatHumanInputAnswerText,
	type HumanInputAnswer,
	type HumanInputAnswerImage,
	type HumanInputPresentationResult,
	type HumanInputQuestion,
	type HumanInputSnapshot,
	type HumanInputStopReason,
	resolveHumanInput,
} from "../human-input.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { SessionImageStore } from "../session-image-store.ts";
import {
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
} from "./orchestration-panel.ts";

const optionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, maxLength: 120, description: "Concise option label." }),
		description: Type.String({
			minLength: 1,
			maxLength: 500,
			description: "Concrete consequence or tradeoff of choosing this option.",
		}),
	},
	{ additionalProperties: false },
);

const questionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 80, description: "Stable unique answer identifier." }),
		header: Type.String({
			minLength: 1,
			maxLength: 32,
			description: "Short topic label used in question navigation.",
		}),
		question: Type.String({ minLength: 1, maxLength: 1_000, description: "The specific user-facing question." }),
		options: Type.Array(optionSchema, {
			minItems: 2,
			maxItems: 4,
			description: "Two to four genuine choices. Other and Skip are supplied by the harness.",
		}),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one listed option to be selected." })),
	},
	{ additionalProperties: false },
);

const askQuestionSchema = Type.Object(
	{
		questions: Type.Array(questionSchema, {
			minItems: 1,
			maxItems: 4,
			description: "One to four independent questions presented in one interaction.",
		}),
	},
	{ additionalProperties: false },
);

const ANSWER_PREVIEW_CHARS = 240;
const ANSWER_EDITOR_VIEWPORT_LINES = 8;

export type AskQuestionToolInput = Static<typeof askQuestionSchema>;
export type AskQuestion = HumanInputQuestion;
export type AskQuestionAnswer = HumanInputAnswer;
export type AskQuestionAnswerImage = HumanInputAnswerImage;
export type AskQuestionStopReason = HumanInputStopReason;

export interface AskQuestionToolDetails {
	questions: readonly AskQuestion[];
	answers: readonly AskQuestionAnswer[];
	cancelled: boolean;
	reason?: AskQuestionStopReason;
	error?: string;
}

export interface AskQuestionToolOptions {
	name?: string;
	label?: string;
	/** Production session sink. When present, requests and answers are checkpointed before continuation. */
	sessionManager?: Pick<SessionManager, "appendCustomEntry">;
	artifactStore?: ArtifactStore;
	getImageStore?: () => Pick<SessionImageStore, "retainContent"> | undefined;
}

export interface AskQuestionClipboardOptions {
	autoResizeImages: boolean;
	blockImages: boolean;
	blockImagesReason?: string;
	imageStore?: Pick<SessionImageStore, "write">;
}

export type PasteClipboardImage = (host: ClipboardInputHost) => Promise<void>;

export interface AskQuestionAnswerEditor extends Component {
	focused: boolean;
	onSubmit?: (text: string) => void;
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	insertTextAtCursor(text: string): void;
}

export type CreateAskQuestionAnswerEditor = () => AskQuestionAnswerEditor;

class SingleLineAnswerEditor implements AskQuestionAnswerEditor {
	private readonly input = new Input();
	onSubmit?: (text: string) => void;

	constructor() {
		this.input.onSubmit = (value) => this.onSubmit?.(value);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	getText(): string {
		return this.input.getValue();
	}

	setText(text: string): void {
		this.input.setValue("");
		this.insertTextAtCursor(text);
	}

	insertTextAtCursor(text: string): void {
		this.input.handleInput(`\x1b[200~${text}\x1b[201~`);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		return this.input.render(width);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

interface QuestionSelection {
	optionIndexes: Set<number>;
	custom?: string;
	skipped: boolean;
}

type AskQuestionDialogResult = HumanInputPresentationResult;

function normalizedIdentity(value: string): string {
	return value.trim().toLowerCase();
}

function validateQuestions(questions: readonly AskQuestion[]): string | undefined {
	if (questions.length < 1 || questions.length > 4) return "Provide between one and four questions.";
	const ids = new Set<string>();
	const prompts = new Set<string>();
	for (const question of questions) {
		if (!question.id.trim() || !question.header.trim() || !question.question.trim()) {
			return "Question ids, headers, and prompts must not be blank.";
		}
		const id = normalizedIdentity(question.id);
		const prompt = normalizedIdentity(question.question);
		if (ids.has(id)) return `Question id '${question.id}' is duplicated.`;
		if (prompts.has(prompt)) return `Question '${question.question}' is duplicated.`;
		ids.add(id);
		prompts.add(prompt);
		if (question.options.length < 2 || question.options.length > 4) {
			return `Question '${question.header}' requires between two and four options.`;
		}
		const labels = new Set<string>();
		for (const option of question.options) {
			const label = normalizedIdentity(option.label);
			if (!label || !option.description.trim()) {
				return `Question '${question.header}' has a blank option label or description.`;
			}
			if (label === "other" || label === "skip") {
				return `Question '${question.header}' must not define the reserved '${option.label}' option.`;
			}
			if (labels.has(label)) return `Question '${question.header}' has duplicate option '${option.label}'.`;
			labels.add(label);
		}
	}
	return undefined;
}

function displayKeys(keybindings: KeybindingsManager, keybinding: Keybinding, limit = 2): string {
	return formatKeyText(keybindings.getKeys(keybinding).slice(0, limit).join("/"), { capitalize: true });
}

function answerFor(
	question: AskQuestion,
	selection: QuestionSelection,
	attachments: readonly PendingClipboardImage[] = [],
): AskQuestionAnswer {
	const images = selection.custom
		? attachments
				.filter((attachment) => selection.custom?.includes(attachment.label))
				.map((attachment) => ({ label: attachment.label, mimeType: attachment.content.mimeType }))
		: [];
	return {
		id: question.id,
		header: question.header,
		question: question.question,
		selected: [...selection.optionIndexes]
			.sort((left, right) => left - right)
			.map((index) => question.options[index]?.label)
			.filter((label): label is string => label !== undefined),
		...(selection.custom ? { custom: selection.custom } : {}),
		...(images.length > 0 ? { images } : {}),
		skipped: selection.skipped,
	};
}

function previewAnswer(value: string): string {
	if (value.length <= ANSWER_PREVIEW_CHARS) return value;
	return `${value.slice(0, ANSWER_PREVIEW_CHARS)}… (${value.length} characters)`;
}

function isResolved(selection: QuestionSelection): boolean {
	return selection.skipped || selection.optionIndexes.size > 0 || selection.custom !== undefined;
}

/** Native focused question interaction shared by every provider-facing ask_question call. */
export class AskQuestionDialog implements Component {
	private readonly questions: readonly AskQuestion[];
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly finish: (result: AskQuestionDialogResult) => void;
	private readonly clipboard: AskQuestionClipboardOptions;
	private readonly pasteClipboardImage: PasteClipboardImage;
	private readonly createAnswerEditor: CreateAskQuestionAnswerEditor;
	private readonly selections: QuestionSelection[];
	private readonly cursors: number[];
	private readonly clipboardQueue: ClipboardQueueState = {
		pendingClipboardImages: [],
		clipboardImageCounter: 0,
	};
	private currentIndex = 0;
	private input: AskQuestionAnswerEditor | undefined;
	private inputError: string | undefined;
	private inputStatus: string | undefined;
	private pasteInFlight = false;
	private submitAfterPaste = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private settled = false;

	constructor(options: {
		questions: readonly AskQuestion[];
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		finish: (result: AskQuestionDialogResult) => void;
		clipboard?: AskQuestionClipboardOptions;
		pasteClipboardImage?: PasteClipboardImage;
		createAnswerEditor?: CreateAskQuestionAnswerEditor;
	}) {
		this.questions = options.questions;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.finish = options.finish;
		this.clipboard = options.clipboard ?? { autoResizeImages: true, blockImages: false };
		this.pasteClipboardImage =
			options.pasteClipboardImage ??
			(async (host) => {
				host.showWarning("Clipboard paste is unavailable in this UI host.");
			});
		this.createAnswerEditor = options.createAnswerEditor ?? (() => new SingleLineAnswerEditor());
		this.selections = options.questions.map(() => ({ optionIndexes: new Set(), skipped: false }));
		this.cursors = options.questions.map(() => 0);
	}

	private refresh(): void {
		this.invalidate();
		this.requestRender();
	}

	private result(cancelled: boolean, reason?: AskQuestionStopReason): AskQuestionDialogResult {
		const answers = this.questions.map((question, index) =>
			answerFor(question, this.selections[index]!, this.clipboardQueue.pendingClipboardImages),
		);
		const referencedLabels = new Set(answers.flatMap((answer) => answer.images?.map((image) => image.label) ?? []));
		return {
			answers,
			cancelled,
			imageContents: cancelled
				? []
				: this.clipboardQueue.pendingClipboardImages
						.filter((attachment) => referencedLabels.has(attachment.label))
						.map((attachment) => attachment.content),
			...(reason ? { reason } : {}),
		};
	}

	private complete(result: AskQuestionDialogResult): void {
		if (this.settled) return;
		this.settled = true;
		if (this.input) this.input.focused = false;
		this.finish(result);
	}

	cancel(reason: Extract<AskQuestionStopReason, "user_cancelled" | "interrupted">): void {
		this.complete(this.result(true, reason));
	}

	private move(delta: -1 | 1): void {
		const lastIndex = this.questions.length;
		this.currentIndex = Math.max(0, Math.min(lastIndex, this.currentIndex + delta));
		this.refresh();
	}

	private advanceAfterSingleSelection(): void {
		if (this.questions.length === 1) {
			this.complete(this.result(false));
			return;
		}
		this.currentIndex = Math.min(this.questions.length, this.currentIndex + 1);
		this.refresh();
	}

	private beginCustomAnswer(): void {
		const questionIndex = this.currentIndex;
		const question = this.questions[questionIndex];
		const selection = this.selections[questionIndex];
		if (!question || !selection) return;
		const input = this.createAnswerEditor();
		this.inputError = undefined;
		this.inputStatus = undefined;
		input.focused = true;
		if (selection.custom) input.setText(selection.custom);
		input.onSubmit = (value) => {
			const answer = value.trim();
			if (!answer) return;
			selection.custom = answer;
			selection.skipped = false;
			input.focused = false;
			this.input = undefined;
			if (question.multiSelect) this.refresh();
			else this.advanceAfterSingleSelection();
		};
		this.input = input;
		this.refresh();
	}

	private async pasteIntoCustomAnswer(): Promise<void> {
		const input = this.input;
		if (!input || this.pasteInFlight) return;
		this.pasteInFlight = true;
		this.inputError = undefined;
		this.inputStatus = "Reading clipboard…";
		this.refresh();
		let reported = false;
		const host: ClipboardInputHost = bindClipboardQueue(this.clipboardQueue, {
			editor: {
				handleInput: (data) => input.handleInput(data),
				insertTextAtCursor: (text) => input.insertTextAtCursor(text),
			},
			ui: { requestRender: () => this.refresh() },
			autoResizeImages: this.clipboard.autoResizeImages,
			blockImages: this.clipboard.blockImages,
			blockImagesReason: this.clipboard.blockImagesReason,
			imageStore: this.clipboard.imageStore,
			showStatus: (message) => {
				reported = true;
				this.inputStatus = message;
				this.inputError = undefined;
			},
			showWarning: (message) => {
				reported = true;
				this.inputStatus = undefined;
				this.inputError = message;
				this.refresh();
			},
		});
		try {
			await this.pasteClipboardImage(host);
		} finally {
			this.pasteInFlight = false;
			const shouldSubmit = this.submitAfterPaste && this.input === input && !this.settled;
			this.submitAfterPaste = false;
			if (!reported) this.inputStatus = undefined;
			if (shouldSubmit) input.onSubmit?.(input.getText());
			if (this.input === input && !this.settled) this.refresh();
		}
	}

	private selectCurrent(): void {
		const question = this.questions[this.currentIndex];
		const selection = this.selections[this.currentIndex];
		if (!question || !selection) return;
		const cursor = this.cursors[this.currentIndex] ?? 0;
		if (cursor === question.options.length) {
			this.beginCustomAnswer();
			return;
		}
		if (cursor === question.options.length + 1) {
			selection.optionIndexes.clear();
			selection.custom = undefined;
			selection.skipped = true;
			this.advanceAfterSingleSelection();
			return;
		}
		selection.skipped = false;
		if (question.multiSelect) {
			if (selection.optionIndexes.has(cursor)) selection.optionIndexes.delete(cursor);
			else selection.optionIndexes.add(cursor);
			this.refresh();
			return;
		}
		selection.optionIndexes.clear();
		selection.optionIndexes.add(cursor);
		selection.custom = undefined;
		this.advanceAfterSingleSelection();
	}

	private submitReview(): void {
		const unresolved = this.selections.findIndex((selection) => !isResolved(selection));
		if (unresolved >= 0) {
			this.currentIndex = unresolved;
			this.refresh();
			return;
		}
		this.complete(this.result(false));
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (this.input) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.submitAfterPaste = false;
				this.input.focused = false;
				this.input = undefined;
				this.refresh();
				return;
			}
			if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
				void this.pasteIntoCustomAnswer();
				return;
			}
			if (this.pasteInFlight && this.keybindings.matches(data, "tui.input.submit")) {
				this.submitAfterPaste = true;
				this.inputStatus = "Finishing clipboard paste…";
				this.refresh();
				return;
			}
			const input = this.input;
			this.inputError = undefined;
			this.inputStatus = undefined;
			input.handleInput(data);
			if (this.input === input) this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.cancel("user_cancelled");
			return;
		}
		if (this.keybindings.matches(data, "app.question.previous")) {
			this.move(-1);
			return;
		}
		if (this.keybindings.matches(data, "app.question.next")) {
			this.move(1);
			return;
		}
		if (this.currentIndex === this.questions.length) {
			if (this.keybindings.matches(data, "tui.select.confirm")) this.submitReview();
			return;
		}
		const question = this.questions[this.currentIndex];
		if (!question) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursors[this.currentIndex] = Math.max(0, (this.cursors[this.currentIndex] ?? 0) - 1);
			this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursors[this.currentIndex] = Math.min(
				question.options.length + 1,
				(this.cursors[this.currentIndex] ?? 0) + 1,
			);
			this.refresh();
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			(question.multiSelect && this.keybindings.matches(data, "app.question.toggle"))
		) {
			this.selectCurrent();
		}
	}

	private addWrapped(lines: string[], text: string, width: number, indent = ""): void {
		const contentWidth = Math.max(1, width - visibleWidth(indent));
		for (const line of wrapTextWithAnsi(text, contentWidth)) {
			lines.push(truncateToWidth(`${indent}${line}`, width, ""));
		}
	}

	private renderProgress(lines: string[], width: number): void {
		if (this.questions.length === 1 && !this.questions[0]?.multiSelect) return;
		const chips = this.questions.map((question, index) => {
			const resolved = isResolved(this.selections[index]!);
			const text = ` ${resolved ? "●" : "○"} ${question.header} `;
			return index === this.currentIndex
				? this.theme.bg("selectedBg", this.theme.fg("text", text))
				: this.theme.fg(resolved ? "success" : "muted", text);
		});
		const review = " Review ";
		chips.push(
			this.currentIndex === this.questions.length
				? this.theme.bg("selectedBg", this.theme.fg("text", review))
				: this.theme.fg("dim", review),
		);
		lines.push(truncateToWidth(chips.join(" "), width, ""));
		lines.push("");
	}

	private renderQuestion(lines: string[], width: number, question: AskQuestion): void {
		const questionIndex = this.currentIndex;
		const selection = this.selections[questionIndex]!;
		const cursor = this.cursors[questionIndex] ?? 0;
		this.addWrapped(lines, this.theme.bold(question.question), width);
		if (question.multiSelect) {
			lines.push(this.theme.fg("muted", "Choose one or more, then continue to review."));
		}
		lines.push("");

		question.options.forEach((option, index) => {
			const active = index === cursor;
			const chosen = selection.optionIndexes.has(index);
			const prefix = `${active ? "›" : " "} ${chosen ? "●" : "○"} `;
			const label = `${prefix}${option.label}`;
			lines.push(
				truncateToWidth(
					active ? this.theme.bg("selectedBg", this.theme.fg("text", ` ${label} `)) : this.theme.fg("text", label),
					width,
					"",
				),
			);
			this.addWrapped(lines, this.theme.fg("muted", option.description), width, "    ");
		});

		const otherIndex = question.options.length;
		const otherActive = cursor === otherIndex;
		const otherLabel = selection.custom ? `Other: ${previewAnswer(selection.custom)}` : "Other";
		const otherText = `${otherActive ? "›" : " "} ${selection.custom ? "●" : "+"} ${otherLabel}`;
		lines.push(
			truncateToWidth(
				otherActive
					? this.theme.bg("selectedBg", this.theme.fg("text", ` ${otherText} `))
					: this.theme.fg("muted", otherText),
				width,
				"",
			),
		);
		const skipActive = cursor === otherIndex + 1;
		const skipText = `${skipActive ? "›" : " "} ${selection.skipped ? "●" : "–"} Skip`;
		lines.push(
			truncateToWidth(
				skipActive
					? this.theme.bg("selectedBg", this.theme.fg("text", ` ${skipText} `))
					: this.theme.fg("dim", skipText),
				width,
				"",
			),
		);

		if (this.input) {
			lines.push("");
			lines.push(this.theme.fg("muted", "Your answer"));
			const renderedInput = this.input.render(Math.max(4, width - 2));
			const cursorLine = Math.max(
				0,
				renderedInput.findIndex((line) => line.includes(CURSOR_MARKER)),
			);
			const viewportStart = Math.max(
				0,
				Math.min(
					cursorLine - Math.floor(ANSWER_EDITOR_VIEWPORT_LINES / 2),
					renderedInput.length - ANSWER_EDITOR_VIEWPORT_LINES,
				),
			);
			const visibleInput = renderedInput.slice(viewportStart, viewportStart + ANSWER_EDITOR_VIEWPORT_LINES);
			if (viewportStart > 0) {
				lines.push(this.theme.fg("dim", `  ↑ ${viewportStart} earlier line${viewportStart === 1 ? "" : "s"}`));
			}
			for (const inputLine of visibleInput) {
				lines.push(truncateToWidth(`  ${inputLine}`, width, ""));
			}
			const remainingLines = renderedInput.length - viewportStart - visibleInput.length;
			if (remainingLines > 0) {
				lines.push(this.theme.fg("dim", `  ↓ ${remainingLines} later line${remainingLines === 1 ? "" : "s"}`));
			}
			if (this.inputError) this.addWrapped(lines, this.theme.fg("warning", this.inputError), width, "  ");
			if (this.inputStatus) this.addWrapped(lines, this.theme.fg("success", this.inputStatus), width, "  ");
		}
	}

	private renderReview(lines: string[], width: number): void {
		lines.push(this.theme.bold("Review your answers"));
		lines.push("");
		let unresolved = 0;
		this.questions.forEach((question, index) => {
			const answer = answerFor(question, this.selections[index]!);
			const values = [...answer.selected, ...(answer.custom ? [previewAnswer(answer.custom)] : [])];
			const value = answer.skipped ? "Skipped" : values.length > 0 ? values.join(", ") : "Unanswered";
			if (!isResolved(this.selections[index]!)) unresolved++;
			this.addWrapped(
				lines,
				`${this.theme.fg("muted", `${question.header}:`)} ${this.theme.fg(value === "Unanswered" ? "warning" : "text", value)}`,
				width,
			);
		});
		if (unresolved > 0) {
			lines.push("");
			this.addWrapped(
				lines,
				this.theme.fg(
					"warning",
					`${unresolved} unanswered. Answer or explicitly skip each question before submitting.`,
				),
				width,
			);
		}
	}

	private renderHelp(lines: string[], width: number): void {
		const cancel = displayKeys(this.keybindings, "tui.select.cancel", 1);
		let help: string;
		if (this.input) {
			help = `${displayKeys(this.keybindings, "tui.input.submit", 1)} save  ·  ${displayKeys(this.keybindings, "tui.input.newLine", 1)} newline  ·  ${displayKeys(this.keybindings, "app.clipboard.pasteImage", 1)} paste  ·  ${cancel} back`;
		} else if (this.currentIndex === this.questions.length) {
			help = `${displayKeys(this.keybindings, "tui.select.confirm", 1)} submit  ·  ${displayKeys(this.keybindings, "app.question.previous")} back  ·  ${cancel} cancel`;
		} else if (this.questions[this.currentIndex]?.multiSelect) {
			help = `${displayKeys(this.keybindings, "tui.select.up")}/${displayKeys(this.keybindings, "tui.select.down")} move  ·  ${displayKeys(this.keybindings, "app.question.toggle", 1)}/${displayKeys(this.keybindings, "tui.select.confirm", 1)} toggle  ·  ${displayKeys(this.keybindings, "app.question.next")} next  ·  ${cancel} cancel`;
		} else {
			help = `${displayKeys(this.keybindings, "tui.select.up")}/${displayKeys(this.keybindings, "tui.select.down")} move  ·  ${displayKeys(this.keybindings, "tui.select.confirm", 1)} select  ·  ${cancel} cancel`;
		}
		this.addWrapped(lines, this.theme.fg("dim", help), width);
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		const header = this.currentIndex === this.questions.length ? "review" : this.questions[this.currentIndex]?.header;
		lines.push(
			truncateToWidth(
				`${this.theme.fg("accent", "?")} ${this.theme.bold(header ?? "question")}  ${this.theme.fg("dim", `${Math.min(this.currentIndex + 1, this.questions.length)}/${this.questions.length}`)}`,
				safeWidth,
				"",
			),
		);
		lines.push("");
		this.renderProgress(lines, safeWidth);
		const question = this.questions[this.currentIndex];
		if (question) this.renderQuestion(lines, safeWidth, question);
		else this.renderReview(lines, safeWidth);
		lines.push("");
		this.renderHelp(lines, safeWidth);
		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, ""));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function questionPanelModel(details: AskQuestionToolDetails | undefined): OrchestrationPanelModel {
	if (!details) {
		return { label: "question", status: "error", emptyText: "No structured answer was retained." };
	}
	if (details.reason === "ui_unavailable" || details.reason === "invalid_questions") {
		return {
			label: "question",
			action: "unavailable",
			status: "error",
			emptyText: details.error ?? "User input is unavailable.",
		};
	}
	const rows = details.questions.map((question) => {
		const answer = details.answers.find((candidate) => candidate.id === question.id);
		const values = answer ? [...answer.selected, ...(answer.custom ? [previewAnswer(answer.custom)] : [])] : [];
		const imageCount = answer?.images?.length ?? 0;
		return {
			status: details.cancelled
				? ("cancelled" as const)
				: answer?.skipped
					? ("cancelled" as const)
					: ("completed" as const),
			label: question.header,
			meta: details.cancelled
				? [details.reason === "interrupted" ? "interrupted" : "cancelled"]
				: answer?.skipped
					? ["skipped"]
					: [
							values.length > 1 ? `${values.length} selected` : undefined,
							imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : undefined,
						].filter((value): value is string => value !== undefined),
			details: values.length > 0 ? [`answer: ${values.join(", ")}`] : undefined,
		};
	});
	const skipped = details.answers.filter((answer) => answer.skipped).length;
	return {
		label: "question",
		action: details.cancelled ? "cancelled" : "answered",
		status: details.cancelled ? "warning" : "success",
		summary: details.cancelled
			? undefined
			: [`${details.answers.length - skipped} answered`, skipped ? `${skipped} skipped` : undefined].filter(
					(value): value is string => value !== undefined,
				),
		rows,
	};
}

function stoppedResult(
	questions: readonly AskQuestion[],
	reason: AskQuestionStopReason,
	error?: string,
): { content: Array<{ type: "text"; text: string }>; details: AskQuestionToolDetails } {
	return {
		content: [{ type: "text", text: error ?? `ask_question stopped: ${reason}` }],
		details: { questions, answers: [], cancelled: true, reason, ...(error ? { error } : {}) },
	};
}

export function createAskQuestionToolDefinition(options: AskQuestionToolOptions = {}) {
	const name = options.name ?? "ask_question";
	return defineTool<typeof askQuestionSchema, AskQuestionToolDetails>({
		name,
		label: options.label ?? "Ask Question",
		description:
			"Ask the human owner one to four concise questions when a missing choice materially changes the work. The harness supplies Other and Skip choices, supports single- and multi-select answers, and returns a typed answer set. Emit alone: never combine with other tool calls in the same message.",
		promptSnippet: "Ask owner for consequential missing choice through native UI.",
		promptGuidelines: [
			"Use only when owner choice changes result/authority/risk/acceptance; else proceed with stated safe assumption.",
			"Batch independent questions: max 4 questions, 2-4 genuine options each.",
			"Concise labels, concrete consequence/tradeoff. Never add Other/Skip/None/filler; harness adds Other/Skip.",
			"multiSelect only for independent choices. Never delegate decisions fixed by owner profile/policy.",
			"Skipped/cancelled is owner intent. Never repeat immediately; proceed safely or report unresolved boundary.",
		],
		parameters: askQuestionSchema,
		executionMode: "sequential",
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new OrchestrationPanelComponent(theme, {
					label: "question",
					action: "waiting for you",
					status: "running",
				});
			}
			return new OrchestrationPanelComponent(theme, questionPanelModel(result.details), expanded);
		},
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const validationError = validateQuestions(input.questions);
			if (validationError) return stoppedResult(input.questions, "invalid_questions", validationError);
			if (!ctx.hasUI) {
				return stoppedResult(input.questions, "ui_unavailable", "ask_question requires interactive UI.");
			}
			if (signal?.aborted) return stoppedResult(input.questions, "interrupted");

			const request = createHumanInputRequest({
				source: "tool",
				toolCallId: _toolCallId,
				toolName: name,
				questions: input.questions,
				acceptsImages: ctx.model?.input.includes("image") ?? false,
			});
			if (options.sessionManager) beginHumanInputRequest(options.sessionManager, request);
			const resolved = options.sessionManager
				? await resolveHumanInput({
						sessionManager: options.sessionManager,
						request,
						present: (presentation, dialogOptions) => ctx.ui.askQuestions(presentation, dialogOptions),
						artifactStore: options.artifactStore,
						getImageStore: options.getImageStore,
						signal,
					})
				: await (async (): Promise<{
						snapshot: HumanInputSnapshot;
						imageContents: AskQuestionDialogResult["imageContents"];
					}> => {
						const result = await ctx.ui.askQuestions(
							{
								requestId: request.requestId,
								questions: request.questions,
								acceptsImages: request.acceptsImages,
							},
							{ signal },
						);
						return {
							snapshot: {
								request,
								status: result.cancelled ? "cancelled" : "answered",
								answers: result.answers,
								...(result.reason ? { reason: result.reason } : {}),
								updatedAt: new Date().toISOString(),
							},
							imageContents: result.imageContents,
						};
					})();

			const details: AskQuestionToolDetails = {
				questions: input.questions,
				answers: resolved.snapshot.answers,
				cancelled: resolved.snapshot.status === "cancelled",
				...(resolved.snapshot.reason ? { reason: resolved.snapshot.reason } : {}),
			};
			if (details.cancelled) {
				return {
					content: [{ type: "text" as const, text: formatHumanInputAnswerText(resolved.snapshot) }],
					details,
				};
			}

			return {
				content: [
					{ type: "text" as const, text: formatHumanInputAnswerText(resolved.snapshot) },
					...resolved.imageContents,
				],
				details,
			};
		},
	});
}
