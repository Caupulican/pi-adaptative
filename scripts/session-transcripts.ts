#!/usr/bin/env node
/**
 * Extracts session transcripts for a given cwd, splits into context-sized files,
 * optionally spawns subagents to analyze patterns.
 *
 * Usage: node scripts/session-transcripts.ts [--analyze] [--output <dir>] [cwd]
 *   --analyze      Spawn pi subagents to analyze each transcript file
 *   --output <dir> Output directory for transcript files (defaults to ./session-transcripts)
 *   cwd            Working directory to extract sessions for (defaults to current)
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { createInterface } from "node:readline";
import { homedir } from "os";
import { join, resolve } from "path";
import { parseSessionEntries, type SessionMessageEntry } from "../packages/coding-agent/src/core/session-manager.ts";
import chalk from "chalk";
import { writeTranscriptShards } from "./lib/transcript-shards.ts";

const MAX_CHARS_PER_FILE = 100_000; // ~20k tokens, leaving room for prompt + analysis + output

function cwdToSessionDir(cwd: string): string {
	const normalized = resolve(cwd).replace(/\//g, "-");
	return `--${normalized.slice(1)}--`; // Remove leading slash, wrap with --
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

function parseSession(filePath: string): string[] {
	const content = readFileSync(filePath, "utf8");
	const entries = parseSessionEntries(content);
	const messages: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const { role, content } = msgEntry.message;

		if (role !== "user" && role !== "assistant") continue;

		const text = extractTextContent(content as string | Array<{ type: string; text?: string }>);
		if (!text.trim()) continue;

		messages.push(`[${role.toUpperCase()}]\n${text}`);
	}

	return messages;
}

const MAX_DISPLAY_WIDTH = 100;
const MAX_DISPLAY_BUFFER_CHARS = MAX_DISPLAY_WIDTH * 4;

function truncateLine(text: string, maxWidth: number): string {
	const singleLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxWidth) return singleLine;
	return singleLine.slice(0, maxWidth - 3) + "...";
}

interface JsonEvent {
	type: string;
	assistantMessageEvent?: { type: string; delta?: string };
	toolName?: string;
	args?: {
		path?: string;
		offset?: number;
		limit?: number;
		content?: string;
	};
}

function runSubagent(prompt: string, cwd: string): Promise<{ success: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("pi", ["--mode", "json", "--tools", "read,write", "-p", prompt], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const textParts: string[] = [];
		let textChars = 0;
		const appendText = (delta: string) => {
			const remaining = MAX_DISPLAY_BUFFER_CHARS - textChars;
			if (remaining <= 0) return;
			const part = delta.length <= remaining ? delta : delta.slice(0, remaining);
			textParts.push(part);
			textChars += part.length;
		};
		const printText = () => {
			if (textChars > 0) {
				const text = textParts.join("");
				if (text.trim()) console.log(chalk.dim("  " + truncateLine(text, MAX_DISPLAY_WIDTH)));
			}
			textParts.length = 0;
			textChars = 0;
		};

		const rl = createInterface({ input: child.stdout });

		rl.on("line", (line) => {
			try {
				const event: JsonEvent = JSON.parse(line);

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const msgEvent = event.assistantMessageEvent;
					if (msgEvent.type === "text_delta" && msgEvent.delta) {
						appendText(msgEvent.delta);
					}
				} else if (event.type === "tool_execution_start" && event.toolName) {
					printText();
					// Format tool call with args
					let argsStr = "";
					if (event.args) {
						if (event.toolName === "read") {
							argsStr = event.args.path || "";
							if (event.args.offset) argsStr += ` offset=${event.args.offset}`;
							if (event.args.limit) argsStr += ` limit=${event.args.limit}`;
						} else if (event.toolName === "write") {
							argsStr = event.args.path || "";
						}
					}
					console.log(chalk.cyan(`  [${event.toolName}] ${argsStr}`));
				} else if (event.type === "turn_end") {
					printText();
				}
			} catch {
				// Ignore malformed JSON
			}
		});

		child.stderr.on("data", (data) => {
			process.stderr.write(chalk.red(data.toString()));
		});

		child.on("close", (code) => {
			resolve({ success: code === 0 });
		});

		child.on("error", (err) => {
			console.error(chalk.red(`  Failed to spawn pi: ${err.message}`));
			resolve({ success: false });
		});
	});
}

async function main() {
	const args = process.argv.slice(2);
	const analyzeFlag = args.includes("--analyze");

	// Parse --output <dir>
	const outputIdx = args.indexOf("--output");
	let outputDir = resolve("./session-transcripts");
	if (outputIdx !== -1 && args[outputIdx + 1]) {
		outputDir = resolve(args[outputIdx + 1]);
	}

	// Find cwd (positional arg that's not a flag or flag value)
	const flagIndices = new Set<number>();
	flagIndices.add(args.indexOf("--analyze"));
	if (outputIdx !== -1) {
		flagIndices.add(outputIdx);
		flagIndices.add(outputIdx + 1);
	}
	const cwdArg = args.find((a, i) => !flagIndices.has(i) && !a.startsWith("--"));
	const cwd = resolve(cwdArg || process.cwd());

	mkdirSync(outputDir, { recursive: true });
	const sessionsBase = join(homedir(), ".pi/agent/sessions");
	const sessionDirName = cwdToSessionDir(cwd);
	const sessionDir = join(sessionsBase, sessionDirName);

	if (!existsSync(sessionDir)) {
		console.error(`No sessions found for ${cwd}`);
		console.error(`Expected: ${sessionDir}`);
		process.exit(1);
	}

	const sessionFiles = readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();

	console.log(`Found ${sessionFiles.length} session files in ${sessionDir}`);

	function* transcripts(): Generator<string> {
		for (const file of sessionFiles) {
			const messages = parseSession(join(sessionDir, file));
			if (messages.length > 0) yield `=== SESSION: ${file} ===\n${messages.join("\n---\n")}\n=== END SESSION ===`;
		}
	}
	const shards = writeTranscriptShards(transcripts(), {
		outputDir,
		maxChars: MAX_CHARS_PER_FILE,
		onWrite: ({ name, chars, oversized }) => {
			const line = `Wrote ${name} (${chars} chars)${oversized ? " - oversized" : ""}`;
			console.log(oversized ? chalk.yellow(line) : line);
		},
	});
	if (shards.transcripts === 0) {
		console.error("No transcripts found");
		process.exit(1);
	}
	const outputFiles = shards.files.map((file) => file.name);

	console.log(`\nCreated ${outputFiles.length} transcript file(s) in ${outputDir}`);

	if (!analyzeFlag) {
		console.log("\nRun with --analyze to spawn pi subagents for pattern analysis.");
		return;
	}

	// Find AGENTS.md files to compare against
	const globalAgentsMd = join(homedir(), ".pi/agent/AGENTS.md");
	const localAgentsMd = join(cwd, "AGENTS.md");
	const agentsMdFiles = [globalAgentsMd, localAgentsMd].filter(existsSync);
	const agentsMdSection =
		agentsMdFiles.length > 0
			? `STEP 1: Read the existing AGENTS.md file(s) to see what's already encoded:\n${agentsMdFiles.join("\n")}\n\nSTEP 2: `
			: "";

	// Spawn subagents to analyze each file
	const analysisPrompt = `You are analyzing session transcripts to identify recurring user instructions that could be automated.

${agentsMdSection}READING THE TRANSCRIPT:
The transcript file is large. Read it in chunks of 1000 lines using offset/limit parameters:
1. First: read with limit=1000 (lines 1-1000)
2. Then: read with offset=1001, limit=1000 (lines 1001-2000)
3. Continue incrementing offset by 1000 until you reach the end
4. Only after reading the ENTIRE file, perform the analysis and write the summary

ANALYSIS TASK:
Look for patterns where the user repeatedly gives similar instructions. These could become:
- AGENTS.md entries: coding style rules, behavior guidelines, project conventions
- Skills: multi-step workflows with external tools (search, browser, APIs)
- Prompt templates: reusable prompts for common tasks

Compare each pattern against the existing AGENTS.md content to determine if it's NEW or EXISTING.

OUTPUT FORMAT (strict):
Write a file with exactly this structure. Use --- as separator between patterns.

PATTERN: <short descriptive name>
STATUS: NEW | EXISTING
TYPE: agents-md | skill | prompt-template
FREQUENCY: <number of times observed>
EVIDENCE:
- "<exact quote 1>"
- "<exact quote 2>"
- "<exact quote 3>"
DRAFT:
<proposed content for AGENTS.md entry, SKILL.md, or prompt template>
---

Rules:
- Only include patterns that appear 2+ times
- STATUS is NEW if not in AGENTS.md, EXISTING if already covered
- EVIDENCE must contain exact quotes from the transcripts
- DRAFT must be ready-to-use content
- If no patterns found, write "NO PATTERNS FOUND"
- Do not include any other text outside this format`;

	console.log("\nSpawning subagents for analysis...");
	for (const shard of shards.files) {
		const summaryFile = shard.name.replace(".txt", ".summary.txt");
		const filePath = join(outputDir, shard.name);
		const summaryPath = join(outputDir, summaryFile);

		console.log(`Analyzing ${shard.name} (${shard.chars} chars)...`);

		const fullPrompt = `${analysisPrompt}\n\nThe file ${filePath} has ${shard.lines} lines. Read it in full using chunked reads, then write your analysis to ${summaryPath}`;

		const result = await runSubagent(fullPrompt, outputDir);

		if (result.success && existsSync(summaryPath)) {
			console.log(chalk.green(`  -> ${summaryFile}`));
		} else if (result.success) {
			console.error(chalk.yellow(`  Agent finished but did not write ${summaryFile}`));
		} else {
			console.error(chalk.red(`  Failed to analyze ${shard.name}`));
		}
	}

	// Collect all created summary files
	const summaryFiles = readdirSync(outputDir)
		.filter((f) => f.endsWith(".summary.txt"))
		.sort();

	console.log(`\n=== Individual Analysis Complete ===`);
	console.log(`Created ${summaryFiles.length} summary files`);

	if (summaryFiles.length === 0) {
		console.log(chalk.yellow("No summary files created. Nothing to aggregate."));
		return;
	}

	// Final aggregation step
	console.log("\nAggregating findings into final summary...");

	const summaryPaths = summaryFiles.map((f) => join(outputDir, f)).join("\n");
	const finalSummaryPath = join(outputDir, "FINAL-SUMMARY.txt");

	const aggregationPrompt = `You are aggregating pattern analysis results from multiple summary files.

STEP 1: Read the existing AGENTS.md file(s) to understand what patterns are already encoded:
${agentsMdFiles.length > 0 ? agentsMdFiles.join("\n") : "(no AGENTS.md files found)"}

STEP 2: Read ALL of the following summary files:
${summaryPaths}

STEP 3: Create a consolidated final summary that:
1. Merges duplicate patterns (same pattern found in multiple files)
2. Ranks patterns by total frequency across all files
3. Groups by status (NEW first, then EXISTING) and type
4. Provides the best/most complete DRAFT for each unique pattern
5. Verify STATUS against AGENTS.md content (pattern may be marked NEW in summaries but actually exists)

OUTPUT FORMAT (strict):
Write the final summary with this structure:

# NEW PATTERNS (not yet in AGENTS.md)

## AGENTS.MD: <pattern name>
Total Frequency: <sum across all files>
Evidence:
- "<best quotes>"
Draft:
<consolidated draft>

## SKILL: <pattern name>
...

## PROMPT-TEMPLATE: <pattern name>
...

---

# EXISTING PATTERNS (already in AGENTS.md, for reference)

## <pattern name>
Total Frequency: <N>
Already covered by: <quote relevant section from AGENTS.md>

---

# SUMMARY
- New patterns to add: <N>
- Already covered: <N>
- Top 3 new patterns by frequency: <list>

Write the final summary to ${finalSummaryPath}`;

	const aggregateResult = await runSubagent(aggregationPrompt, outputDir);

	if (aggregateResult.success && existsSync(finalSummaryPath)) {
		console.log(chalk.green(`\n=== Final Summary Created ===`));
		console.log(chalk.green(`  ${finalSummaryPath}`));
	} else if (aggregateResult.success) {
		console.error(chalk.yellow(`Agent finished but did not write final summary`));
	} else {
		console.error(chalk.red(`Failed to create final summary`));
	}
}

main().catch(console.error);
