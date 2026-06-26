import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Regression: a resource profile's tool allow/block must be re-derived on reload() so that
 * a live edit to settings.json (the active profile, or its tools allow-list) takes effect.
 * Before the fix, `_toolProfileFilter` was captured once at construction and never refreshed,
 * so reload() kept the stale filter and newly-allowed tools never loaded.
 */
describe("AgentSession reload re-applies the resource-profile tool filter", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsPath: string;

	const writeSettings = (allow: string[]) => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				resourceProfiles: { locked: { tools: { allow } } },
				activeResourceProfile: "locked",
			}),
			"utf-8",
		);
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-reload-toolprofile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces a newly-allowed tool after a live settings edit + reload", async () => {
		// Active profile initially allows only `read`.
		writeSettings(["read"]);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Filter is active: read is present, bash is excluded.
		expect(session.getAllTools().map((t) => t.name)).toContain("read");
		expect(session.getAllTools().map((t) => t.name)).not.toContain("bash");

		// Live edit: allow bash too, then reload (as the user would via /reload).
		writeSettings(["read", "bash"]);
		await session.reload();

		// Regression assertion: the newly-allowed tool must now be loaded.
		const names = session.getAllTools().map((t) => t.name);
		expect(names).toContain("read");
		expect(names).toContain("bash");

		session.dispose();
	});
});
