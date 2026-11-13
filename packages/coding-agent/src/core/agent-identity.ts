import { existsSync, readFileSync } from "node:fs";
import { harnessLog } from "../kernel/harness-log.ts";
import { configFile } from "./agent-paths.ts";
import { scanContextFileThreats, stripInvisibleUnicode } from "./security/context-threat-scanner.ts";

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
	/**
	 * The soul text that opens the prompt under the first line: the file without its front matter and
	 * name heading, scanned for injection. Absent when the file has no body.
	 */
	readonly soul?: string;
	/** Where `soul.md` belongs, set only while it does not exist so the agent can write it. */
	readonly missingSoulPath?: string;
	/** An agent of its own (a persistent bot): the main agent's situational soul is not layered over it. */
	readonly standalone?: true;
}

/** The body of `soul.md`: everything after the front matter and the name heading. */
export function parseSoulBody(markdown: string): string {
	const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const withoutFrontMatter = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
	return withoutFrontMatter.replace(/^\s*#[ \t]+.*(?:\n|$)/, "").trim();
}

/** A soul text with invisible unicode removed, and the threat findings that make it unfit to become standing instructions. */
function screenSoulText(text: string): { cleaned: string; findings: string[] } {
	const { cleaned } = stripInvisibleUnicode(text);
	return { cleaned, findings: scanContextFileThreats(cleaned) };
}

/**
 * The identity a `soul.md` projects into the prompt. The file is agent-writable and both the name (the prompt's first
 * line) and the body become standing text, so the whole document is screened once, before either is read: invisible
 * unicode is removed, and a threat finding anywhere in it replaces the whole identity (default name included) with a
 * notice naming the findings. The soul has no size limit: it is expected to grow.
 */
export function projectAgentIdentity(markdown: string, file: string): AgentIdentity {
	const { cleaned, findings } = screenSoulText(markdown);
	if (findings.length > 0) {
		return {
			name: DEFAULT_AGENT_NAME,
			soul: `[soul.md was not loaded: it matched the threat scan (${findings.join(", ")}). Ask the owner to review ${file}.]`,
		};
	}
	const body = parseSoulBody(cleaned);
	return { name: parseAgentName(cleaned) ?? DEFAULT_AGENT_NAME, ...(body.length > 0 ? { soul: body } : {}) };
}

/** Owner words for the threat-scan labels a soul is screened for (the context scope); the labels stay in the debug log. */
const SOUL_THREAT_WORDS: Readonly<Record<string, string | undefined>> = {
	"instruction override": "an attempt to override the agent's instructions",
	"secret exfiltration": "an attempt to send out secrets",
	"hidden instruction": "an instruction to hide things from the owner",
	"role hijack": "an attempt to take over the agent's role",
	"system prompt leak": "an attempt to reveal the system prompt",
};

/**
 * Judges an owner-authored soul that will be stored and delivered whole (a persistent bot's): invisible unicode is
 * removed and the result trimmed, and the text is refused when it matches the threat scan. It has no size limit;
 * the worker contract and the model's prompt budget bound it where it is delivered. A soul that is empty after
 * trimming is accepted as `undefined`, which clears it.
 */
export function checkSoulText(text: string): { ok: true; soul: string | undefined } | { ok: false; reason: string } {
	const { cleaned, findings } = screenSoulText(text);
	const soul = cleaned.trim();
	if (findings.length > 0) {
		harnessLog.debug("ui", "a soul text was refused by the threat scan", () => ({ findings }));
		const kinds = findings.map((finding) => SOUL_THREAT_WORDS[finding] ?? "unsafe text");
		return { ok: false, reason: `the soul contains ${kinds.join("; ")}` };
	}
	return { ok: true, soul: soul.length > 0 ? soul : undefined };
}

/**
 * The identity of an agent that is not the main one (a persistent bot): its own name, the one the prompt quotes, and
 * its own soul. `fallbackName` names it when `name` has nothing printable. The soul is judged by {@link checkSoulText}
 * where it is stored, so it is taken as given.
 */
export function namedAgentIdentity(name: string, soul: string | undefined, fallbackName: string): AgentIdentity {
	return {
		name: cleanName(name) ?? cleanName(fallbackName) ?? DEFAULT_AGENT_NAME,
		...(soul ? { soul } : {}),
		standalone: true,
	};
}

/**
 * The agent's identity from `<agentDir>/soul.md`. An absent file is the default name plus the path the agent
 * may write the file to; a file without a name is the default name; an unreadable file is an error.
 */
export function readAgentIdentity(agentDir: string): AgentIdentity {
	const file = configFile(agentDir, SOUL_FILE_NAME);
	if (!existsSync(file)) return { name: DEFAULT_AGENT_NAME, missingSoulPath: file };
	return projectAgentIdentity(readFileSync(file, "utf8"), file);
}
