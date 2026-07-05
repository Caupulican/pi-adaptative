import { Agent, type AgentTool, type StreamFn } from "@caupulican/pi-agent-core";
import type { Model } from "@caupulican/pi-ai";

export const SCOUT_SYSTEM_PROMPT = `You are a repository scout. You explore a codebase with read-only tools and return compact evidence. You do NOT solve tasks, write code, or modify anything.

TOOLS: read (file contents), grep (search file contents), find (locate files by glob/name).
- Issue INDEPENDENT tool calls in parallel in the same turn whenever possible.
- Prefer grep/find to narrow, then read only the decisive regions.

OUTPUT CONTRACT: when you have enough evidence (or hit your turn budget), reply with:
<final_answer>
<one-to-three-sentence summary of what you found>
path/to/file.ts:START-END
path/to/other.ts:START-END
</final_answer>
- Every path MUST be one you actually observed via a tool result this run.
- Line ranges point at the decisive code, not whole files.
- If you found nothing relevant, say so inside <final_answer> with zero citations.
Turn budget: {MAX_TURNS} turns. Be fast; be precise; cite, don't paste.`;

export interface ScoutCitation {
	path: string;
	start: number;
	end: number;
	valid: boolean;
}

export interface ScoutRunResult {
	summary: string;
	citations: ScoutCitation[];
	droppedCitations: number;
	unreliable: boolean;
	truncated: boolean;
	turnsUsed: number;
	failure?: string;
}

export interface ScoutControllerDeps {
	resolveScoutModel(): Promise<
		{ model: Model<any>; apiKey?: string; headers?: Record<string, string> } | { failure: string }
	>;
	getCwd(): string;
	buildReadOnlyTools(cwd: string): AgentTool<any>[];
	streamFn?: StreamFn;
	fileExists(path: string): boolean;
	countLines(path: string): number | undefined;
	onEvent?(event: { type: "scout_turn" | "scout_end"; detail: string }): void;
	signal?: AbortSignal;
}

const MAX_TURNS_DEFAULT = 8;
const MAX_TURNS_HARD_CAP = 12;
const MAX_OUTPUT_TOKENS = 30_000;
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find"]);

export class ScoutController {
	private readonly deps: ScoutControllerDeps;

	constructor(deps: ScoutControllerDeps) {
		this.deps = deps;
	}

	async run(query: string, maxTurns = MAX_TURNS_DEFAULT): Promise<ScoutRunResult> {
		const turnLimit = clampTurns(maxTurns);
		const unavailable = emptyResult();
		if (this.deps.signal?.aborted) {
			return { ...unavailable, failure: "aborted" };
		}

		let modelResolution: Awaited<ReturnType<ScoutControllerDeps["resolveScoutModel"]>>;
		try {
			modelResolution = await this.deps.resolveScoutModel();
		} catch (error) {
			return { ...unavailable, failure: error instanceof Error ? error.message : String(error) };
		}
		if ("failure" in modelResolution) {
			return { ...unavailable, failure: modelResolution.failure };
		}

		let turnsUsed = 0;
		let truncated = false;
		let lastAssistantText = "";
		let outputTokens = 0;
		const agent = new Agent({
			initialState: {
				model: modelResolution.model,
				systemPrompt: SCOUT_SYSTEM_PROMPT.replace("{MAX_TURNS}", String(turnLimit)),
				tools: this.deps
					.buildReadOnlyTools(this.deps.getCwd())
					.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)),
			},
			streamFn: this.deps.streamFn,
			getApiKey: () => modelResolution.apiKey,
			maxStallTurns: turnLimit,
		});

		const unsubscribe = agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") {
				return;
			}
			turnsUsed += 1;
			lastAssistantText = assistantText(event.message);
			outputTokens += event.message.usage?.totalTokens ?? 0;
			this.deps.onEvent?.({ type: "scout_turn", detail: `turn ${turnsUsed}` });
			if (hasFinalAnswer(lastAssistantText)) {
				return;
			}
			if (turnsUsed >= turnLimit || outputTokens >= MAX_OUTPUT_TOKENS) {
				truncated = true;
				agent.abort();
			}
		});

		const abortScout = (): void => {
			truncated = true;
			agent.abort();
		};
		this.deps.signal?.addEventListener("abort", abortScout, { once: true });
		let runFailure: string | undefined;
		try {
			await agent.prompt(query);
		} catch (error) {
			if (!truncated && !this.deps.signal?.aborted) {
				runFailure = error instanceof Error ? error.message : String(error);
			}
		} finally {
			unsubscribe();
			this.deps.signal?.removeEventListener("abort", abortScout);
		}

		const result = parseScoutAnswer(
			lastAssistantText,
			(path) => this.deps.fileExists(path),
			(path) => this.deps.countLines(path),
		);
		const finalResult = {
			...result,
			truncated: truncated || !hasFinalAnswer(lastAssistantText),
			turnsUsed,
			failure: this.deps.signal?.aborted ? "aborted" : runFailure,
		};
		this.deps.onEvent?.({ type: "scout_end", detail: finalResult.failure ?? "ok" });
		return finalResult;
	}
}

export function parseScoutAnswer(
	text: string,
	fileExists: (path: string) => boolean,
	countLines: (path: string) => number | undefined,
): Omit<ScoutRunResult, "truncated" | "turnsUsed" | "failure"> {
	const finalAnswer = /<final_answer>([\s\S]*?)<\/final_answer>/i.exec(text)?.[1] ?? text;
	const summaryLines: string[] = [];
	const citations: ScoutCitation[] = [];

	for (const rawLine of finalAnswer.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const citation = parseCitationLine(line, fileExists, countLines);
		if (citation) {
			citations.push(citation);
			continue;
		}
		summaryLines.push(line);
	}

	const droppedCitations = citations.filter((citation) => !citation.valid).length;
	return {
		summary: summaryLines.join("\n"),
		citations,
		droppedCitations,
		unreliable: citations.length > 0 && droppedCitations / citations.length > 0.5,
	};
}

function parseCitationLine(
	line: string,
	fileExists: (path: string) => boolean,
	countLines: (path: string) => number | undefined,
): ScoutCitation | undefined {
	const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(line);
	if (!match) return undefined;
	const path = match[1].trim();
	const start = Number.parseInt(match[2], 10);
	const end = Number.parseInt(match[3] ?? match[2], 10);
	const lineCount = countLines(path);
	const valid =
		fileExists(path) &&
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		start >= 1 &&
		end >= start &&
		(lineCount === undefined || end <= lineCount);
	return { path, start, end, valid };
}

function clampTurns(maxTurns: number): number {
	if (!Number.isFinite(maxTurns)) return MAX_TURNS_DEFAULT;
	return Math.min(MAX_TURNS_HARD_CAP, Math.max(1, Math.trunc(maxTurns)));
}

function emptyResult(): ScoutRunResult {
	return { summary: "", citations: [], droppedCitations: 0, unreliable: false, truncated: false, turnsUsed: 0 };
}

function hasFinalAnswer(text: string): boolean {
	return /<final_answer>[\s\S]*?<\/final_answer>/i.test(text);
}

function assistantText(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((content): content is { type: "text"; text: string } =>
			Boolean(
				content &&
					typeof content === "object" &&
					(content as { type?: unknown }).type === "text" &&
					typeof (content as { text?: unknown }).text === "string",
			),
		)
		.map((content) => content.text)
		.join("\n");
}
