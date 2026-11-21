import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isThinkingLevel } from "../src/core/settings/settings-rules.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { VALID_THINKING_LEVELS } from "../src/core/thinking-level.ts";

it("loads every settings thinking level as a skill hint and ignores invalid hints", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-skill-thinking-"));
	try {
		const values = [...VALID_THINKING_LEVELS, "unsupported", 7];
		for (const [index, value] of values.entries()) {
			writeFileSync(
				join(dir, `level-${index}.md`),
				`---\nname: level-${index}\ndescription: Read a skill hint\nthinking: ${JSON.stringify(value)}\n---\nBody\n`,
			);
		}
		const result = loadSkillsFromDir({ dir, source: "project" });
		expect(result.diagnostics).toEqual([]);
		const loaded = new Map(result.skills.map((skill) => [skill.name, skill.thinking]));
		expect(loaded.size).toBe(values.length);
		for (const [index, value] of values.entries()) {
			const supported = index < VALID_THINKING_LEVELS.length;
			expect(isThinkingLevel(value)).toBe(supported);
			expect(loaded.get(`level-${index}`)).toBe(supported ? value : undefined);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
