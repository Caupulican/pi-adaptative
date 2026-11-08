import { validateToolArguments } from "@caupulican/pi-ai/validation";
import { type Static, Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	type AgentTool,
	type AgentToolResult,
	type ExecutionContext,
	type ExecutionPathAuthority,
	readAgentToolExecutionError,
	readAgentToolPolicyDeniedError,
} from "../../kernel/index.ts";
import { type BoundToolInvocation, bindToolInvocation } from "../../kernel/tool-invocation-binding.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../kernel/utils/truncate.ts";
import type { Theme } from "../../presentation/theme-model.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { LOOKUP_TOOL_NAME, type LookupSubToolName } from "./lookup-tool-name.ts";
import { renderCollapsedTextResult, renderTextComponent } from "./render-utils.ts";
import { repoReadSchema } from "./repo-read.ts";
import { grepSchema } from "./schemas/grep.ts";
import { readSchema } from "./schemas/read.ts";

/**
 * Several independent lookups in one tool round: reads, directory listings, bounded git reads and content
 * searches. The tool owns no authority of its own. Each request is admitted exactly like a standalone call of the
 * equivalent tool (`read`, `read` on a directory, `repo_read`, `grep`): the session's own registered executor with
 * its own invocation binding, validated against that tool's schema, passed through the surface's admission
 * (see {@link NestedCallAdmitter}) and executed by that tool's own `execute`. A request the surface refuses is that
 * request's section; it is never skipped and never run unadmitted.
 */

export const MAX_LOOKUP_REQUESTS = 12;
/** The least a section is given, however many requests share the result. */
const MIN_SECTION_BYTES = 1024;
const MAX_LABEL_CHARS = 100;

const lookupReadSchema = Type.Pick(readSchema, ["path", "offset", "limit", "tail", "mode"]);
const lookupSearchSchema = Type.Pick(grepSchema, ["pattern", "path", "glob", "limit"]);
const lookupListSchema = Type.Pick(readSchema, ["path"]);

const lookupRequestSchema = Type.Union([
	Type.Object({ read: lookupReadSchema }, { additionalProperties: false, description: "Read one file." }),
	Type.Object({ list: lookupListSchema }, { additionalProperties: false, description: "List one directory." }),
	Type.Object({ repo: repoReadSchema }, { additionalProperties: false, description: "One repo_read git read." }),
	Type.Object({ search: lookupSearchSchema }, { additionalProperties: false, description: "Search file contents." }),
]);

const lookupSchema = Type.Object(
	{
		requests: Type.Array(lookupRequestSchema, {
			minItems: 1,
			maxItems: MAX_LOOKUP_REQUESTS,
			description:
				"Independent requests, each exactly one of {read:{path,offset?,limit?,tail?,mode?}}, {list:{path}}, {repo:{action,...}}, {search:{pattern,path?,glob?,limit?}}. Results come back in order.",
		}),
	},
	{ additionalProperties: false },
);

export type LookupToolInput = Static<typeof lookupSchema>;
type LookupRequest = LookupToolInput["requests"][number];
export type LookupKind = "read" | "list" | "repo" | "search";

export type LookupSectionStatus = "ok" | "error" | "refused";

export interface LookupToolDetails {
	requests: number;
	sections: { label: string; status: LookupSectionStatus; truncated: boolean }[];
}

/** One sub-call the lookup tool asks its surface to admit. */
export interface NestedCall {
	/** Unique within the parent call (`<parent id>#<n>`). */
	readonly id: string;
	readonly toolName: LookupSubToolName;
	/** Arguments already validated against the tool's own schema. */
	readonly args: Record<string, unknown>;
	/** The sub-call's own binding, as its tool acquired it. */
	readonly executionContext?: ExecutionContext;
	readonly pathAuthority?: ExecutionPathAuthority;
}

/** An admitted sub-call: start it right before its body, finish it with the body's result. */
export interface NestedCallAdmission {
	readonly kind: "admitted";
	/** Runs the hooks the surface registered for the start of the body. A policy refusal throws. */
	start(): void;
	/**
	 * Closes the call after its body returned or threw: the surface's result hooks and terminal records run, then its
	 * cleanups. Returns the policy-finalized content and error flag.
	 */
	finish(
		result: AgentToolResult<unknown>,
		isError: boolean,
		signal?: AbortSignal,
	): Promise<{ content: AgentToolResult<unknown>["content"]; isError: boolean }>;
	/** Drops an admitted call whose body never started. */
	abandon(): void;
}

export interface NestedCallRefusal {
	readonly kind: "refused";
	readonly reason: string;
}

/**
 * The surface's admission of one sub-call of an admitted parent call, through the same checks a standalone call of
 * `call.toolName` faces. A surface with no admission to give refuses; it never admits by default.
 */
export type NestedCallAdmitter = (
	parentToolCallId: string,
	call: NestedCall,
	signal?: AbortSignal,
) => Promise<NestedCallAdmission | NestedCallRefusal>;

export interface LookupHost {
	/**
	 * The executor this surface registers under `name` (credential guard, scope envelopes, verification and
	 * directory binding included), or undefined when the surface withholds that tool.
	 */
	resolveTool(name: LookupSubToolName): AgentTool | undefined;
	admit: NestedCallAdmitter;
}

interface PlannedCall {
	kind: LookupKind;
	label: string;
	toolName: LookupSubToolName;
	args: Record<string, unknown>;
	/** What to do next when this request's section is cut after `shownLines` lines. */
	continuation(shownLines: number): string;
}

function singleLine(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function definedFields<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function planRequest(request: LookupRequest): PlannedCall {
	if ("read" in request) {
		const read = request.read;
		const outline = read.mode === "outline";
		const startLine = Math.max(1, Math.floor(read.offset ?? 1));
		return {
			kind: "read",
			label: singleLine(`read ${read.path}${outline ? " (outline)" : ""}`),
			toolName: "read",
			args: definedFields(read),
			continuation: (shown) => {
				if (outline) return "read the part you need with offset and limit";
				if (read.tail !== undefined) return "ask for a smaller tail, or read a range with offset and limit";
				if (shown === 0) return "one line exceeds the section limit; read it as its own call";
				return `read it again with offset=${startLine + shown}`;
			},
		};
	}
	if ("list" in request) {
		return {
			kind: "list",
			label: singleLine(`list ${request.list.path}`),
			toolName: "read",
			args: definedFields(request.list),
			continuation: () => "list a narrower subdirectory",
		};
	}
	if ("repo" in request) {
		const repo = request.repo;
		return {
			kind: "repo",
			label: singleLine(`repo ${repo.action}${repo.path ? ` ${repo.path}` : ""}`),
			toolName: "repo_read",
			args: definedFields(repo),
			continuation: () => "narrow with paths, revisions or a smaller limit",
		};
	}
	const search = request.search;
	return {
		kind: "search",
		label: singleLine(`search ${search.pattern}${search.path ? ` in ${search.path}` : ""}`),
		toolName: "grep",
		args: definedFields(search),
		continuation: () => "narrow with path or glob, or lower limit",
	};
}

interface SectionOutcome {
	status: LookupSectionStatus;
	text: string;
}

const refusedOutcome = (reason: string): SectionOutcome => ({ status: "refused", text: `refused: ${reason}` });
const errorOutcome = (message: string): SectionOutcome => ({ status: "error", text: `error: ${message}` });

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A thrown refusal is a guard answering before the operation; any other throw is a failed operation. */
function outcomeFromThrown(error: unknown): SectionOutcome {
	const denial = readAgentToolPolicyDeniedError(error);
	if (denial) return refusedOutcome(denial.message);
	const execution = readAgentToolExecutionError(error);
	if (execution?.failureCode === "credential_access_blocked") return refusedOutcome(execution.message);
	return errorOutcome(describeError(error));
}

function contentText(content: AgentToolResult<unknown>["content"]): string {
	const images = content.filter((block) => block.type === "image").length;
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (images === 0) return text;
	return `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"} omitted; read the file as its own call to see it]`;
}

function validatedArguments(tool: AgentTool, id: string, args: Record<string, unknown>): Record<string, unknown> {
	const prepared = tool.prepareArguments ? (tool.prepareArguments(args) as Record<string, unknown>) : args;
	return validateToolArguments(
		tool,
		{ type: "toolCall", id, name: tool.name, arguments: prepared },
		{ repairEnabled: false },
	);
}

/** A sub-request that is admitted and waiting to run, or one already settled. */
type StartedRequest = { run: () => Promise<SectionOutcome> } | { settled: SectionOutcome };

/**
 * Prepares one request up to admission: resolve the tool, validate the arguments against its schema, acquire its
 * binding, ask the surface to admit it. Admission happens one request at a time, in order (an operator question
 * is never asked twice at once); the admitted bodies run together afterwards.
 */
async function startRequest(
	host: LookupHost,
	parentToolCallId: string,
	index: number,
	call: PlannedCall,
	signal: AbortSignal | undefined,
): Promise<StartedRequest> {
	const tool = host.resolveTool(call.toolName);
	if (!tool) return { settled: refusedOutcome(`the ${call.toolName} tool is not available in this session`) };
	const id = `${parentToolCallId}#${index + 1}`;
	let args: Record<string, unknown>;
	try {
		args = validatedArguments(tool, id, call.args);
	} catch (error) {
		return { settled: errorOutcome(`invalid request: ${describeError(error)}`) };
	}
	let binding: BoundToolInvocation | undefined;
	let admission: NestedCallAdmission | NestedCallRefusal;
	try {
		binding = tool.bindInvocation ? await bindToolInvocation(tool, id, args, signal) : undefined;
		admission = await host.admit(
			parentToolCallId,
			{
				id,
				toolName: call.toolName,
				args,
				...(binding ? { executionContext: binding.executionContext } : {}),
				...(binding?.pathAuthority ? { pathAuthority: binding.pathAuthority } : {}),
			},
			signal,
		);
	} catch (error) {
		binding?.release();
		signal?.throwIfAborted();
		return { settled: refusedOutcome(`not admitted (${describeError(error)})`) };
	}
	if (admission.kind === "refused") {
		binding?.release();
		return { settled: refusedOutcome(admission.reason) };
	}
	const executor = binding?.tool ?? tool;
	return {
		run: async () => {
			try {
				try {
					admission.start();
				} catch (error) {
					admission.abandon();
					return outcomeFromThrown(error);
				}
				let result: AgentToolResult<unknown>;
				let thrown: SectionOutcome | undefined;
				try {
					result = await executor.execute(id, args as never, signal);
				} catch (error) {
					thrown = outcomeFromThrown(error);
					result = { content: [{ type: "text", text: thrown.text }], details: undefined, isError: true };
				}
				let content = result.content;
				let isError = thrown !== undefined || result.isError === true;
				let hookNote = "";
				try {
					({ content, isError } = await admission.finish(result, isError, signal));
				} catch (error) {
					// The operation ran; a failed result hook is told, not turned into a different result.
					hookNote = `\n[result hooks failed: ${describeError(error)}]`;
				}
				if (thrown) return thrown;
				return { status: isError ? "error" : "ok", text: `${contentText(content)}${hookNote}` };
			} catch (error) {
				// A request settles as its own section; whatever went wrong around it never rejects its siblings.
				return outcomeFromThrown(error);
			} finally {
				binding?.release();
			}
		},
	};
}

function boundSection(call: PlannedCall, outcome: SectionOutcome, capBytes: number): { text: string; cut: boolean } {
	const cut = truncateHead(outcome.text, { maxBytes: capBytes, maxLines: DEFAULT_MAX_LINES });
	if (!cut.truncated) return { text: cut.content, cut: false };
	const notice = `[cut: ${cut.outputLines} of ${cut.totalLines} lines shown (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}); ${call.continuation(cut.outputLines)}]`;
	return { text: cut.content ? `${cut.content}\n${notice}` : notice, cut: true };
}

function countKinds(planned: readonly PlannedCall[]): Record<string, number> {
	const kinds: Record<string, number> = {};
	for (const call of planned) kinds[call.kind] = (kinds[call.kind] ?? 0) + 1;
	return kinds;
}

function formatLookupCall(args: Partial<LookupToolInput> | undefined, theme: Theme): string {
	const requests = Array.isArray(args?.requests) ? args.requests : [];
	const kinds = countKinds(requests.map((request) => planRequest(request)));
	const summary = Object.entries(kinds)
		.map(([kind, count]) => `${kind} ${count}`)
		.join(", ");
	return `${theme.fg("toolTitle", theme.bold("lookup"))} ${theme.fg("toolOutput", `${requests.length} requests`)}${summary ? theme.fg("muted", ` (${summary})`) : ""}`;
}

function lookupWarnings(details: LookupToolDetails | undefined): string[] {
	if (!details) return [];
	const warnings: string[] = [];
	const refused = details.sections.filter((section) => section.status === "refused").length;
	const failed = details.sections.filter((section) => section.status === "error").length;
	const cut = details.sections.filter((section) => section.truncated).length;
	if (refused > 0) warnings.push(`${refused} refused`);
	if (failed > 0) warnings.push(`${failed} failed`);
	if (cut > 0) warnings.push(`${cut} cut`);
	return warnings;
}

export function createLookupToolDefinition(host: LookupHost): ToolDefinition<typeof lookupSchema, LookupToolDetails> {
	return {
		name: LOOKUP_TOOL_NAME,
		label: "lookup",
		readOnly: true,
		description:
			"Use for 2 or more independent reads, directory listings, git reads (repo_read arguments) or content searches: up to 12 requests in one call instead of one round each. Every request is admitted and executed exactly like its dedicated tool; results come back as one labeled section per request in order, a refused or failed request does not affect the others, and a section cut to its share of the output bound names the offset or narrower call to use.",
		promptSnippet: "Several independent reads, listings, git reads and searches in one call",
		parameters: lookupSchema,
		async execute(toolCallId, input: LookupToolInput, signal?: AbortSignal) {
			const startedAt = Date.now();
			const planned = input.requests.map(planRequest);
			const capBytes = Math.max(MIN_SECTION_BYTES, Math.floor(DEFAULT_MAX_BYTES / planned.length));
			const running: Promise<SectionOutcome>[] = [];
			for (const [index, call] of planned.entries()) {
				signal?.throwIfAborted();
				const started = await startRequest(host, toolCallId, index, call, signal);
				running.push("run" in started ? started.run() : Promise.resolve(started.settled));
			}
			const outcomes = await Promise.all(running);
			signal?.throwIfAborted();
			const details: LookupToolDetails = { requests: planned.length, sections: [] };
			const sections = planned.map((call, index) => {
				const outcome = outcomes[index]!;
				const bounded = boundSection(call, outcome, capBytes);
				details.sections.push({ label: call.label, status: outcome.status, truncated: bounded.cut });
				return `[${index + 1}] ${call.label}\n${bounded.text}`;
			});
			const refused = details.sections.filter((section) => section.status === "refused").length;
			harnessLog.debug("tools", "lookup batch", () => ({
				requests: planned.length,
				kinds: countKinds(planned),
				refused,
				ms: Date.now() - startedAt,
			}));
			return {
				content: [{ type: "text" as const, text: sections.join("\n\n") }],
				details,
				...(details.sections.every((section) => section.status !== "ok") ? { isError: true } : {}),
			};
		},
		renderCall(args, theme, context) {
			return renderTextComponent(context.lastComponent, formatLookupCall(args, theme));
		},
		renderResult(result, renderOptions: ToolRenderResultOptions, theme, context) {
			return renderCollapsedTextResult(
				result as { content: Array<{ type: string; text?: string }>; details?: LookupToolDetails },
				renderOptions,
				theme,
				context,
				lookupWarnings,
			);
		},
	};
}
