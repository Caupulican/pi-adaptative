import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { Context } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ProviderRequestCompactionDecision,
	ProviderRequestCompactionInput,
} from "../src/core/compaction-controller.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { createHarness, type Harness } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("provider request compaction integration", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("retains compacted history and active skill through the next text-phone tool turn", async () => {
		const resourceLoader = createTestResourceLoader();
		harness = createHarness({
			resourceLoader,
			responses: ['<pi:call name="skill">{"action":"status"}</pi:call>', "delivered"],
		});
		const skillsDir = join(harness.tempDir, "skills");
		const skillDir = join(skillsDir, "mandatory-recovery");
		mkdirSync(skillDir, { recursive: true });
		const bodyMarker = "MANDATORY-SKILL-BODY";
		const body = `${bodyMarker}\n${"x".repeat(3_000)}`;
		writeFileSync(
			join(skillDir, "SKILL.md"),
			["---", "name: mandatory-recovery", "description: Mandatory recovery workflow.", "---", "", body].join("\n"),
		);
		const skills = loadSkillsFromDir({ dir: skillsDir, source: "test" }).skills;
		resourceLoader.getSkills = () => ({ skills, diagnostics: [] });
		resourceLoader.getActiveSkills = () => skills;

		const internals = harness.session as unknown as {
			_skillVault: SkillVaultController;
			_compaction: {
				admitProviderRequest(input: ProviderRequestCompactionInput): Promise<ProviderRequestCompactionDecision>;
			};
		};
		expect(internals._skillVault.load("mandatory-recovery", "model")).toMatchObject({ ok: true });
		harness.agent.convertToLlm = convertToLlm;
		harness.agent.textToolCallProtocol = true;
		const sessionPlanContext = harness.agent.planContext?.bind(harness.agent);
		if (!sessionPlanContext) throw new Error("Expected session provider request planner");
		const plannedSkillPrompts: Array<string | undefined> = [];
		harness.agent.planContext = async (request, signal) => {
			const plan = await sessionPlanContext(request, signal);
			plannedSkillPrompts.push(plan.transientSystemPrompt);
			return plan;
		};

		const admissions: ProviderRequestCompactionInput[] = [];
		let compacted = false;
		vi.spyOn(internals._compaction, "admitProviderRequest").mockImplementation(async (input) => {
			admissions.push(input);
			if (!compacted && input.attempt === 0) {
				compacted = true;
				const compactedHistory: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: "COMPACTED-HISTORY" }],
					timestamp: 2,
				};
				harness?.agent.state.messages.splice(0, harness.agent.state.messages.length, compactedHistory);
				return { action: "replan" };
			}
			return { action: "send" };
		});
		const sessionAdmission = harness.agent.admitProviderRequest?.bind(harness.agent);
		if (!sessionAdmission) throw new Error("Expected session provider request admission");
		const admittedContexts: Context[] = [];
		harness.agent.admitProviderRequest = async (request, signal) => {
			admittedContexts.push(request.context);
			return await sessionAdmission(request, signal);
		};

		await harness.agent.prompt("ORIGINAL-HISTORY");

		expect(admissions.map((input) => input.attempt)).toEqual([0, 1, 0]);
		expect(admittedContexts).toHaveLength(3);
		expect(admittedContexts.map((context) => context.systemPrompt)).toEqual([
			expect.stringContaining(bodyMarker),
			expect.stringContaining(bodyMarker),
			expect.stringContaining(bodyMarker),
		]);
		expect(admittedContexts.map((context) => JSON.stringify(context.messages))).toEqual([
			expect.not.stringContaining(bodyMarker),
			expect.not.stringContaining(bodyMarker),
			expect.not.stringContaining(bodyMarker),
		]);
		expect(plannedSkillPrompts).toEqual([
			expect.stringContaining(bodyMarker),
			expect.stringContaining(bodyMarker),
			expect.stringContaining(bodyMarker),
		]);
		expect(admissions[0].nonCompactableTokens).toBeGreaterThan(750);
		expect(admissions[0].requestTokens).toBeGreaterThan(admissions[0].nonCompactableTokens);
		expect(harness.faux.callCount).toBe(2);
		for (const delivered of harness.faux.contexts) {
			expect(delivered.tools).toBeUndefined();
			expect(delivered.systemPrompt).toContain('<pi:call name="TOOL">');
			expect(delivered.systemPrompt).toContain(bodyMarker);
			expect(JSON.stringify(delivered.messages)).toContain("COMPACTED-HISTORY");
			expect(JSON.stringify(delivered.messages)).not.toContain(bodyMarker);
			expect(JSON.stringify(delivered.messages)).not.toContain("ORIGINAL-HISTORY");
		}
		expect(internals._skillVault.status()).toMatchObject({ state: "active", useCount: 2 });
	});
});
