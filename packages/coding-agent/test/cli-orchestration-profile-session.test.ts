import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { resolveConfiguredOrchestrationModel } from "../src/core/orchestration/model-binding.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

/**
 * The CLI's own session construction, as `main.ts` performs it when an orchestration profile is
 * active. A worker resume spawns exactly this path (`buildPiResumeLaunchSpec` passes
 * `--orchestration-profile`), so whatever the CLI hands the SDK here is field behavior.
 */
describe("CLI orchestration-profile session construction", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cli-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const profileFor = (): OrchestrationProfile =>
		createTestWorkerOrchestrationProfile({
			profileId: "cli-explorer",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});

	async function services() {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		return createAgentSessionServices({ cwd: tempDir, agentDir, authStorage, settingsManager });
	}

	it("constructs the session from the profile alone, with an uncustomized router pool", async () => {
		const built = await services();
		const profile = profileFor();
		const resolved = resolveConfiguredOrchestrationModel(profile, built.modelRegistry);
		expect(resolved?.model.id).toBe("claude-sonnet-4-5");

		const { session } = await createAgentSessionFromServices({
			services: built,
			sessionManager: SessionManager.inMemory(),
			orchestrationProfile: profile,
		});
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			// Cycling is pinned to the profile's root model; the pool stays everything enabled.
			expect(session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["claude-sonnet-4-5"]);
			const pool = session.getRouterCandidatePool();
			expect(pool.customized).toBe(false);
			expect(pool.source).toBe("all_enabled");
		} finally {
			await session.disposeAndWait();
		}
	});

	it("keeps a configured Models scope as the router pool under an orchestration profile", async () => {
		const built = await services();
		const scoped = getModel("anthropic", "claude-haiku-4-5");
		if (!scoped) throw new Error("Missing test model");

		const { session } = await createAgentSessionFromServices({
			services: built,
			sessionManager: SessionManager.inMemory(),
			orchestrationProfile: profileFor(),
			routerPool: { source: "enabled_models", models: [{ model: scoped }] },
		});
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.scopedModels.map((entry) => entry.model.id)).toEqual(["claude-sonnet-4-5"]);
			const pool = session.getRouterCandidatePool();
			expect(pool.customized).toBe(true);
			expect(pool.source).toBe("enabled_models");
			expect(pool.models.map((model) => model.id)).toEqual(["claude-haiku-4-5"]);
		} finally {
			await session.disposeAndWait();
		}
	});
});
