import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage, Context } from "@caupulican/pi-ai";
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
		expect(internals._skillVault.status()).toMatchObject({ slots: [{ state: "active", useCount: 2 }] });
	});

	it("admits production-sized image history by semantic tokens instead of base64 characters", async () => {
		harness = createHarness({ responses: ["delivered"] });
		const internals = harness.session as unknown as {
			_compaction: {
				admitProviderRequest(input: ProviderRequestCompactionInput): Promise<ProviderRequestCompactionDecision>;
			};
		};
		const admissions: ProviderRequestCompactionInput[] = [];
		vi.spyOn(internals._compaction, "admitProviderRequest").mockImplementation(async (input) => {
			admissions.push(input);
			return { action: "send" };
		});
		const images = Array.from({ length: 9 }, (_, index) => ({
			type: "image" as const,
			data: String.fromCharCode(65 + index).repeat(326_000),
			mimeType: "image/png",
		}));

		await harness.agent.prompt("inspect every image", images);

		expect(admissions).toHaveLength(1);
		expect(admissions[0]?.requestTokens).toBeLessThan(20_000);
		expect(admissions[0]?.requestTokens).toBeGreaterThan(9_000);
		expect(
			harness.faux.contexts[0]?.messages.flatMap((message) =>
				Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
			),
		).toHaveLength(9);
	});

	it("anchors long same-model history to provider usage instead of the fixed character ratio", async () => {
		harness = createHarness({ responses: ["delivered"] });
		const providerMeasuredHistory: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "const compactValue = true;\n".repeat(16_000) }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 55_000,
				output: 5_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		harness.agent.state.messages.push(
			{ role: "user", content: [{ type: "text", text: "produce the fixture" }], timestamp: 1 },
			providerMeasuredHistory,
		);
		const internals = harness.session as unknown as {
			_compaction: {
				admitProviderRequest(input: ProviderRequestCompactionInput): Promise<ProviderRequestCompactionDecision>;
			};
		};
		const admissions: ProviderRequestCompactionInput[] = [];
		vi.spyOn(internals._compaction, "admitProviderRequest").mockImplementation(async (input) => {
			admissions.push(input);
			return { action: "send" };
		});

		await harness.agent.prompt("continue");

		expect(admissions).toHaveLength(1);
		expect(admissions[0]?.requestTokens).toBeGreaterThanOrEqual(60_000);
		expect(admissions[0]?.requestTokens).toBeLessThan(70_000);
	});

	it("keeps the conservative full-request estimate when history usage belongs to another model", async () => {
		harness = createHarness({ responses: ["delivered"] });
		harness.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "const compactValue = true;\n".repeat(16_000) }],
			api: "anthropic-messages",
			provider: "another-provider",
			model: "another-model",
			usage: {
				input: 1_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const internals = harness.session as unknown as {
			_compaction: {
				admitProviderRequest(input: ProviderRequestCompactionInput): Promise<ProviderRequestCompactionDecision>;
			};
		};
		const admissions: ProviderRequestCompactionInput[] = [];
		vi.spyOn(internals._compaction, "admitProviderRequest").mockImplementation(async (input) => {
			admissions.push(input);
			return { action: "send" };
		});

		await harness.agent.prompt("continue");

		expect(admissions).toHaveLength(1);
		expect(admissions[0]?.requestTokens).toBeGreaterThan(100_000);
	});
});
