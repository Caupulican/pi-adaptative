import { textContentPrefix } from "../context/message-text.ts";

const SESSION_PATH_MARKER = "/.pi/agent/sessions/";
const MAX_USER_CHARS = 400;
const MAX_ASSISTANT_CHARS = 240;

export function isPiSessionJsonlPath(absolutePath: string): boolean {
	const posix = absolutePath.split("\\").join("/");
	return posix.includes(SESSION_PATH_MARKER) && posix.endsWith(".jsonl");
}

function clip(text: string, maxChars: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	return `${compact.slice(0, maxChars - 1)}…`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return textContentPrefix(content);
}

function toolNamesFromContent(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "toolCall" &&
			"name" in block &&
			typeof block.name === "string"
		) {
			names.push(block.name);
		}
	}
	return names;
}

function failureCodeFromText(text: string): string | undefined {
	const match = /"failure_code"\s*:\s*"([^"]+)"/.exec(text);
	return match?.[1];
}

/** Project one Pi session JSONL entry to user/assistant/tool labels. Thinking and payloads are omitted. */
export function projectPiSessionJsonlLine(line: string): string {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return "";
	}
	if (!entry || typeof entry !== "object") return "";
	const raw = entry as Record<string, unknown>;
	const message =
		raw.type === "message" && raw.message && typeof raw.message === "object"
			? (raw.message as Record<string, unknown>)
			: raw;
	const role = message.role ?? raw.type;
	if (role === "user") {
		const text = textFromContent(message.content);
		return text ? `USER ${clip(text, MAX_USER_CHARS)}` : "";
	}
	if (role === "assistant") {
		const parts: string[] = [];
		const text = textFromContent(message.content);
		if (text) parts.push(`ASSISTANT ${clip(text, MAX_ASSISTANT_CHARS)}`);
		for (const name of toolNamesFromContent(message.content)) parts.push(`TOOL ${name}`);
		if (message.stopReason === "error") parts.push("ASSISTANT_ERROR");
		return parts.join(" | ");
	}
	if (role === "toolResult") {
		if (!message.isError) return "";
		const name = typeof message.toolName === "string" ? message.toolName : "tool";
		const text = textFromContent(message.content);
		return `TOOLERR ${name} ${failureCodeFromText(text) ?? clip(text, 160)}`;
	}
	return "";
}
