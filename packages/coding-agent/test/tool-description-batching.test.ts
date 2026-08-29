import { describe, expect, it } from "vitest";
import { createAskQuestionToolDefinition } from "../src/core/tools/ask-question.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const BATCHABLE_SENTENCE =
	"Batchable: emit alongside other independent calls in one message; never spend a turn per read.";

describe("tool description batching pins", () => {
	it("pins the identical Batchable sentence as the final sentence of read/grep/find/ls descriptions", () => {
		const cwd = process.cwd();
		const descriptions = [
			createReadToolDefinition(cwd).description,
			createGrepToolDefinition(cwd).description,
			createFindToolDefinition(cwd).description,
			createLsToolDefinition(cwd).description,
		];

		for (const description of descriptions) {
			expect(description.endsWith(BATCHABLE_SENTENCE)).toBe(true);
		}
	});

	it("pins edit's per-file batching guideline", () => {
		const { promptGuidelines } = createEditToolDefinition(process.cwd());
		expect(promptGuidelines?.join("\n")).toContain(
			"Call once per file with all its replacements; edits to different files may be emitted together in one message.",
		);
	});

	it("pins write's per-file batching guideline", () => {
		const { promptGuidelines } = createWriteToolDefinition(process.cwd());
		expect(promptGuidelines?.join("\n")).toContain(
			"Call once per file: path plus exactly one of content/contentRef; writes to different files may be emitted together in one message.",
		);
	});

	it("pins ask-question's solo-emission rule", () => {
		const { description } = createAskQuestionToolDefinition();
		expect(description).toContain("Emit alone: never combine with other tool calls in the same message.");
	});
});
