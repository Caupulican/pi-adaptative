import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorkerSkillAccess } from "../src/core/delegation/worker-skill-access.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import { loadSkillsFromDir, workerEligibleSkills } from "../src/core/skills.ts";

it("lets a delegated worker find and read the bundled comment audit skill", async () => {
	const { skills } = loadSkillsFromDir({
		dir: join(import.meta.dirname, "../src/bundled-resources/skills"),
		source: "bundled",
	});
	const parent = new SkillVaultController({ getSkills: () => skills });
	const worker = createWorkerSkillAccess(parent).getSkillReadBroker();
	const name = "delete-comment";

	expect(workerEligibleSkills(skills).some((skill) => skill.name === name)).toBe(true);
	expect((await worker.search(name)).candidates).toMatchObject([{ name }]);
	expect(worker.headers?.previewSkillHeaders()).toMatchObject([{ name }]);
	expect(parent.previewSkillHeaders()).toEqual([]);
	expect(worker.read(name)).toMatchObject({ ok: true, name, body: expect.stringMatching(/\S/) });
});
