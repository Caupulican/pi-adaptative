import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R2 host integration: runReflectionPass must apply the engine's memory writes through the bundled
 * `memory` tool to the CORRECT file (replace/remove carry no section, so the host tries MEMORY then
 * USER — and must not misapply to MEMORY when the target lives in USER), and account its cost once.
 */
describe("native reflection pass — write application + accounting", () => {
	let tempDir: string;
	let agentDir: string;

	const reply = (jsonBody: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: `\`\`\`json\n${jsonBody}\n\`\`\`` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const newSession = async () => {
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
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-native-refl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// Seed memory files BEFORE the session initializes the provider.
		writeFileSync(join(agentDir, "MEMORY.md"), "Deploy with npm run release:patch\n", "utf-8");
		writeFileSync(join(agentDir, "USER.md"), "User prefers tabs\n", "utf-8");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("applies a replace targeting USER content to USER.md, not MEMORY.md, and accounts cost once", async () => {
		const session = await newSession();
		// The reflection's isolated completion replaces a USER fact — its target lives only in USER.md.
		(session.agent as unknown as { streamFn: unknown }).streamFn = async () =>
			({
				result: async () =>
					reply(
						JSON.stringify({
							rationale: "user changed preference",
							writes: [{ kind: "memory_replace", target: "User prefers tabs", text: "User prefers spaces" }],
						}),
					),
			}) as never;

		const result = await session.runReflectionPass({
			signals: {
				trigger: "corrective",
				toolCallCount: 0,
				hadCorrection: true,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: actually I prefer spaces",
			reportId: "turn-1",
		});

		expect(result).not.toBeNull();
		// Applied to USER.md (the file that actually contained the target)...
		expect(readFileSync(join(agentDir, "USER.md"), "utf-8")).toContain("User prefers spaces");
		expect(readFileSync(join(agentDir, "USER.md"), "utf-8")).not.toContain("User prefers tabs");
		// ...and MEMORY.md was NOT touched by the memory-first fallback.
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Deploy with npm run release:patch");

		// Cost accounted once via the cost-aggregation surface.
		expect(session.getSpawnedUsage().reports).toBe(1);
		expect(session.getSpawnedUsage().cost).toBeCloseTo(0.002, 10);

		// Re-running the same pass (same reportId) must not double-count the cost.
		await session.runReflectionPass({
			signals: {
				trigger: "corrective",
				toolCallCount: 0,
				hadCorrection: true,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: actually I prefer spaces",
			reportId: "turn-1",
		});
		expect(session.getSpawnedUsage().reports).toBe(1);

		session.dispose();
	});

	it("skips entirely when the demand-gate says skip (no writes, no cost)", async () => {
		const session = await newSession();
		let called = false;
		(session.agent as unknown as { streamFn: unknown }).streamFn = async () => {
			called = true;
			return { result: async () => reply("{}") } as never;
		};

		const result = await session.runReflectionPass({
			signals: { trigger: "none", toolCallCount: 0, hadCorrection: false, contextHeadroomPct: 90, usefulLately: 0 },
			recentTurnText: "user: hi",
		});

		expect(result).toBeNull();
		expect(called).toBe(false);
		expect(session.getSpawnedUsage().reports).toBe(0);
		session.dispose();
	});
});
