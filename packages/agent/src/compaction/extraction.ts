import type { SessionEntry } from "../session/session-manager.ts";
import type { AgentMessage } from "../types.ts";

export interface CompactionFileFact {
	path: string;
	kind: "modified" | "created" | "read";
	note: string;
}

export interface CompactionErrorFact {
	operation: string;
	error: string;
}

export interface CompactionFacts {
	files: CompactionFileFact[];
	workingSet: CompactionFileFact[];
	actions: string[];
	errorFacts: CompactionErrorFact[];
	prohibitions: string[];
	cancelledText: string;
	activeTaskSource: string;
}

interface ToolCallFact {
	id: string | undefined;
	name: string;
	path: string | undefined;
	baseKind: "modified" | "created" | "read" | null;
	finalKind: "modified" | "created" | "read" | null;
	verb: string;
	resolved: boolean;
	failed: boolean;
}

const PROHIBITION_PATTERN = /\b(do not|don't|never|stop (?:doing|using|changing)|no more)\b/i;
// Deliberately narrow: a bare "stop" ("stop the server and rerun") is everyday phrasing, not a
// reversal of the prior work — matching it marked whole turns cancelled and made the
// cancelled-work gate fight the recall gates (2026-07-06 incident).
const REVERSAL_PATTERN =
	/\b(undo|revert|roll back|never mind|scrap that|forget (?:it|that)|stop (?:that|this|it|everything|working on))\b/i;

/** User messages longer than this are documents/pastes, not spoken prohibitions. */
const PROHIBITION_SOURCE_MAX_CHARS = 1_500;
/** Upper bound on gate-demanded rules; most recent win (same bounding rationale as Done carry-over). */
const MAX_PROHIBITIONS = 8;
/** Upper bound on gate-demanded actions; mirrors the prompt's "15 most recent Done items" rule. */
const MAX_ACTIONS = 15;
const MAX_WORKING_SET_FILES = 8;
const MAX_ERROR_FACTS = 5;
const ERROR_LINE_MAX_CHARS = 160;
const COMMAND_PREFIX_MAX_CHARS = 80;
/** Shared clamp for the active-task text because verification can only demand what the prompt receives. */
export const ACTIVE_TASK_SOURCE_MAX_CHARS = 4_000;

const FILE_KIND_PRIORITY: Record<NonNullable<ToolCallFact["finalKind"]>, number> = {
	read: 1,
	created: 2,
	modified: 3,
};

const TOOL_KIND_BY_NAME: Record<string, "modified" | "created" | "read" | null> = {
	read: "read",
	grep: "read",
	find: "read",
	write: "modified",
	edit: "modified",
	bash: null,
};

const TOOL_VERB_BY_NAME: Record<string, string> = {
	write: "WRITE",
	edit: "EDIT",
	bash: "RUN",
	read: "READ",
	grep: "READ",
	find: "READ",
};

function messageToText(message: AgentMessage): string {
	const rawContent = (message as { content?: unknown }).content;
	if (typeof rawContent === "string") {
		return rawContent;
	}
	if (!Array.isArray(rawContent)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of rawContent) {
		if (!block || typeof block !== "object") {
			continue;
		}

		if ((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join(" ").trim();
}

function assistantToolCallTarget(name: string, rawArgs: unknown): string | undefined {
	if (!rawArgs || typeof rawArgs !== "object") {
		return undefined;
	}
	const args = rawArgs as Record<string, unknown>;

	if (
		(name === "read" || name === "grep" || name === "find" || name === "write" || name === "edit") &&
		typeof args.path === "string" &&
		args.path.length > 0
	) {
		return args.path;
	}

	if (name === "bash" && typeof args.command === "string" && args.command.length > 0) {
		return args.command;
	}

	return undefined;
}

function clampText(text: string, maxLen: number): string {
	return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function appearsCreated(message: AgentMessage): boolean {
	if (message.role !== "toolResult") {
		return false;
	}

	const text = messageToText(message).toLowerCase();
	if (/(\bnew file\b|\bcreated\b|\bcreated file\b)/.test(text)) {
		return true;
	}

	const details = (message as { details?: unknown }).details;
	if (!details || typeof details !== "object") {
		return false;
	}

	if (typeof (details as { created?: unknown }).created === "boolean") {
		return (details as { created: boolean }).created;
	}
	if (typeof (details as { isCreated?: unknown }).isCreated === "boolean") {
		return (details as { isCreated: boolean }).isCreated;
	}
	if (typeof (details as { isNewFile?: unknown }).isNewFile === "boolean") {
		return (details as { isNewFile: boolean }).isNewFile;
	}

	return false;
}

function splitSentenceLines(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((line) => line.trim().replace(/[.!?]+$/, ""))
		.filter(Boolean);
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message;
		case "custom_message":
			return {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				details: entry.details,
				display: entry.display,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		case "branch_summary":
			return {
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		case "compaction":
			return undefined;
		default:
			return undefined;
	}
}

function isToolCallBlock(block: unknown): block is { type: "toolCall"; id?: string; name: string; arguments: unknown } {
	if (!block || typeof block !== "object") {
		return false;
	}
	if ((block as { type?: unknown }).type !== "toolCall") {
		return false;
	}
	if (typeof (block as { name?: unknown }).name !== "string") {
		return false;
	}
	if (!(block as { arguments?: unknown }).arguments) {
		return false;
	}
	return true;
}

function toolCallVerb(name: string): string {
	return TOOL_VERB_BY_NAME[name] ?? name.toUpperCase();
}

function isHarnessPlumbingTarget(target: string | undefined): boolean {
	if (!target) return false;
	return (
		target.includes("/.pi/agent/context-gc/") ||
		target.includes("~/.pi/agent/context-gc/") ||
		/\/tmp\/pi-bash-[^\s]+\.log\b/.test(target)
	);
}

function normalizeOperationTarget(toolName: string, path: string | undefined): string {
	if (!path) return "(unknown)";
	if (toolName !== "bash") return path;
	return clampText(path.replace(/\s+/g, " ").trim(), COMMAND_PREFIX_MAX_CHARS);
}

function operationKey(toolName: string, path: string | undefined): string {
	return `${toolName}:${normalizeOperationTarget(toolName, path)}`;
}

function operationLabel(toolName: string, path: string | undefined): string {
	return `${toolCallVerb(toolName)} ${normalizeOperationTarget(toolName, path)}`;
}

function resultExitCode(message: AgentMessage): number | undefined {
	const details = (message as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const raw = (details as { exitCode?: unknown }).exitCode;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
	return undefined;
}

function isOutcomeBearingTool(toolName: string | undefined): boolean {
	return toolName === "bash";
}

function isOpenProblemTool(toolName: string | undefined): boolean {
	return toolName === "bash" || toolName === "edit" || toolName === "write";
}

function failureSignalLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((line) => /exited with code [1-9]\d*/i.test(line) || /^(error|fatal|✗|FAIL)\b/i.test(line));
}

function firstErrorLine(text: string): string {
	const line =
		failureSignalLine(text) ??
		text
			.split(/\r?\n/)
			.map((part) => part.trim())
			.find(Boolean);
	return clampText(line ?? "failed", ERROR_LINE_MAX_CHARS);
}

function isFailureToolResult(message: AgentMessage, text: string): boolean {
	if (message.role !== "toolResult") return false;
	if ((message as { isError?: unknown }).isError === true) return true;
	const exitCode = resultExitCode(message);
	if (exitCode !== undefined) return exitCode !== 0;
	const toolName = (message as { toolName?: unknown }).toolName;
	return typeof toolName === "string" && isOutcomeBearingTool(toolName) && failureSignalLine(text) !== undefined;
}

export function extractCompactionFacts(entries: SessionEntry[], start: number, end: number): CompactionFacts {
	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.min(entries.length, Math.max(rangeStart, end));

	if (rangeStart >= rangeEnd) {
		return {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		};
	}

	const filesByPath = new Map<string, CompactionFileFact & { lastTouch: number }>();
	const filesNotes = new Map<string, string>();
	const seenProhibitions = new Set<string>();
	const actionFacts: ToolCallFact[] = [];
	const pendingById = new Map<string, number[]>();
	const pendingByOrder: number[] = [];

	const actions: string[] = [];
	const openErrors = new Map<string, CompactionErrorFact & { lastTouch: number }>();
	const prohibitions: string[] = [];
	let activeTaskSource = "";
	const cancelledParts: string[] = [];
	const sinceLastUser: string[] = [];

	for (let i = rangeStart; i < rangeEnd; i++) {
		const message = getMessageFromEntry(entries[i]);
		if (!message) {
			continue;
		}

		if (message.role === "user") {
			const userText = messageToText(message);
			if (REVERSAL_PATTERN.test(userText)) {
				cancelledParts.push(...sinceLastUser);
			}
			sinceLastUser.length = 0;

			if (userText) {
				activeTaskSource = clampText(userText, ACTIVE_TASK_SOURCE_MAX_CHARS);
				// Mandatory Rules exist for SPOKEN durable prohibitions ("do not touch X"), not for
				// documents. A long pasted text (plan, instruction file) can contain dozens of
				// "never/do not" lines; harvesting them makes the verification gate demand the
				// checkpoint reproduce the document (2026-07-06 field incident: 13 fragment rules
				// extracted from one pasted instruction). Documents live on disk; skip them here.
				if (userText.length <= PROHIBITION_SOURCE_MAX_CHARS) {
					for (const sentence of splitSentenceLines(userText)) {
						if (!PROHIBITION_PATTERN.test(sentence)) {
							continue;
						}
						const normalized = clampText(sentence, 160);
						const dedupeKey = normalized.toLowerCase();
						if (!seenProhibitions.has(dedupeKey)) {
							seenProhibitions.add(dedupeKey);
							prohibitions.push(normalized);
						}
					}
				}
			}
			continue;
		}

		if (message.role === "assistant" || message.role === "toolResult") {
			const messageText = messageToText(message);
			if (messageText) {
				sinceLastUser.push(messageText);
			}
		}

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isToolCallBlock(block)) {
					continue;
				}
				const name = block.name;
				const verb = toolCallVerb(name);
				const path = assistantToolCallTarget(name, block.arguments);
				const baseKind = TOOL_KIND_BY_NAME[name] ?? null;
				const fact: ToolCallFact = {
					id: block.id,
					name,
					path,
					baseKind,
					finalKind: baseKind,
					verb,
					resolved: false,
					failed: false,
				};
				actionFacts.push(fact);
				const index = actionFacts.length - 1;
				pendingByOrder.push(index);
				if (fact.id) {
					const bucket = pendingById.get(fact.id) ?? [];
					bucket.push(index);
					pendingById.set(fact.id, bucket);
				}
			}
		}

		if (message.role === "toolResult") {
			const toolCallId = (message as { toolCallId?: string }).toolCallId;
			const toolName = (message as { toolName?: string }).toolName;
			let matchedIndex: number | undefined;

			if (toolCallId) {
				const bucket = pendingById.get(toolCallId);
				if (bucket && bucket.length > 0) {
					matchedIndex = bucket.shift();
					if (bucket.length === 0) {
						pendingById.delete(toolCallId);
					}
				}
			}

			if (matchedIndex === undefined && toolName) {
				for (const index of pendingByOrder) {
					const candidate = actionFacts[index];
					if (!candidate.resolved && candidate.name === toolName) {
						matchedIndex = index;
						break;
					}
				}
			}

			if (matchedIndex !== undefined) {
				const fact = actionFacts[matchedIndex];
				const resultText = messageToText(message);
				const failed = isFailureToolResult(message, resultText);
				fact.resolved = true;
				fact.failed = failed;
				if (!failed && fact.baseKind === "modified" && appearsCreated(message)) {
					fact.finalKind = "created";
				}

				if (!failed && fact.path && fact.finalKind && !isHarnessPlumbingTarget(fact.path)) {
					const existing = filesByPath.get(fact.path);
					const nextKind = fact.finalKind;
					const note = fact.verb;
					if (!existing || FILE_KIND_PRIORITY[nextKind] > FILE_KIND_PRIORITY[existing.kind]) {
						filesByPath.set(fact.path, { path: fact.path, kind: nextKind, note, lastTouch: i });
					} else if (existing.kind === nextKind) {
						existing.note = note;
						existing.lastTouch = i;
					} else {
						existing.lastTouch = i;
					}
				}

				const key = operationKey(fact.name, fact.path);
				if (failed && isOpenProblemTool(fact.name)) {
					openErrors.set(key, {
						operation: operationLabel(fact.name, fact.path),
						error: firstErrorLine(resultText),
						lastTouch: i,
					});
				} else if (!failed) {
					openErrors.delete(key);
				}

				const pendingPos = pendingByOrder.indexOf(matchedIndex);
				if (pendingPos >= 0) {
					pendingByOrder.splice(pendingPos, 1);
				}
				if (toolCallId) {
					const bucket = pendingById.get(toolCallId);
					if (bucket) {
						const pos = bucket.indexOf(matchedIndex);
						if (pos >= 0) {
							bucket.splice(pos, 1);
						}
						if (bucket.length === 0) {
							pendingById.delete(toolCallId);
						}
					}
				}
			}
		}
	}

	for (const action of actionFacts) {
		if (isHarnessPlumbingTarget(action.path)) {
			continue;
		}
		if (action.resolved && action.failed && action.name !== "bash") {
			continue;
		}
		if ((!action.resolved || !action.failed) && action.finalKind && action.path && !filesByPath.has(action.path)) {
			filesByPath.set(action.path, {
				path: action.path,
				kind: action.finalKind,
				note: action.verb,
				lastTouch: actionFacts.indexOf(action),
			});
		}

		actions.push(`${action.verb} ${action.path ?? "(unknown)"}`);
	}

	for (const file of filesByPath.values()) {
		if (!file.note && filesNotes.has(file.path)) {
			continue;
		}
		if (file.note && filesNotes.get(file.path) === file.note) {
			continue;
		}
		if (file.note) {
			filesNotes.set(file.path, file.note);
		}
	}

	for (const file of filesByPath.values()) {
		const suffix = filesNotes.get(file.path);
		if (suffix) {
			file.note = suffix;
		}
	}

	const files = Array.from(filesByPath.values())
		.sort(
			(a, b) =>
				b.lastTouch - a.lastTouch ||
				FILE_KIND_PRIORITY[b.kind] - FILE_KIND_PRIORITY[a.kind] ||
				a.path.localeCompare(b.path),
		)
		.map(({ lastTouch: _lastTouch, ...file }) => file);

	return {
		files,
		workingSet: files.slice(0, MAX_WORKING_SET_FILES),
		actions: dedupeMostRecent(actions).slice(-MAX_ACTIONS),
		errorFacts: Array.from(openErrors.values())
			.sort((a, b) => a.lastTouch - b.lastTouch)
			.slice(-MAX_ERROR_FACTS)
			.map(({ lastTouch: _lastTouch, ...error }) => error),
		prohibitions: prohibitions.slice(-MAX_PROHIBITIONS),
		cancelledText: cancelledParts.join("\n"),
		activeTaskSource,
	};
}

function dedupeMostRecent(values: string[]): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (let i = values.length - 1; i >= 0; i--) {
		const value = values[i];
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		kept.push(value);
	}
	return kept.reverse();
}

export function renderFactsBlock(facts: CompactionFacts): string {
	const lines: string[] = ["verification demands:"];
	lines.push("files-modified-recall (must appear in ## Files):");
	for (const file of facts.files.filter((file) => file.kind !== "read")) {
		lines.push(file.path);
	}
	lines.push("files-read-recall (must appear in ## Files, containment threshold applies):");
	for (const file of facts.files.filter((file) => file.kind === "read")) {
		lines.push(file.path);
	}
	lines.push("working-set-recall (must appear in ## Working Set):");
	for (const file of facts.workingSet) {
		lines.push(`${file.path} — ${file.note || file.kind}`);
	}
	lines.push("open-errors-recall (must appear in ## Open Problems):");
	for (const error of facts.errorFacts) {
		lines.push(`${error.operation}: ${error.error}`);
	}
	lines.push("actions-recall (must appear in ## Done):");
	for (const action of facts.actions) {
		lines.push(action);
	}
	lines.push("mandatory-rules-recall (must appear in ### Mandatory Rules):");
	for (const prohibition of facts.prohibitions) {
		lines.push(prohibition);
	}
	// The active-task gate demands near-verbatim recall of this text, but the conversation the
	// summarizer sees may be pre-digested or truncated — the facts block is the one channel
	// guaranteed to reach the prompt, so the gated text must ride in it (bounded).
	lines.push("active-task-containment (must appear in ## Active Task):");
	if (facts.activeTaskSource) {
		lines.push(clampText(facts.activeTaskSource, ACTIVE_TASK_SOURCE_MAX_CHARS));
	}
	lines.push("cancelled-work-dropped (must NOT appear outside ### Mandatory Rules):");
	if (facts.cancelledText) {
		lines.push(facts.cancelledText);
	}
	return lines.join("\n");
}
