import type { AgentTool } from "@caupulican/pi-agent-core";
import { Box, Container, Spacer, Text } from "@caupulican/pi-tui";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditMatchPlan,
	applyEditsToNormalizedContent,
	computeEditsPlannedDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	type EditMatchPlan,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { isValidUTF8 } from "./file-encoding-policy.ts";
import { FileMutationIntentController, hasFileMutationIntentIdShape } from "./file-mutation-intent.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
		range: Type.Optional(
			Type.Object(
				{
					startLine: Type.Integer({ minimum: 1 }),
					endLine: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const editPathSchema = Type.String({ minLength: 1 });
const editSchema = Type.Union([
	Type.Object(
		{
			action: Type.Literal("prepare"),
			path: editPathSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("edit"),
			path: editPathSchema,
			intentId: Type.String({ minLength: 1 }),
			edits: Type.Array(replaceEditSchema, {
				minItems: 1,
			}),
		},
		{ additionalProperties: false },
	),
]);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = {
	action?: unknown;
	path?: unknown;
	intentId?: unknown;
	edits?: unknown;
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	phase: "prepared" | "edited";
	intentId?: string;
	contentRef?: string;
	/** Display-oriented diff of the changes made */
	diff?: string;
	/** Standard unified patch of the changes made */
	patch?: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** True when execution reused the match plan already validated for the call preview. */
	matchPlanReused?: boolean;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Session-owned two-phase intent and exact-content-reference authority. */
	intentController?: FileMutationIntentController;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return input as EditToolInput;
	}

	let args = input as Record<string, unknown>;

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
		const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
		edits.push({ oldText: legacy.oldText, newText: legacy.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = legacy;
		args = { ...rest, edits };
	}

	if (
		typeof args.path === "string" &&
		(args.action === undefined || (args.action === "edit" && !hasFileMutationIntentIdShape(args.intentId)))
	) {
		return { action: "prepare", path: args.path };
	}
	return args as EditToolInput;
}

function validateEditInput(
	input: EditToolInput,
): { action: "prepare"; path: string } | { action: "edit"; path: string; intentId: string; edits: Edit[] } {
	if (input.action === "prepare") return input;
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { action: "edit", path: input.path, intentId: input.intentId, edits: input.edits };
}

type RenderableEditArgs = {
	action?: string;
	path?: string;
	file_path?: string;
	intentId?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewRequestId: number;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewRequestId: 0,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(
	args: RenderableEditArgs | undefined,
): { path: string; intentId: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}
	if (args.action !== "edit") return null;

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}
	if (typeof args.intentId !== "string" || args.intentId.length === 0) return null;

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, intentId: args.intentId, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, intentId: args.intentId, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

interface CachedEditMatchPlan {
	intentId: string;
	absolutePath: string;
	edits: Edit[];
	plan: EditMatchPlan;
	diff: string;
	firstChangedLine: number | undefined;
}

function snapshotEdits(edits: Edit[]): Edit[] {
	return edits.map((edit) => ({
		oldText: edit.oldText,
		newText: edit.newText,
		...(edit.range ? { range: { startLine: edit.range.startLine, endLine: edit.range.endLine } } : {}),
	}));
}

function editsMatch(left: Edit[], right: Edit[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const leftEdit = left[index];
		const rightEdit = right[index];
		if (
			leftEdit.oldText !== rightEdit.oldText ||
			leftEdit.newText !== rightEdit.newText ||
			leftEdit.range?.startLine !== rightEdit.range?.startLine ||
			leftEdit.range?.endLine !== rightEdit.range?.endLine
		) {
			return false;
		}
	}
	return true;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const action = args?.action === "prepare" ? "prepare" : undefined;
	return `${theme.fg("toolTitle", theme.bold("edit"))}${action ? ` ${theme.fg("muted", action)}` : ""} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(component: EditCallRenderComponent, preview: EditPreview): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	if (options?.operations && !options.intentController) {
		throw new Error("Custom edit operations require a matching file mutation intent controller.");
	}
	const intentController = options?.intentController ?? new FileMutationIntentController();
	let cachedMatchPlan: CachedEditMatchPlan | undefined;
	return {
		name: "edit",
		label: "edit",
		description:
			'Edit existing UTF-8 text: first call edit with action "prepare" and path, then call edit with action "edit", the accepted intentId, and edits. oldText must be exact, unique, and non-overlapping; optional inclusive line ranges bind matches to prior reads; stale targets are rejected.',
		promptSnippet: "Preflight existing files; apply exact, stale-safe edits",
		promptGuidelines: [
			'Before replacements, call edit with action "prepare" and path; then call edit with action "edit", the returned intentId, and all edits.',
			"oldText is exact, unique, minimal, and original-file based; pass the inclusive line range from the supplying read when known, batch separate edits, and merge overlaps.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const validated = validateEditInput(input);
			const { path } = validated;
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (validated.action === "prepare") {
					const prepared = await intentController.prepare("edit", absolutePath, signal, path);
					return {
						content: [
							{
								type: "text" as const,
								text: `Edit target accepted. Call edit again with action "edit", path ${path}, and intentId ${prepared.intentId}. The call also needs the required edits array containing every exact oldText/newText replacement. Do not omit edits.`,
							},
						],
						details: { phase: "prepared" as const, intentId: prepared.intentId },
					};
				}

				const { edits, intentId } = validated;
				const lease = intentController.consume(intentId, "edit", absolutePath);
				await intentController.assertCurrent(lease, signal);
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				if (!isValidUTF8(buffer)) {
					throw new Error(
						`PI_FILE_ENCODING_CORRUPTION: ${path} is not valid UTF-8 text; exact text replacement is unsafe and could corrupt its bytes.`,
					);
				}
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const cachedForIntent = cachedMatchPlan?.intentId === intentId ? cachedMatchPlan : undefined;
				if (cachedForIntent) cachedMatchPlan = undefined;
				const matchPlanReused =
					cachedForIntent !== undefined &&
					cachedForIntent.absolutePath === absolutePath &&
					editsMatch(cachedForIntent.edits, edits);
				const { baseContent, newContent } = matchPlanReused
					? applyEditMatchPlan(normalizedContent, cachedForIntent.plan, path)
					: applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();
				const contentReference = intentController.rememberContent(absolutePath, finalContent);

				const diffResult = matchPlanReused
					? { diff: cachedForIntent.diff, firstChangedLine: cachedForIntent.firstChangedLine }
					: generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}; this edit is complete, so do not call edit again for this path. To copy these exact bytes to a different new path, prepare that different path with write first, then use contentRef ${contentReference.contentRef}.`,
						},
					],
					details: {
						phase: "edited" as const,
						contentRef: contentReference.contentRef,
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
						matchPlanReused,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);

			if ((!context.argsComplete || !previewInput) && (component.preview || component.previewPending)) {
				component.preview = undefined;
				component.previewPending = false;
				component.settledError = false;
				component.previewRequestId++;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestId = ++component.previewRequestId;
				void computeEditsPlannedDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewRequestId === requestId) {
						if (!("error" in preview) && !options?.operations) {
							cachedMatchPlan = {
								intentId: previewInput.intentId,
								absolutePath: resolveToCwd(previewInput.path, context.cwd),
								edits: snapshotEdits(previewInput.edits),
								plan: preview.plan,
								diff: preview.diff,
								firstChangedLine: preview.firstChangedLine,
							};
						}
						setEditPreview(component, preview);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				callComponent.previewRequestId++;
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(callComponent, {
							diff: resultDiff,
							firstChangedLine: typedResult.details?.firstChangedLine,
						}) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
