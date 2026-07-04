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
 * Strict UAC activation: a tool the active profile names explicitly is a GRANT, so it must be
 * ACTIVE — not merely permitted — on session load and across /reload. Regression: activation was
 * only ever (requested defaults ∩ allow-list), so a profile granting non-default tools (e.g. a
 * search-only profile) produced an empty or truncated active tool set.
 */
describe("profile tool grants activate", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-activation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function sessionWithProfile(allow: string[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.addInlineResourceProfileDefinitions({ scout: { tools: { allow } } });
		settingsManager.setRuntimeResourceProfiles(["scout"]);
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
		return session;
	}

	it("activates explicitly granted non-default tools on load and across reload", async () => {
		const session = await sessionWithProfile(["read", "grep", "bash"]);
		try {
			expect(session.getActiveToolNames().sort()).toEqual(["bash", "grep", "read"]);
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["bash", "grep", "read"]);
		} finally {
			session.dispose();
		}
	});

	it("a grants-only-non-default profile still yields its tools (never an empty set)", async () => {
		const session = await sessionWithProfile(["grep", "ls"]);
		try {
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "ls"]);
		} finally {
			session.dispose();
		}
	});

	it('a blanket "*" grant stays grant-only: activation derives from the defaults', async () => {
		const session = await sessionWithProfile(["*"]);
		try {
			const active = session.getActiveToolNames();
			expect(active).toContain("read");
			expect(active).toContain("bash");
			// grep is permitted by "*" but was never requested nor explicitly named
			expect(active).not.toContain("grep");
		} finally {
			session.dispose();
		}
	});
});
