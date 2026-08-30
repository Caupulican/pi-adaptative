/**
 * C4/P2k: the live session context (sessionId/file/provider/model/thinkingLevel) must reach
 * spawned shell processes, honoring settingsManager.getExposeSessionEnvironment(), with the
 * delete-first-then-repopulate ordering happening BEFORE any spawnHook runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type BashOperations,
	type BashSpawnContext,
	buildShellSessionContext,
	createBashTool,
} from "../src/core/tools/bash.ts";
import type { ShellSessionContext } from "../src/utils/shell.ts";

const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

function captureEnvOperations(): { operations: BashOperations; getEnv: () => NodeJS.ProcessEnv | undefined } {
	let captured: NodeJS.ProcessEnv | undefined;
	return {
		operations: {
			exec: async (_command, _cwd, options) => {
				captured = options.env;
				return { exitCode: 0 };
			},
		},
		getEnv: () => captured,
	};
}

describe("buildShellSessionContext", () => {
	it("reads the CURRENT agent/session/settings state, not a snapshot", () => {
		let model = { provider: "anthropic", id: "claude-x" };
		let thinkingLevel = "off";
		const deps = {
			getAgent: () => ({ state: { model, thinkingLevel } }) as never,
			getSessionManager: () => ({ getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" }) as never,
			getSettingsManager: () => ({ getExposeSessionEnvironment: () => true }) as never,
		};

		expect(buildShellSessionContext(deps)).toEqual({
			sessionId: "s1",
			sessionFile: "/tmp/s1.jsonl",
			provider: "anthropic",
			model: "claude-x",
			thinkingLevel: "off",
			exposeSessionEnvironment: true,
		});

		// A later /model or /thinking change must be visible on the NEXT call, not baked in once.
		model = { provider: "openai", id: "gpt-5" };
		thinkingLevel = "high";
		expect(buildShellSessionContext(deps)).toMatchObject({
			provider: "openai",
			model: "gpt-5",
			thinkingLevel: "high",
		});
	});
});

describe("bash tool spawn context wires the live session identity (C4/P2k)", () => {
	const originalEnv: Record<string, string | undefined> = {};
	afterEach(() => {
		for (const key of SESSION_ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
	});

	const sessionContext: ShellSessionContext = {
		sessionId: "session-123",
		sessionFile: "/tmp/session-123.jsonl",
		provider: "anthropic",
		model: "claude-sonnet-x",
		thinkingLevel: "high",
		exposeSessionEnvironment: true,
	};

	it("injects PI_SESSION_ID/FILE/PROVIDER/MODEL/REASONING_LEVEL into the spawned command", async () => {
		const { operations, getEnv } = captureEnvOperations();
		const tool = createBashTool("/repo", {
			operations,
			platform: "linux",
			getShellSessionContext: () => sessionContext,
		});

		await tool.execute("call-1", { command: "true" });

		expect(getEnv()).toMatchObject({
			PI_SESSION_ID: "session-123",
			PI_SESSION_FILE: "/tmp/session-123.jsonl",
			PI_PROVIDER: "anthropic",
			PI_MODEL: "claude-sonnet-x",
			PI_REASONING_LEVEL: "high",
			PI_THINKING_LEVEL: "high",
		});
	});

	it("honors exposeSessionEnvironment:false by omitting all identity vars (worker/UAC-style opt-out)", async () => {
		const { operations, getEnv } = captureEnvOperations();
		const tool = createBashTool("/repo", {
			operations,
			platform: "linux",
			getShellSessionContext: () => ({ ...sessionContext, exposeSessionEnvironment: false }),
		});

		await tool.execute("call-2", { command: "true" });

		const env = getEnv();
		for (const key of SESSION_ENV_KEYS) {
			expect(env).not.toHaveProperty(key);
		}
	});

	it("deletes an inherited parent identity before repopulating -- a nested pi must not leak its parent's", async () => {
		process.env.PI_SESSION_ID = "parent-session-should-not-leak";
		process.env.PI_PROVIDER = "parent-provider-should-not-leak";
		const { operations, getEnv } = captureEnvOperations();
		const tool = createBashTool("/repo", {
			operations,
			platform: "linux",
			getShellSessionContext: () => sessionContext,
		});

		await tool.execute("call-3", { command: "true" });

		expect(getEnv()?.PI_SESSION_ID).toBe("session-123");
		expect(getEnv()?.PI_PROVIDER).toBe("anthropic");
	});

	it("deletes an inherited parent identity and leaves it deleted when no context is supplied at all", async () => {
		process.env.PI_SESSION_ID = "parent-session-should-not-leak";
		const { operations, getEnv } = captureEnvOperations();
		const tool = createBashTool("/repo", { operations, platform: "linux" });

		await tool.execute("call-4", { command: "true" });

		expect(getEnv()).not.toHaveProperty("PI_SESSION_ID");
	});

	it("repopulates the identity BEFORE the spawn hook runs, so a hook always sees the final values", async () => {
		const { operations, getEnv } = captureEnvOperations();
		let seenInHook: BashSpawnContext | undefined;
		const tool = createBashTool("/repo", {
			operations,
			platform: "linux",
			getShellSessionContext: () => sessionContext,
			spawnHook: (context) => {
				seenInHook = context;
				return { ...context, env: { ...context.env, EXTRA_FROM_HOOK: "1" } };
			},
		});

		await tool.execute("call-5", { command: "true" });

		expect(seenInHook?.env.PI_SESSION_ID).toBe("session-123");
		expect(seenInHook?.env.PI_PROVIDER).toBe("anthropic");
		// The hook's own addition still reaches the actual spawn, proving hook output is what's used.
		expect(getEnv()?.EXTRA_FROM_HOOK).toBe("1");
		expect(getEnv()?.PI_SESSION_ID).toBe("session-123");
	});
});
