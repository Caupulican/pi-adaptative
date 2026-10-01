import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AfterToolCallContext,
	type AgentRequestId,
	type BeforeToolCallContext,
	captureExecutionContext,
} from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import { ObjectiveMutationLedger } from "../src/core/objective-execution/objective-mutation-ledger.ts";
import { RepositoryMutationObserver } from "../src/core/objective-execution/repository-mutation-observer.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { committedRepo } from "./git-fixture.ts";
import { tempDir } from "./temp-dir.ts";

function backgroundCall(id: string, requestId: string): BeforeToolCallContext {
	const args = { command: "sleep 30", background: true };
	return {
		requestId: requestId as AgentRequestId,
		assistantMessage: fauxAssistantMessage(""),
		toolCall: fauxToolCall("bash", args, { id }),
		args,
		context: { systemPrompt: "", messages: [] },
	};
}

function terminalCall(context: BeforeToolCallContext, text: string): AfterToolCallContext {
	return {
		requestId: context.requestId,
		assistantMessage: context.assistantMessage,
		toolCall: context.toolCall,
		args: context.args,
		context: context.context,
		result: { content: [{ type: "text", text }], details: {} },
		isError: false,
	};
}

it.each([false, true])(
	"captures admitted absolute mutation targets from a nested invocation (absolute=%s)",
	async (absolute) => {
		const root = tempDir("tool-gate-repository-scope-");
		const nested = join(root, "nested");
		mkdirSync(nested);
		const target = join(nested, "new-parent", "goal.txt");
		let ambient = root;
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		vi.spyOn(observer, "begin").mockImplementation(async (input) => ({
			...input,
			observationId: "host-observation",
			repositoryRoot: root,
		}));
		const finish = vi.spyOn(observer, "finish").mockResolvedValue();
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => ambient,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
			repositoryObserver: observer,
			getObjectiveId: () => "goal",
		});

		const args = { path: absolute ? target : join("new-parent", "goal.txt"), content: "goal bytes" };
		const executionContext = captureExecutionContext({
			sessionId: "session",
			generation: 0,
			cwd: nested,
			attachment: {
				workspaceId: "task",
				attachmentId: "native",
				root,
				flavor: process.platform === "win32" ? "win32" : "posix",
				caseSensitive: process.platform !== "win32",
			},
		});
		const context = {
			assistantMessage: fauxAssistantMessage(""),
			toolCall: fauxToolCall("write", args),
			args,
			executionContext,
			context: { systemPrompt: "", messages: [], tools: [] },
		};
		await gate.beforeToolCall(context);
		ambient = tempDir("tool-gate-changed-workspace-");
		await gate.afterToolCall({
			...context,
			result: { content: [{ type: "text", text: "written" }], details: {} },
			isError: false,
		});
		expect(observer.begin).toHaveBeenCalledWith(expect.objectContaining({ cwd: nested }));
		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({ declaredOwnedPaths: [target], operationSucceeded: true }),
		);
	},
);

it("finalizes a background observation by invocation identity, preserving a same-id successor", async () => {
	const root = committedRepo("tool-gate-background-overlap-");
	const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
	const gate = new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => root,
		getCapabilityEnvelope: () => undefined,
		recordGateOutcome: () => undefined,
		getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
		repositoryObserver: observer,
		getObjectiveId: () => "background-overlap",
		deliveryActive: () => true,
	});
	const finish = vi.spyOn(observer, "finish");
	const begin = vi.spyOn(observer, "begin");
	const first = backgroundCall("call_0", "request-a");
	const second = backgroundCall("call_0", "request-b");
	await gate.beforeToolCall(first);
	const firstObservation = await begin.mock.results[0]!.value;
	await gate.beforeToolCall(second);
	const secondObservation = await begin.mock.results[1]!.value;

	// Model a background call's terminal hook arriving while the successor is still running.
	await gate.afterToolCall(terminalCall(first, "first complete"));
	expect(finish).toHaveBeenCalledTimes(1);
	expect(finish.mock.calls[0]?.[0].token).toBe(firstObservation);
	expect(observer.hasInFlight("background-overlap")).toBe(true);

	await gate.afterToolCall(terminalCall(second, "second complete"));
	expect(finish).toHaveBeenCalledTimes(2);
	expect(finish.mock.calls[1]?.[0].token).toBe(secondObservation);
	expect(observer.hasInFlight("background-overlap")).toBe(false);
});

it("keeps a distinct-id background observation live when its predecessor completes", async () => {
	const root = committedRepo("tool-gate-background-distinct-");
	const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
	const gate = new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => root,
		getCapabilityEnvelope: () => undefined,
		recordGateOutcome: () => undefined,
		getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
		repositoryObserver: observer,
		getObjectiveId: () => "background-distinct",
		deliveryActive: () => true,
	});
	const finish = vi.spyOn(observer, "finish");
	const begin = vi.spyOn(observer, "begin");
	const first = backgroundCall("call-a", "request-a");
	const second = backgroundCall("call-b", "request-b");
	await gate.beforeToolCall(first);
	const firstObservation = await begin.mock.results[0]!.value;
	await gate.beforeToolCall(second);
	const secondObservation = await begin.mock.results[1]!.value;

	await gate.afterToolCall(terminalCall(first, "first complete"));
	expect(finish).toHaveBeenCalledTimes(1);
	expect(finish.mock.calls[0]?.[0].token).toBe(firstObservation);
	expect(observer.hasInFlight("background-distinct")).toBe(true);

	await gate.afterToolCall(terminalCall(second, "second complete"));
	expect(finish).toHaveBeenCalledTimes(2);
	expect(finish.mock.calls[1]?.[0].token).toBe(secondObservation);
	expect(observer.hasInFlight("background-distinct")).toBe(false);
});

it("releases an admitted background observation when preparation cleanup runs without afterToolCall", async () => {
	const root = committedRepo("tool-gate-background-cancel-");
	const objectiveId = "background-cancel";
	const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
	const gate = new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => root,
		getCapabilityEnvelope: () => undefined,
		recordGateOutcome: () => undefined,
		getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
		repositoryObserver: observer,
		getObjectiveId: () => objectiveId,
		deliveryActive: () => true,
	});
	const callbacks = new Set<() => void>();
	const admittedCall: BeforeToolCallContext = {
		...backgroundCall("cancelled-call", "request-cancelled"),
		registerCleanup: (cleanup) => callbacks.add(cleanup),
	};
	const begin = vi.spyOn(observer, "begin");
	const abort = vi.spyOn(observer, "abort");
	const finish = vi.spyOn(observer, "finish");
	await gate.beforeToolCall(admittedCall);
	const admittedObservation = await begin.mock.results[0]!.value;
	expect(observer.hasInFlight(objectiveId)).toBe(true);
	expect(callbacks.size).toBeGreaterThan(0);

	for (const cleanup of callbacks) cleanup();
	await observer.waitForQuiescence(objectiveId);
	expect(abort).toHaveBeenCalledWith(admittedObservation);
	expect(finish).not.toHaveBeenCalled();
	expect(observer.hasInFlight(objectiveId)).toBe(false);

	// The normal after-hook still owns a completed call; preparation cleanup after it is idempotent.
	const completedCall = backgroundCall("completed-call", "request-completed");
	const completedCleanups = new Set<() => void>();
	const withCleanup: BeforeToolCallContext = {
		...completedCall,
		registerCleanup: (cleanup) => completedCleanups.add(cleanup),
	};
	await gate.beforeToolCall(withCleanup);
	const completedObservation = await begin.mock.results[1]!.value;
	await gate.afterToolCall(terminalCall(withCleanup, "completed"));
	for (const cleanup of completedCleanups) cleanup();
	await observer.waitForQuiescence(objectiveId);
	expect(finish).toHaveBeenCalledOnce();
	expect(finish.mock.calls[0]?.[0].token).toBe(completedObservation);
	expect(abort).toHaveBeenCalledOnce();
	expect(observer.hasInFlight(objectiveId)).toBe(false);
});

it.each([false, true])(
	"finalizes every admitted repository even when one observation throws (failure=%s)",
	async (failure) => {
		const first = tempDir("tool-gate-terminal-first-");
		const second = tempDir("tool-gate-terminal-second-");
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		vi.spyOn(observer, "begin").mockImplementation(async (input) => ({
			...input,
			observationId: input.callId,
			repositoryRoot: input.cwd,
		}));
		const finish = vi.spyOn(observer, "finish").mockResolvedValue();
		if (failure) finish.mockRejectedValueOnce(new Error("first repository finalization failed"));
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => first,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => ({ hasHandlers: () => false }) as unknown as ExtensionRunner,
			repositoryObserver: observer,
			getObjectiveId: () => "goal",
		});
		const args = { edits: [{ path: join(first, "first.txt") }, { path: join(second, "second.txt") }] };
		const context = {
			assistantMessage: fauxAssistantMessage(""),
			toolCall: fauxToolCall("edit", args),
			args,
			context: { systemPrompt: "", messages: [], tools: [] },
		};
		await gate.beforeToolCall(context);
		const terminal = gate.afterToolCall({
			...context,
			result: { content: [{ type: "text", text: "written" }], details: {} },
			isError: false,
		});
		if (failure) await expect(terminal).rejects.toThrow();
		else await expect(terminal).resolves.toBeUndefined();
		expect(finish).toHaveBeenCalledTimes(2);
		expect(finish.mock.calls.map(([input]) => input.token.repositoryRoot)).toEqual([first, second]);
	},
);
