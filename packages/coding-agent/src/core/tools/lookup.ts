import { type Static, Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../kernel/utils/truncate.ts";
import type { Theme } from "../../presentation/theme-model.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	LOOKUP_MAX_LABEL_CHARS,
	LOOKUP_TOOL_NAME,
	type LookupSubToolName,
	MAX_LOOKUP_REQUESTS,
} from "./lookup-tool-name.ts";
import {
	type NestedCallHost,
	type NestedCallOutcome,
	type NestedCallStatus,
	startNestedCall,
} from "./nested-tool-call.ts";
import { renderCollapsedTextResult, renderTextComponent } from "./render-utils.ts";
import { repoReadSchema } from "./repo-read.ts";
import { grepSchema } from "./schemas/grep.ts";
import { readSchema } from "./schemas/read.ts";

/**
 * Several independent lookups in one tool round: reads, directory listings, bounded git reads and content
 * searches. The tool owns no authority of its own. Each request is admitted exactly like a standalone call of the
 * equivalent tool (`read`, `read` on a directory, `repo_read`, `grep`): the session's own registered executor with
 * its own invocation binding, validated against that tool's schema, passed through the surface's admission
 * (see nested-tool-call.ts) and executed by that tool's own `execute`. A request the surface refuses is that
 * request's section; it is never skipped and never run unadmitted.
 */

export { MAX_LOOKUP_REQUESTS } from "./lookup-tool-name.ts";

/** The least a section is given, however many requests share the result. */
const MIN_SECTION_BYTES = 1024;

const lookupReadSchema = Type.Pick(readSchema, ["path", "offset", "limit", "tail", "mode"]);
const lookupSearchSchema = Type.Pick(grepSchema, ["pattern", "path", "glob", "limit"]);
const lookupListSchema = Type.Pick(readSchema, ["path"]);

const lookupFields = {
	read: Type.Object({ read: lookupReadSchema }, { additionalProperties: false, description: "Read one file." }),
	list: Type.Object({ list: lookupListSchema }, { additionalProperties: false, description: "List one directory." }),
	repo: Type.Object({ repo: repoReadSchema }, { additionalProperties: false, description: "One repo_read git read." }),
	search: Type.Object(
		{ search: lookupSearchSchema },
		{ additionalProperties: false, description: "Search file contents." },
	),
} as const;

const lookupTools = { read: "read", list: "read", repo: "repo_read", search: "grep" } as const satisfies Record<
	keyof typeof lookupFields,
	LookupSubToolName
>;

export type LookupToolInput = { requests: Static<(typeof lookupFields)[keyof typeof lookupFields]>[] };

function lookupSurface(available?: readonly string[]) {
	const kinds = (Object.keys(lookupFields) as (keyof typeof lookupFields)[]).filter(
		(kind) => !available || available.includes(lookupTools[kind]),
	);
	const variants = kinds.map((kind) => lookupFields[kind]);
	const request = variants.length === 1 ? variants[0]! : Type.Union(variants);
	const parameters = Type.Object(
		{
			requests: Type.Array(request, {
				minItems: 1,
				maxItems: MAX_LOOKUP_REQUESTS,
				description: "Independent requests, each selecting one operation. Results come back in order.",
			}),
		},
		{ additionalProperties: false },
	);
	return { parameters, kinds: kinds.join(", ") };
}

type LookupRequest = LookupToolInput["requests"][number];
export type LookupKind = "read" | "list" | "repo" | "search";

export type LookupSectionStatus = NestedCallStatus;

export interface LookupToolDetails {
	requests: number;
	sections: {
		label: string;
		status: LookupSectionStatus;
		truncated: boolean;
		continuation?: string;
		producer?: NestedCallOutcome["producer"];
	}[];
}

interface PlannedCall {
	kind: LookupKind;
	label: string;
	toolName: LookupSubToolName;
	args: Record<string, unknown>;
	/** What to do next when this request's section is cut after `shownLines` lines. */
	continuation(shownLines?: number, outcome?: NestedCallOutcome): string;
}

function singleLine(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= LOOKUP_MAX_LABEL_CHARS ? flat : `${flat.slice(0, LOOKUP_MAX_LABEL_CHARS - 1)}…`;
}

function definedFields<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function planRequest(request: LookupRequest): PlannedCall {
	if ("read" in request) {
		const read = request.read;
		const outline = read.mode === "outline";

		return {
			kind: "read",
			label: singleLine(`read ${read.path}${outline ? " (outline)" : ""}`),
			toolName: lookupTools.read,
			args: definedFields(read),
			continuation: (shown, outcome) => {
				if (outline) return "read the part you need with offset and limit";
				if (read.tail !== undefined) return "ask for a smaller tail, or read a range with offset and limit";
				if (shown === 0) return "one line exceeds the section limit; read it as its own call";
				const source = outcome?.readSourceLines;
				return source && shown !== undefined && shown <= source.count
					? `read it again with offset=${source.first + shown}`
					: "read the needed range directly with offset and limit";
			},
		};
	}
	if ("list" in request) {
		return {
			kind: "list",
			label: singleLine(`list ${request.list.path}`),
			toolName: lookupTools.list,
			args: definedFields(request.list),
			continuation: () => "list a narrower subdirectory",
		};
	}
	if ("repo" in request) {
		const repo = request.repo;
		return {
			kind: "repo",
			label: singleLine(`repo ${repo.action}${repo.path ? ` ${repo.path}` : ""}`),
			toolName: lookupTools.repo,
			args: definedFields(repo),
			continuation: () => "narrow with paths, revisions or a smaller limit",
		};
	}
	const search = request.search;
	return {
		kind: "search",
		label: singleLine(`search ${search.pattern}${search.path ? ` in ${search.path}` : ""}`),
		toolName: lookupTools.search,
		args: definedFields(search),
		continuation: () => "narrow with path or glob, or lower limit",
	};
}

function boundSection(
	call: PlannedCall,
	outcome: NestedCallOutcome,
	capBytes: number,
): { text: string; continuation?: string } {
	// The requested range is complete. A standalone read advertises the rest of the file,
	// but repeating that footer for every range in a batch wastes space and can suggest it was clipped.
	const footer = outcome.completeReadRangeFooter;
	const text =
		outcome.status === "ok" && footer
			? outcome.text.slice(0, footer.start) + outcome.text.slice(footer.end)
			: outcome.text;
	const cut = truncateHead(text, { maxBytes: capBytes, maxLines: DEFAULT_MAX_LINES });
	if (!cut.truncated) return { text: cut.content };
	const continuation = call.continuation(cut.outputLines, outcome);
	const notice = `[cut: ${cut.outputLines} of ${cut.totalLines} lines shown (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)}); ${continuation}]`;
	return { text: cut.content ? `${cut.content}\n${notice}` : notice, continuation };
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
	const cut = details.sections.filter((section) => section.truncated || section.producer?.clipped).length;
	if (refused > 0) warnings.push(`${refused} refused`);
	if (failed > 0) warnings.push(`${failed} failed`);
	if (cut > 0) warnings.push(`${cut} cut`);
	return warnings;
}

export function createLookupToolDefinition(
	host: NestedCallHost,
	available?: readonly string[],
): ToolDefinition<ReturnType<typeof lookupSurface>["parameters"], LookupToolDetails> {
	const { parameters, kinds } = lookupSurface(available);
	return {
		name: LOOKUP_TOOL_NAME,
		label: "lookup",
		readOnly: true,
		description: `Batch up to ${MAX_LOOKUP_REQUESTS} independent requests. Available operations: ${kinds}. Each uses its dedicated tool's admission and returns its own result in order.`,
		promptSnippet: `Batch independent requests (${kinds})`,
		neverDefer: true,
		parameters,
		async execute(toolCallId, input: LookupToolInput, signal?: AbortSignal) {
			const startedAt = Date.now();
			const planned = input.requests.map(planRequest);
			const capBytes = Math.max(MIN_SECTION_BYTES, Math.floor(DEFAULT_MAX_BYTES / planned.length));
			const running: Promise<NestedCallOutcome>[] = [];
			for (const [index, call] of planned.entries()) {
				signal?.throwIfAborted();
				// Admission happens one request at a time, in order (an operator question is never asked twice at once); the
				// admitted bodies run together afterwards.
				const started = await startNestedCall(
					host,
					toolCallId,
					`${toolCallId}#${index + 1}`,
					call.toolName,
					call.args,
					signal,
				);
				running.push("run" in started ? started.run() : Promise.resolve(started.settled));
			}
			const outcomes = await Promise.all(running);
			signal?.throwIfAborted();
			const details: LookupToolDetails = { requests: planned.length, sections: [] };
			const sections = planned.map((call, index) => {
				const outcome = outcomes[index]!;
				const bounded = boundSection(call, outcome, capBytes);
				const producer = outcome.producer;
				const continuation =
					bounded.continuation ??
					outcome.readContinuation ??
					(producer?.clipped ? call.continuation() : undefined);
				details.sections.push({
					label: call.label,
					status: outcome.status,
					truncated: bounded.continuation !== undefined,
					...(continuation ? { continuation } : {}),
					...(producer ? { producer } : {}),
				});
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
