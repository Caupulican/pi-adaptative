import { PassThrough } from "node:stream";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

type ModeInternals = {
	chatContainer: { children: unknown[] };
	hasHumanAudience: boolean;
};

function runtimeHostFor(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
}

function answered(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const off = harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			off();
			resolve();
		});
	});
}

describe("unattended worker terminal", () => {
	const modes: InteractiveMode[] = [];
	afterEach(() => {
		for (const mode of modes.splice(0)) mode.stop();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("accepts a prompt typed into a worker terminal while building, projecting and drawing nothing", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("earlier answer")]);
		await harness.session.prompt("earlier question");

		vi.stubEnv("PI_SESSION_ROLE", "worker");
		const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
		vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
		const terminalOutput: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
			const text = String(chunk);
			if (text.includes("\x1b[") || text.includes("earlier answer")) terminalOutput.push(text);
			return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof process.stdout.write);
		const consoleLog = vi.spyOn(console, "log");
		const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
		const renderHistory = vi.spyOn(prototype, "renderInitialMessages");
		const projectEvent = vi.spyOn(prototype, "handleEvent");
		const unattendedEvent = vi.spyOn(prototype, "handleUnattendedEvent");
		const resumeSelfCompaction = vi.spyOn(harness.session, "resumeSelfCompaction");
		const resumeHumanInput = vi.spyOn(harness.session, "resumePendingHumanInput");

		const mode = new InteractiveMode(runtimeHostFor(harness), { hasHumanAudience: true });
		modes.push(mode);
		expect((mode as unknown as ModeInternals).hasHumanAudience).toBe(false);
		void mode.run();
		await vi.waitFor(() => expect(resumeSelfCompaction).toHaveBeenCalled());

		harness.setResponses([fauxAssistantMessage("worker answer")]);
		const done = answered(harness);
		stdin.write("new worker task");
		stdin.write("\r");
		await done;

		const texts = harness.session.messages.map((message) => JSON.stringify(message));
		expect(texts.some((text) => text.includes("new worker task"))).toBe(true);
		expect(texts.some((text) => text.includes("worker answer"))).toBe(true);
		expect(resumeHumanInput).toHaveBeenCalled();
		expect(unattendedEvent).toHaveBeenCalled();
		expect(renderHistory).not.toHaveBeenCalled();
		expect(projectEvent).not.toHaveBeenCalled();
		expect((mode as unknown as ModeInternals).chatContainer.children).toHaveLength(0);
		expect(consoleLog).not.toHaveBeenCalled();
		expect(terminalOutput).toEqual([]);
	});
});
