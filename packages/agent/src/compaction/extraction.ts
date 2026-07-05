import type { SessionEntry } from "../session/session-manager.ts";
import type { AgentMessage } from "../types.ts";

export interface CompactionFacts {
	files: Array<{ path: string; kind: "modified" | "created" | "read"; note: string }>;
	actions: string[];
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
	outcome: string;
	resolved: boolean;
}

const PROHIBITION_PATTERN = /\b(do not|don't|never|stop (?:doing|using|changing)|no more)\b/i;
const REVERSAL_PATTERN = /\b(stop|undo|revert|roll back|never mind|scrap that|forget (?:it|that))\b/i;

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

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return "";
}

function firstOutcome(message: AgentMessage): string {
	if (message.role !== "toolResult") {
		return "";
	}
	return firstLine(messageToText(message));
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
		.split(/[.!?\n]+/)
		.map((line) => line.trim())
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

export function extractCompactionFacts(entries: SessionEntry[], start: number, end: number): CompactionFacts {
	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.min(entries.length, Math.max(rangeStart, end));

	if (rangeStart >= rangeEnd) {
		return { files: [], actions: [], prohibitions: [], cancelledText: "", activeTaskSource: "" };
	}

	const filesByPath = new Map<string, { path: string; kind: "modified" | "created" | "read"; note: string }>();
	const filesNotes = new Map<string, string>();
	const seenProhibitions = new Set<string>();
	const actionFacts: ToolCallFact[] = [];
	const pendingById = new Map<string, number[]>();
	const pendingByOrder: number[] = [];

	const actions: string[] = [];
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
				activeTaskSource = userText;
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
					outcome: "",
					resolved: false,
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
				const outcome = firstOutcome(message);
				fact.outcome = outcome;
				fact.resolved = true;
				if (fact.baseKind === "modified" && appearsCreated(message)) {
					fact.finalKind = "created";
				}

				const finalOutcome = clampText(fact.outcome, 80);
				fact.outcome = finalOutcome;
				if (fact.path && fact.finalKind) {
					const existing = filesByPath.get(fact.path);
					const nextKind = fact.finalKind;
					const note = fact.verb;
					if (!existing || FILE_KIND_PRIORITY[nextKind] > FILE_KIND_PRIORITY[existing.kind]) {
						filesByPath.set(fact.path, { path: fact.path, kind: nextKind, note });
					} else if (existing.kind === nextKind) {
						existing.note = `${note}: ${finalOutcome}`;
					}
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
		if (action.finalKind && action.path && !filesByPath.has(action.path)) {
			const note = action.outcome ? `${action.verb}: ${action.outcome}` : action.verb;
			filesByPath.set(action.path, { path: action.path, kind: action.finalKind, note });
		}

		actions.push(`${action.verb} ${action.path ?? "(unknown)"} — ${action.outcome}`);
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

	return {
		files: Array.from(filesByPath.values()).sort((a, b) => {
			if (a.path === b.path) {
				return FILE_KIND_PRIORITY[a.kind] - FILE_KIND_PRIORITY[b.kind];
			}
			return a.path.localeCompare(b.path);
		}),
		actions,
		prohibitions,
		cancelledText: cancelledParts.join("\n"),
		activeTaskSource,
	};
}

export function renderFactsBlock(facts: CompactionFacts): string {
	const lines: string[] = ["files:"];
	for (const file of facts.files) {
		lines.push(`${file.kind}: ${file.path} — ${file.note}`);
	}
	lines.push("actions:");
	for (const action of facts.actions) {
		lines.push(action);
	}
	lines.push("prohibitions:");
	for (const prohibition of facts.prohibitions) {
		lines.push(prohibition);
	}
	return lines.join("\n");
}
