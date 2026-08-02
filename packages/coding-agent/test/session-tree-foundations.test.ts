import { readFileSync } from "node:fs";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import {
	buildSessionTree,
	buildTreePrefix,
	extractTextContent,
	flattenSessionTree,
	formatTreeToolCall,
	recalculateVisibleTreeLayout,
} from "../src/core/export-html/session-tree-foundations.mjs";
import { parseSkillBlock } from "../src/core/skill-block.mjs";

function entry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		customType: "test",
		data: {},
	};
}

describe("session tree foundations", () => {
	it("owns active-first flattening and filtered connector layout", () => {
		const entries = [
			entry("root", null),
			entry("old", "root"),
			entry("old-leaf", "old"),
			entry("active", "root"),
			entry("active-middle", "active"),
			entry("active-leaf", "active-middle"),
		];
		const roots = buildSessionTree(entries, () => undefined);
		const flat = flattenSessionTree(roots, new Set(["root", "active", "active-middle", "active-leaf"]));

		expect(flat.map((item) => item.node.entry.id)).toEqual([
			"root",
			"active",
			"active-middle",
			"active-leaf",
			"old",
			"old-leaf",
		]);
		expect(buildTreePrefix(flat[1])).toBe("├─ ");
		expect(buildTreePrefix(flat[4])).toBe("└─ ");

		const visible = flat.filter((item) => item.node.entry.id !== "active-middle");
		const layout = recalculateVisibleTreeLayout(visible, flat);
		expect(layout.visibleParent.get("active-leaf")).toBe("active");
		expect(layout.visibleChildren.get("active")).toEqual(["active-leaf"]);
		expect(buildTreePrefix(visible.find((item) => item.node.entry.id === "active-leaf")!)).toBe("│     ");
	});

	it("keeps text extraction bounded and joins immutable fragments once", () => {
		const first = "a".repeat(150);
		const second = "b".repeat(150);
		expect(
			extractTextContent(
				[
					{ type: "text", text: first },
					{ type: "image", data: "ignored" },
					{ type: "text", text: second },
				],
				200,
			),
		).toBe(first + "b".repeat(50));
		expect(extractTextContent([{ type: "text", text: "full" }])).toBe("full");
		expect(extractTextContent({ type: "text", text: "not-an-array" })).toBe("");
	});

	it("formats custom tool arguments with one serialization pass", () => {
		let reads = 0;
		const args = {
			get value() {
				reads++;
				return "x".repeat(80);
			},
		};
		expect(formatTreeToolCall("custom", args, (path) => path)).toBe(`[custom: {"value":"${"x".repeat(30)}...]`);
		expect(reads).toBe(1);
	});

	it("routes both renderers through one layout owner", () => {
		const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
		const selector = readFileSync(
			new URL("../src/modes/interactive/components/tree-selector.ts", import.meta.url),
			"utf8",
		);
		expect(template).not.toMatch(
			/function (?:flattenTree|recalculateVisualStructure|buildTreePrefix|formatToolCall)\s*\(/,
		);
		expect(selector).not.toMatch(/private (?:flattenTree|recalculateVisualStructure|formatToolCall)\s*\(/);
		expect(selector).toContain('from "../../../core/export-html/session-tree-foundations.mjs"');
	});
});

describe("skill block parser", () => {
	it("parses the exact wrapper and preserves user-visible fields", () => {
		expect(
			parseSkillBlock('<skill name="audit" location="/skills/audit/SKILL.md">\n# Audit\n</skill>\n\nrun it'),
		).toEqual({
			name: "audit",
			location: "/skills/audit/SKILL.md",
			content: "# Audit",
			userMessage: "run it",
		});
	});

	it("skips false closing markers and rejects malformed near-matches", () => {
		const validAfterFalseClose =
			'<skill name="audit" location="skill.md">\nfirst\n</skill>not-a-suffix\nsecond\n</skill>\n\n  run  ';
		expect(parseSkillBlock(validAfterFalseClose)).toEqual({
			name: "audit",
			location: "skill.md",
			content: "first\n</skill>not-a-suffix\nsecond",
			userMessage: "run",
		});
		expect(parseSkillBlock('<skill name="" location="skill.md">\nbody\n</skill>')).toBeNull();
		expect(parseSkillBlock('<skill name="audit" location="skill.md">\nbody\n</skill>\n\n')).toBeNull();
		expect(parseSkillBlock("ordinary user text")).toBeNull();
	});

	it("has one parser owner and no accumulated-prefix implementation", () => {
		const parser = readFileSync(new URL("../src/core/skill-block.mjs", import.meta.url), "utf8");
		const contracts = readFileSync(new URL("../src/core/agent-session-contracts.ts", import.meta.url), "utf8");
		const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");
		expect(parser).not.toMatch(/\.match\(|new RegExp|\+=/);
		expect(contracts).not.toMatch(/function parseSkillBlock\s*\(/);
		expect(template).not.toMatch(/function parseSkillBlock\s*\(/);
	});
});
