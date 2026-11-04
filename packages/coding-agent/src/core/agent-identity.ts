import { existsSync, readFileSync } from "node:fs";
import { configFile } from "./agent-paths.ts";
import { scanContextFileThreats, stripInvisibleUnicode } from "./security/context-threat-scanner.ts";

/** Name the agent uses when `<agentDir>/soul.md` is absent or names nobody. */
export const DEFAULT_AGENT_NAME = "Pi-Adaptative";
export const SOUL_FILE_NAME = "soul.md";
const MAX_AGENT_NAME_CHARS = 64;
/** The soul rides in every request, so its text is bounded; the file stays readable for the rest. */
export const MAX_SOUL_CHARS = 2_000;

function cleanName(value: string): string | undefined {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f"]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_AGENT_NAME_CHARS)
		.trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * The agent's name from the text of `soul.md`: a front matter `name:` field, otherwise the first `# `
 * heading. The name is a single line without quotes because the system prompt states it in quotes.
 */
export function parseAgentName(markdown: string): string | undefined {
	const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const frontMatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
	if (frontMatter) {
		const field = /^name:\s*(.+)$/m.exec(frontMatter[1]);
		if (field) return cleanName(field[1]);
	}
	const heading = /^#[ \t]+(.+)$/m.exec(frontMatter ? text.slice(frontMatter[0].length) : text);
	return heading ? cleanName(heading[1]) : undefined;
}

export interface AgentIdentity {
	readonly name: string;
	/**
	 * The soul text that opens the prompt under the first line: the file without its front matter and
	 * name heading, scanned for injection and bounded. Absent when the file has no body.
	 */
	readonly soul?: string;
	/** Where `soul.md` belongs, set only while it does not exist so the agent can write it. */
	readonly missingSoulPath?: string;
}

/** The body of `soul.md`: everything after the front matter and the name heading. */
export function parseSoulBody(markdown: string): string {
	const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const withoutFrontMatter = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
	return withoutFrontMatter.replace(/^\s*#[ \t]+.*(?:\n|$)/, "").trim();
}

/**
 * Renders a soul body for the prompt. The file is agent-writable, so it is screened like any context file
 * before it becomes standing instructions: a threat finding replaces it with a notice naming the findings,
 * and an over-long body is cut with a marker that names the file to read for the rest.
 */
export function renderSoul(body: string, file: string): string | undefined {
	const { cleaned } = stripInvisibleUnicode(body);
	if (cleaned.length === 0) return undefined;
	const findings = scanContextFileThreats(cleaned);
	if (findings.length > 0) {
		return `[soul.md was not loaded: it matched the threat scan (${findings.join(", ")}). Ask the owner to review ${file}.]`;
	}
	if (cleaned.length <= MAX_SOUL_CHARS) return cleaned;
	return `${cleaned.slice(0, MAX_SOUL_CHARS)}\n[soul.md truncated at ${MAX_SOUL_CHARS} of ${cleaned.length} characters: read ${file} for the rest.]`;
}

/**
 * The agent's identity from `<agentDir>/soul.md`. An absent file is the default name plus the path the agent
 * may write the file to; a file without a name is the default name; an unreadable file is an error.
 */
export function readAgentIdentity(agentDir: string): AgentIdentity {
	const file = configFile(agentDir, SOUL_FILE_NAME);
	if (!existsSync(file)) return { name: DEFAULT_AGENT_NAME, missingSoulPath: file };
	const markdown = readFileSync(file, "utf8");
	const soul = renderSoul(parseSoulBody(markdown), file);
	return { name: parseAgentName(markdown) ?? DEFAULT_AGENT_NAME, ...(soul ? { soul } : {}) };
}
