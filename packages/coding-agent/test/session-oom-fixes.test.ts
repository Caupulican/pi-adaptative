import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Long-session stability fixes (OOM hunt): dispose must release the agent hooks it installed (Bug #20)
 * and stop in-flight background reflection from writing to a dead session (Bug #21).
 */
describe("session dispose releases long-session resources", () => {
	let tempDir: string;
	let agentDir: string;

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
		tempDir = join(tmpdir(), `pi-oom-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("clears the agent hooks it installed on dispose (Bug #20)", async () => {
		const session = await newSession();
		expect(session.agent.afterToolCall).toBeDefined();
		session.dispose();
		// Closures that pinned the session are released.
		expect(session.agent.afterToolCall).toBeUndefined();
		expect(session.agent.transformContext).toBeUndefined();
	});

	it("does not run a reflection pass after dispose (Bug #21)", async () => {
		const session = await newSession();
		session.dispose();
		const result = await session.runReflectionPass({
			signals: {
				trigger: "corrective",
				toolCallCount: 0,
				hadCorrection: true,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: something to learn",
		});
		expect(result).toBeNull();
	});

	it("getSpawnedUsage stays correct (cached) after recording new usage (Bug #22)", async () => {
		const session = await newSession();
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
		};
		expect(session.getSpawnedUsage().cost).toBe(0);
		expect(session.getSpawnedUsage().cost).toBe(0); // cache hit, same value
		session.addSpawnedUsage(usage, { label: "a" });
		// Cache invalidates on the new entry → recomputes including it.
		expect(session.getSpawnedUsage().cost).toBeCloseTo(0.05, 10);
		session.addSpawnedUsage(usage, { label: "b" });
		expect(session.getSpawnedUsage().cost).toBeCloseTo(0.1, 10);
		session.dispose();
	});
});
