import { existsSync, readFileSync } from "node:fs";
import { configFile } from "./agent-paths.ts";

/** Name the agent uses when `<agentDir>/soul.md` is absent or names nobody. */
export const DEFAULT_AGENT_NAME = "Pi-Adaptative";
export const SOUL_FILE_NAME = "soul.md";
const MAX_AGENT_NAME_CHARS = 64;

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
	/** Where `soul.md` belongs, set only while it does not exist so the agent can write it. */
	readonly missingSoulPath?: string;
}

/**
 * The agent's identity from `<agentDir>/soul.md`. An absent file is the default name plus the path the agent
 * may write the file to; a file without a name is the default name; an unreadable file is an error.
 */
export function readAgentIdentity(agentDir: string): AgentIdentity {
	const file = configFile(agentDir, SOUL_FILE_NAME);
	if (!existsSync(file)) return { name: DEFAULT_AGENT_NAME, missingSoulPath: file };
	return { name: parseAgentName(readFileSync(file, "utf8")) ?? DEFAULT_AGENT_NAME };
}
