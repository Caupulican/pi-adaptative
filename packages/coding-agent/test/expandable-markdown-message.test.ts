import { beforeAll, describe, expect, it } from "vitest";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { ExpandableMarkdownMessageComponent } from "../src/modes/interactive/components/expandable-markdown-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function rendered(component: ExpandableMarkdownMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("expandable markdown messages", () => {
	beforeAll(() => initTheme("dark"));

	it("owns the shared expansion lifecycle for branch, compaction, and skill messages", () => {
		const branch = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "branch details",
			fromId: "entry-1",
			timestamp: 1,
		});
		const compaction = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "compaction details",
			tokensBefore: 12_345,
			timestamp: 1,
		});
		const skill = new SkillInvocationMessageComponent({
			name: "audit",
			location: "/skills/audit/SKILL.md",
			content: "skill details",
			userMessage: undefined,
		});

		for (const component of [branch, compaction, skill]) {
			expect(component).toBeInstanceOf(ExpandableMarkdownMessageComponent);
			expect(rendered(component)).toContain("to expand");
			component.setExpanded(true);
			expect(rendered(component)).not.toContain("to expand");
		}
		expect(rendered(branch)).toContain("branch details");
		expect(rendered(compaction)).toContain("12,345 tokens");
		expect(rendered(skill)).toContain("skill details");
	});

	it("materializes a large expanded payload once and only when expansion needs it", () => {
		let materializations = 0;
		const component = new ExpandableMarkdownMessageComponent(
			{
				label: "lazy",
				expandedMarkdown: () => {
					materializations++;
					return ["**Details**\n\n", "x".repeat(64 * 1024)].join("");
				},
				collapsedSegments: [{ text: "collapsed", color: "customMessageText" }],
				separateBody: true,
			},
			getMarkdownTheme(),
		);

		expect(materializations).toBe(0);
		component.render(120);
		component.invalidate();
		expect(materializations).toBe(0);

		component.setExpanded(true);
		expect(materializations).toBe(1);
		component.invalidate();
		component.render(120);
		expect(materializations).toBe(1);
	});
});
