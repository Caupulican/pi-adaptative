import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { captureExecutionContext } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import { ObjectiveMutationLedger } from "../src/core/objective-execution/objective-mutation-ledger.ts";
import { RepositoryMutationObserver } from "../src/core/objective-execution/repository-mutation-observer.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { tempDir } from "./temp-dir.ts";

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
