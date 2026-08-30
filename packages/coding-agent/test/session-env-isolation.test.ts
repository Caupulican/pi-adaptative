import { describe, expect, it } from "vitest";
import { getShellEnv, type ShellSessionContext } from "../src/utils/shell.ts";

describe("P2k: Session environment isolation in shell processes", () => {
	it("strips inherited session variables by default to prevent leaking to child processes", () => {
		const inheritedEnv: NodeJS.ProcessEnv = {
			PATH: "/bin:/usr/bin",
			PI_SESSION_ID: "parent-session-123",
			PI_SESSION_FILE: "/tmp/parent.jsonl",
			PI_PROVIDER: "parent-provider",
			PI_MODEL: "parent-model",
			PI_REASONING_LEVEL: "high",
			PI_THINKING_LEVEL: "high",
			CUSTOM_VAR: "kept",
		};

		const env = getShellEnv(inheritedEnv, "linux");

		expect(env.CUSTOM_VAR).toBe("kept");
		expect(env.PI_SESSION_ID).toBeUndefined();
		expect(env.PI_SESSION_FILE).toBeUndefined();
		expect(env.PI_PROVIDER).toBeUndefined();
		expect(env.PI_MODEL).toBeUndefined();
		expect(env.PI_REASONING_LEVEL).toBeUndefined();
		expect(env.PI_THINKING_LEVEL).toBeUndefined();
	});

	it("populates active session variables when session context is provided", () => {
		const inheritedEnv: NodeJS.ProcessEnv = {
			PATH: "/bin:/usr/bin",
			PI_SESSION_ID: "parent-session-123",
		};

		const context: ShellSessionContext = {
			sessionId: "child-session-456",
			sessionFile: "/tmp/child.jsonl",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinkingLevel: "medium",
			exposeSessionEnvironment: true,
		};

		const env = getShellEnv(inheritedEnv, "linux", context);

		expect(env.PI_SESSION_ID).toBe("child-session-456");
		expect(env.PI_SESSION_FILE).toBe("/tmp/child.jsonl");
		expect(env.PI_PROVIDER).toBe("anthropic");
		expect(env.PI_MODEL).toBe("claude-sonnet-4-5");
		expect(env.PI_REASONING_LEVEL).toBe("medium");
		expect(env.PI_THINKING_LEVEL).toBe("medium");
	});

	it("does not populate session variables when exposeSessionEnvironment is false", () => {
		const inheritedEnv: NodeJS.ProcessEnv = {
			PATH: "/bin:/usr/bin",
			PI_SESSION_ID: "parent-session-123",
		};

		const context: ShellSessionContext = {
			sessionId: "child-session-456",
			sessionFile: "/tmp/child.jsonl",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinkingLevel: "medium",
			exposeSessionEnvironment: false,
		};

		const env = getShellEnv(inheritedEnv, "linux", context);

		expect(env.PI_SESSION_ID).toBeUndefined();
		expect(env.PI_SESSION_FILE).toBeUndefined();
		expect(env.PI_PROVIDER).toBeUndefined();
		expect(env.PI_MODEL).toBeUndefined();
		expect(env.PI_REASONING_LEVEL).toBeUndefined();
		expect(env.PI_THINKING_LEVEL).toBeUndefined();
	});
});
