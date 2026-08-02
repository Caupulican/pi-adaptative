import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { CompactOptions, ExtensionContext, ExtensionRunner } from "../src/core/extensions/index.ts";
import { ExtensionUiHost, type ExtensionUiHostUi } from "../src/modes/interactive/extension-ui-host.ts";

type CompactResult = Awaited<ReturnType<AgentSession["compact"]>>;
type ExtensionCompactionMethod = (this: Pick<AgentSession, "compact">, options?: CompactOptions) => void;

function getExtensionCompactionMethod(): ExtensionCompactionMethod {
	const method = (AgentSession.prototype as AgentSession & { compactForExtension?: ExtensionCompactionMethod })
		.compactForExtension;
	if (!method) throw new Error("AgentSession.compactForExtension is not installed");
	return method;
}

describe("AgentSession extension operations", () => {
	it("starts compaction without blocking and delivers completion through the extension callback", async () => {
		const result = { summary: "compacted" } as CompactResult;
		let resolveCompaction!: (value: CompactResult) => void;
		const compact = vi.fn(
			() =>
				new Promise<CompactResult>((resolve) => {
					resolveCompaction = resolve;
				}),
		);
		const onComplete = vi.fn();
		const onError = vi.fn();
		const host = { compact } as unknown as Pick<AgentSession, "compact">;

		expect(
			getExtensionCompactionMethod().call(host, {
				customInstructions: "retain the open requirement",
				onComplete,
				onError,
			}),
		).toBeUndefined();
		expect(compact).toHaveBeenCalledWith("retain the open requirement");
		expect(onComplete).not.toHaveBeenCalled();

		resolveCompaction(result);
		await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(result));
		expect(onError).not.toHaveBeenCalled();
	});

	it("normalizes a rejected non-Error value before notifying the extension", async () => {
		const compact = vi.fn(async () => {
			throw "compaction failed";
		});
		const onError = vi.fn();
		const host = { compact } as unknown as Pick<AgentSession, "compact">;

		getExtensionCompactionMethod().call(host, { onError });

		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		const error = onError.mock.calls[0]?.[0];
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "compaction failed" });
	});

	it("routes shortcut compaction through the session owner while preserving host lifecycle actions", async () => {
		const compactForExtension = vi.fn();
		const abort = vi.fn();
		const markShutdownRequested = vi.fn();
		const reload = vi.fn(async () => {});
		const showError = vi.fn();
		const defaultEditor: { onExtensionShortcut?: (data: string) => boolean } = {};
		const compactOptions: CompactOptions = { customInstructions: "shortcut compaction" };
		const session = {
			sessionManager: { getCwd: () => "/workspace" },
			modelRegistry: {},
			model: undefined,
			isStreaming: false,
			agent: { signal: undefined },
			pendingMessageCount: 0,
			getContextUsage: () => undefined,
			compactForExtension,
			systemPrompt: "system prompt",
		} as unknown as AgentSession;
		const ui = {
			keybindings: { getEffectiveConfig: () => ({}) },
			defaultEditor,
			abort,
			markShutdownRequested,
			reload,
			showError,
		} as unknown as ExtensionUiHostUi;
		const handler = vi.fn((context: ExtensionContext) => {
			context.compact(compactOptions);
			context.abort();
			context.shutdown();
			return context.reload();
		});
		const runner = {
			getShortcuts: () => new Map([["ctrl+k", { handler }]]),
		} as unknown as ExtensionRunner;
		const host = new ExtensionUiHost({ getSession: () => session, ui });

		host.setupExtensionShortcuts(runner);
		expect(defaultEditor.onExtensionShortcut?.("\u000b")).toBe(true);

		expect(compactForExtension).toHaveBeenCalledWith(compactOptions);
		expect(abort).toHaveBeenCalledOnce();
		expect(markShutdownRequested).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
		expect(showError).not.toHaveBeenCalled();
	});
});
