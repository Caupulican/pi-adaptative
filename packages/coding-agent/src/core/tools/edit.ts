import { type AgentTool, createAgentToolFailureRecoveryAuthority } from "@caupulican/pi-agent-core/types";
import { Box, Container, Spacer, Text } from "@caupulican/pi-tui";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type AppliedEditsResult,
	applyEditMatchPlan,
	applyEditsToNormalizedContent,
	computeEditsPlannedDiff,
	detectLineEnding,
	digestNormalizedEditSource,
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
import {
	EDIT_RETARGET_RECOVERY_TARGET_KIND,
	FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
	type FileFailureRecoveryAuthority,
	fileRecoveryTarget,
	selectFileFailureRecoveryAuthority,
	WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
} from "./file-failure-recovery.ts";
import {
	FileMutationIdentityError,
	FileMutationIntentController,
	type FileMutationLease,
	FileMutationPreflightError,
} from "./file-mutation-intent.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

// An identity mismatch at execution is not failure by itself: the edit re-reads and
// re-validates its anchors against the current content, once, plus at most once more
// when the file changes again before the pre-write identity check passes. The budget
// bounds retries against OBSERVED changes only — a write landing after the last check
// passes is never observed, so it neither consumes the budget nor fails the edit.
const MAX_STALE_LEASE_REFRESHES = 2;

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
			path: editPathSchema,
			edits: Type.Array(replaceEditSchema, {
				minItems: 1,
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: editPathSchema,
			payloadRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = {
	path?: unknown;
	edits?: unknown;
	payloadRef?: unknown;
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	phase: "edited";
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
	/** Shared backend identity for exact cross-tool recovery with custom operations. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
	/** Session-owned harness preflight and exact-content-reference authority. */
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

	return args as EditToolInput;
}

function validateEdits(edits: unknown): Edit[] {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	for (const edit of edits) {
		if (
			typeof edit !== "object" ||
			edit === null ||
			typeof edit.oldText !== "string" ||
			typeof edit.newText !== "string"
		) {
			throw new Error("Edit tool input is invalid. Every edit requires string oldText and newText fields.");
		}
	}
	return edits as Edit[];
}

function validateEditInput(
	input: EditToolInput,
): { path: string; edits: Edit[]; payloadRef?: undefined } | { path: string; edits?: undefined; payloadRef: string } {
	if ("payloadRef" in input) return { path: input.path, payloadRef: input.payloadRef };
	return { path: input.path, edits: validateEdits(input.edits) };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	payloadRef?: string;
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

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

interface CachedEditMatchPlan {
	absolutePath: string;
	edits: Edit[];
	plan: EditMatchPlan;
	sourceDigest: string;
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
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
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

async function editPathFailureWithRetainedPayload(
	error: FileMutationPreflightError,
	validated:
		| { path: string; edits: Edit[]; payloadRef?: undefined }
		| { path: string; edits?: undefined; payloadRef: string },
	intentController: FileMutationIntentController,
	signal?: AbortSignal,
): Promise<Error> {
	const failureIdentity = error.reason === "edit_missing" ? "edit_missing (ENOENT)" : "edit_not_file";
	if (validated.payloadRef) {
		await intentController.assertMutationPayload(validated.payloadRef, "edit", signal);
		return new Error(
			`PI_FILE_MUTATION_RETARGET ${failureIdentity}: payloadRef ${validated.payloadRef}. Choose only a corrected path naming an existing file; the exact valid edit payload is retained for full revalidation.`,
		);
	}

	try {
		const retained = await intentController.retainMutationPayload("edit", JSON.stringify(validated.edits));
		if (retained) {
			return new Error(
				`PI_FILE_MUTATION_RETARGET ${failureIdentity}: payloadRef ${retained.payloadRef}. Choose only a corrected path naming an existing file; the exact valid edit payload is retained for full revalidation.`,
			);
		}
	} catch {
		// The path failure remains authoritative when the bounded retry cache is unavailable.
	}
	return new Error(`${error.message} The edit payload could not be retained within the secure retry-cache bound.`);
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

const COLLAPSED_EDIT_SNIPPET_LINES = 2;

function countEditBlocks(args: RenderableEditArgs | undefined): number | undefined {
	return getRenderablePreviewInput(args)?.edits.length;
}

function snippetLines(text: string, maxLines: number): string {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, maxLines)
		.join("\n");
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	options?: { expanded?: boolean; toolGroupSummary?: boolean },
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	const header = formatEditCall(args, theme, cwd);
	const blockCount = countEditBlocks(args);
	const blockMeta =
		blockCount === undefined ? "" : theme.fg("dim", ` · ${blockCount} block${blockCount === 1 ? "" : "s"}`);

	if (options?.toolGroupSummary) {
		component.addChild(new Text(header, 0, 0));
		return component;
	}

	if (!options?.expanded) {
		component.addChild(new Text(`${header}${blockMeta}`, 0, 0));
		if (component.preview) {
			const body =
				"error" in component.preview
					? theme.fg("error", component.preview.error)
					: renderDiff(component.preview.diff);
			const snippet = snippetLines(body, COLLAPSED_EDIT_SNIPPET_LINES);
			if (snippet) component.addChild(new Text(snippet, 0, 0));
		}
		return component;
	}

	component.addChild(new Text(header, 0, 0));
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
	const failureRecoveryAuthority = selectFileFailureRecoveryAuthority(
		options?.operations !== undefined,
		options?.failureRecoveryAuthority,
	);
	if (options?.operations && !options.intentController) {
		throw new Error("Custom edit operations require a matching file mutation intent controller.");
	}
	const intentController = options?.intentController ?? new FileMutationIntentController();
	const retargetRecoveryAuthority = createAgentToolFailureRecoveryAuthority();
	let cachedMatchPlan: CachedEditMatchPlan | undefined;
	return {
		name: "edit",
		label: "edit",
		toolGroup: "files",
		description:
			"Edit existing UTF-8 text in one call. Send path and all edits; after a path-only failure, reuse the returned payloadRef with only the corrected path. The harness preflights, revalidates, and stale-checks every exact replacement.",
		promptSnippet: "Preflight existing files; apply exact, stale-safe edits",
		promptGuidelines: [
			"Call once with path/all replacements; harness owns preparation/stale checks.",
			"Path failure with payloadRef: choose correct existing path, reuse reference; never regenerate edits.",
			"oldText: exact/unique/minimal/from original. Include supplying read's inclusive lines when known; batch separate edits, merge overlaps.",
			"Mismatch: use returned source evidence or reread narrowly; replace stale anchors, never replay.",
			"Success returns a locked-source diff/contentRef; do not reread automatically.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		failureRecovery: {
			getFailureEvidence: (_params, failure) =>
				failure.failureCode === "edit_old_text_not_found" ? failure.message : undefined,
			getFailureTargets: (params, failure) => {
				if (failure.failureCode === "mutation_retarget_required") {
					return [
						{
							authority: retargetRecoveryAuthority,
							kind: EDIT_RETARGET_RECOVERY_TARGET_KIND,
							scope: resolveToCwd(params.path, cwd),
						},
					];
				}
				if (failure.failureCode === "edit_old_text_not_found" && failureRecoveryAuthority) {
					return [
						fileRecoveryTarget(
							failureRecoveryAuthority,
							FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
							params.path,
							cwd,
						),
					];
				}
				return [];
			},
			actions: [
				{
					kind: "correct",
					authority: retargetRecoveryAuthority,
					targetKind: EDIT_RETARGET_RECOVERY_TARGET_KIND,
					instruction:
						"Use edit with the retained payloadRef and a corrected path naming the intended existing file.",
				},
				...(failureRecoveryAuthority
					? [
							{
								kind: "repair" as const,
								authority: failureRecoveryAuthority.contractAuthority,
								targetKind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
								instruction:
									"When a command failed because workspace contents need repair, edit the existing file and rerun that exact command.",
							},
						]
					: []),
			],
		},
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const validated = validateEditInput(input);
			const { path } = validated;
			const absolutePath = resolveToCwd(path, cwd);
			let lease: FileMutationLease;
			try {
				lease = await intentController.prepare("edit", absolutePath, signal, path);
			} catch (error) {
				if (
					error instanceof FileMutationPreflightError &&
					(error.reason === "edit_missing" || error.reason === "edit_not_file")
				) {
					throw await editPathFailureWithRetainedPayload(error, validated, intentController, signal);
				}
				throw error;
			}

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				let payloadRef: string | undefined;
				let edits: Edit[];
				if (validated.edits !== undefined) {
					edits = validated.edits;
				} else {
					payloadRef = validated.payloadRef;
					edits = validateEdits(
						JSON.parse(await intentController.readMutationPayload(payloadRef, "edit", signal)),
					);
				}
				let staleLeaseRefreshes = 0;
				const confirmLeaseOrRefresh = async (): Promise<boolean> => {
					try {
						await intentController.assertCurrent(lease, signal);
						return true;
					} catch (error) {
						if (
							!(error instanceof FileMutationIdentityError) ||
							staleLeaseRefreshes >= MAX_STALE_LEASE_REFRESHES
						) {
							throw error;
						}
						staleLeaseRefreshes++;
						await intentController.refreshIdentity(lease, signal);
						return false;
					}
				};

				// One round reads content bracketed by two matching identity observations of the
				// lease version and re-checks that identity immediately before writing. Same-process
				// edits are serialized by the file mutation queue. The pre-write check is a
				// point-in-time observation, not a hold on the file: an external write landing
				// between that check and ops.writeFile is neither detected nor preserved. The round
				// writes the full buffer computed from its own read, so the external write is
				// overwritten, its bytes are unrecoverable, and nothing observes the loss — not this
				// round, and not any later one.
				const runEditRound = async (): Promise<
					| {
							baseContent: string;
							newContent: string;
							finalContent: string;
							matchPlanReused: boolean;
							diffResult: { diff: string; firstChangedLine: number | undefined };
					  }
					| undefined
				> => {
					if (!(await confirmLeaseOrRefresh())) return undefined;
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
					const cachedForInput =
						cachedMatchPlan?.absolutePath === absolutePath && editsMatch(cachedMatchPlan.edits, edits)
							? cachedMatchPlan
							: undefined;
					if (cachedForInput) cachedMatchPlan = undefined;
					const matchPlanReused =
						cachedForInput !== undefined &&
						cachedForInput.sourceDigest === digestNormalizedEditSource(normalizedContent);
					let applied: AppliedEditsResult;
					try {
						applied = matchPlanReused
							? applyEditMatchPlan(normalizedContent, cachedForInput.plan, path)
							: applyEditsToNormalizedContent(normalizedContent, edits, path);
					} catch (error) {
						throw error instanceof Error && intentController.hasProducedContent(absolutePath, rawContent)
							? new Error(
									`The current content of ${path} was produced by an earlier mutation in this run; re-match oldText against it. ${error.message}`,
								)
							: error;
					}
					throwIfAborted();

					const finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);
					if (!(await confirmLeaseOrRefresh())) return undefined;
					throwIfAborted();
					await ops.writeFile(absolutePath, finalContent);
					throwIfAborted();
					return {
						baseContent: applied.baseContent,
						newContent: applied.newContent,
						finalContent,
						matchPlanReused,
						diffResult:
							matchPlanReused && cachedForInput
								? { diff: cachedForInput.diff, firstChangedLine: cachedForInput.firstChangedLine }
								: generateDiffString(applied.baseContent, applied.newContent),
					};
				};

				let completedRound: Awaited<ReturnType<typeof runEditRound>>;
				do {
					completedRound = await runEditRound();
				} while (completedRound === undefined);
				const { finalContent, matchPlanReused, diffResult, baseContent, newContent } = completedRound;

				const contentReference = intentController.rememberContent(absolutePath, finalContent);
				if (payloadRef) await intentController.discardMutationPayload(payloadRef);

				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}. To copy these exact bytes to a different new path, call write once for that path with contentRef ${contentReference.contentRef}.`,
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
								absolutePath: resolveToCwd(previewInput.path, context.cwd),
								edits: snapshotEdits(previewInput.edits),
								plan: preview.plan,
								sourceDigest: preview.sourceDigest,
								diff: preview.diff,
								firstChangedLine: preview.firstChangedLine,
							};
						}
						setEditPreview(component, preview);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd, {
				expanded: context.expanded,
				toolGroupSummary: context.toolGroupSummary,
			});
		},
		renderResult(result, options, theme, context) {
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
						{
							expanded: context.expanded,
							toolGroupSummary: context.toolGroupSummary,
						},
					);
				}
			}

			if (!options.expanded && !context.isError) {
				const hidden = (context.lastComponent as Container | undefined) ?? new Container();
				hidden.clear();
				return hidden;
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
