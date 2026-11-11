/**
 * Keeps an oversized delegation brief out of the tool-call arguments: the harness spills the full text
 * to a per-run file and leaves a pointer the worker can read, so a long brief arrives intact instead of
 * being refused by a schema cap it never saw.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { getProcessWorkRun } from "../../utils/work-directory.ts";
import { getScopedToolStreamsDirectory } from "../tools/persisted-output-mask.ts";

/** The `start` brief cap the schema enforces, after path aliases have been expanded. */
const INSTRUCTIONS_MAX_CHARS = 16_384;
/** The `follow_up` / `send` / `broadcast` message cap the schema enforces. */
const MESSAGE_MAX_CHARS = 4_096;
/** Beyond this a "brief" is a data file, not a brief: refuse to spill it rather than page megabytes into a worker. */
const SPILL_MAX_CHARS = 262_144;
const PREVIEW_LINE_MAX_CHARS = 120;

const MESSAGE_ACTIONS: ReadonlySet<string> = new Set(["follow_up", "send", "broadcast", "reply"]);

/** The directory spilled briefs belong to: the session's tool-streams run, else this process's outputs run. */
function briefDirectory(): string {
	return getScopedToolStreamsDirectory() ?? getProcessWorkRun(getAgentDir(), "outputs", "tool-streams").path;
}

/** First line that carries words, bounded, so the pointer still says what the work is. */
function firstPreviewLine(text: string): string {
	const headerOnly = /^(?:#+\s*)?(?:task|goal|objective|instructions|context)\s*:?\s*$/i;
	const line = text
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0 && !headerOnly.test(candidate));
	if (!line) return "";
	return line.length > PREVIEW_LINE_MAX_CHARS ? `${line.slice(0, PREVIEW_LINE_MAX_CHARS - 1)}…` : line;
}

function spillReference(text: string): string {
	const directory = briefDirectory();
	const path = join(
		directory,
		`delegate-brief-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}.md`,
	);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, { mode: 0o600, encoding: "utf8" });
	return `${firstPreviewLine(text)}\n\nComplete brief (${text.length} chars) saved by harness to ${path}.\nRead ${path} in full first and execute every requirement in it verbatim.`;
}

/** Replaces an over-cap brief with a spill file pointer; every other field is returned untouched. */
function spillField(input: Record<string, unknown>, field: "instructions" | "message", maxChars: number): unknown {
	const raw = input[field];
	if (typeof raw !== "string" || raw.length <= maxChars || raw.length > SPILL_MAX_CHARS) return input;
	return { ...input, [field]: spillReference(raw) };
}

/**
 * The `prepareArguments` seam for `delegate`: fold the flat `task` onto the field its action reads, then
 * spill any brief that would fail validation for length alone. Runs before Ajv, so the caps it enforces
 * are the ones a model actually meets.
 */
export function prepareDelegateArguments(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	const action = typeof input.action === "string" ? input.action : "start";

	if (action === "start") {
		let current = input;
		if (typeof input.task === "string" && input.task.trim().length > 0) {
			if (typeof input.instructions !== "string") {
				const { task, ...rest } = input;
				current = { ...rest, instructions: task };
			} else if (input.task.length > 3500) {
				const { task, ...rest } = input;
				current = {
					...rest,
					instructions: input.instructions.trim() ? `${task.trim()}\n\n${input.instructions}` : task,
				};
			}
		}
		const spilled = spillField(current, "instructions", INSTRUCTIONS_MAX_CHARS) as Record<string, unknown>;
		const slices = spilled.slices;
		if (!Array.isArray(slices)) return spilled;
		return {
			...spilled,
			slices: slices.map((slice) =>
				slice && typeof slice === "object" && !Array.isArray(slice)
					? spillField(slice as Record<string, unknown>, "instructions", INSTRUCTIONS_MAX_CHARS)
					: slice,
			),
		};
	}

	if (!MESSAGE_ACTIONS.has(action)) return input;
	let current = input;
	if (
		(action === "follow_up" || action === "send") &&
		typeof input.task === "string" &&
		input.task.trim().length > 0 &&
		typeof input.message !== "string"
	) {
		const { task, ...rest } = input;
		current = { ...rest, message: task };
	}
	return spillField(current, "message", MESSAGE_MAX_CHARS);
}
