import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const stdout = vi.hoisted(() => ({ written: [] as string[] }));
vi.mock("../src/core/output-guard.ts", () => ({
	writeRawStdout: (text: string) => stdout.written.push(text),
	flushRawStdout: async () => {},
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	peekPathAliasTable(): { cwd: string; entries: never[] };
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AgentMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	waitForForegroundIdle: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	getCumulativeUsage: () => AssistantMessage["usage"];
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(...messages: AgentMessage[]): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages };

	const session: FakeSession = {
		peekPathAliasTable: () => ({ cwd: process.cwd(), entries: [] }),
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		waitForForegroundIdle: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		getCumulativeUsage: () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("submits each further message only after the work the previous one left behind settles", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		// A prompt resolves while System One still checks its answer: the session stays busy until then.
		let busy = false;
		const calls: string[] = [];
		session.prompt.mockImplementation(async (text: string) => {
			if (busy) throw new Error("Agent is already processing.");
			calls.push(text);
			busy = true;
		});
		session.waitForForegroundIdle.mockImplementation(async () => {
			busy = false;
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "first",
			messages: ["second", "third"],
		});

		expect(exitCode).toBe(0);
		expect(calls).toEqual(["first", "second", "third"]);
	});

	it("prints the reply even when a host record lands after it", async () => {
		stdout.written.length = 0;
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "the answer" }), {
			role: "custom",
			customType: "owner_items",
			content: "Needs you: nothing",
			display: true,
			timestamp: 3,
		});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "question",
		});
		expect(exitCode).toBe(0);
		expect(stdout.written).toEqual(["the answer\n"]);
	});

	it("prints a toolkit hit's owner execution, the reply given with no model, and exits by its status", async () => {
		stdout.written.length = 0;
		const execution = (exitCode: number) =>
			createRuntimeHost({
				role: "bashExecution",
				command: "run_toolkit_script status-report",
				output: "status report: all green",
				exitCode,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			});
		const run = (runtimeHost: FakeRuntimeHost) =>
			runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "run the status report",
			});
		expect(await run(execution(0))).toBe(0);
		expect(stdout.written).toEqual(["status report: all green\n"]);
		expect(await run(execution(2))).toBe(1);
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
