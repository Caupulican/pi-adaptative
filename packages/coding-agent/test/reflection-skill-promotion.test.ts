import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R7 memory-to-behavior: a reflection that emits a `promote_skill` write compiles the recurring
 * procedure into a loadable SKILL.md under the agent's skills directory.
 */
describe("reflection skill promotion (R7)", () => {
	let tempDir: string;
	let agentDir: string;

	const reply = (jsonBody: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: `\`\`\`json\n${jsonBody}\n\`\`\`` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-promote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a SKILL.md when reflection promotes a recurring workflow", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		(session.agent as unknown as { streamFn: unknown }).streamFn = async () =>
			({
				result: async () =>
					reply(
						JSON.stringify({
							rationale: "recurring release workflow",
							writes: [
								{
									kind: "promote_skill",
									name: "Release Flow",
									description: "How to cut a patch release",
									body: "1. Run the full test suite.\n2. Update the changelog.\n3. Run npm run release:patch.",
								},
							],
						}),
					),
			}) as never;

		await session.runReflectionPass({
			signals: {
				trigger: "complex",
				toolCallCount: 12,
				hadCorrection: false,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: we just cut a release by running tests then release:patch",
			reportId: "t1",
		});

		// The promoted skill was compiled to a loadable SKILL.md (name kebab-cased).
		const skillFile = join(agentDir, "skills", "release-flow", "SKILL.md");
		expect(existsSync(skillFile)).toBe(true);
		const content = readFileSync(skillFile, "utf-8");
		expect(content).toContain("name: release-flow");
		expect(content).toContain("How to cut a patch release");
		expect(content).toContain("npm run release:patch");

		session.dispose();
	});
});
