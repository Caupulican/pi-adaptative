/**
 * P1f: ui_prompt_start/ui_prompt_end must be emitted by the extension runner around ctx.ui.*
 * prompts (select/confirm/input/editor/custom), not as a bare AgentSession-level event. Nested
 * prompts coalesce into a single span, and handlers must never delay the prompt itself.
 */

import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/factory-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";

function fakeUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		askQuestions: async () => ({ answers: [], cancelled: true, reason: "ui_unavailable", imageContents: [] }),
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): never {
			throw new Error("theme not stubbed");
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not stubbed" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

async function makeRunner(uiContext: ExtensionUIContext) {
	const bus = createEventBus();
	const runtime = createExtensionRuntime();
	const events: Array<{ type: string; kind?: string; title?: string }> = [];

	const ext = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", (event) => {
				events.push({ type: event.type, kind: event.kind, title: event.title });
			});
			pi.on("ui_prompt_end", (event) => {
				events.push({ type: event.type, kind: event.kind, title: event.title });
			});
		},
		process.cwd(),
		bus,
		runtime,
		"ui-prompt-test-ext",
	);

	const runner = new ExtensionRunner([ext], runtime, process.cwd(), undefined as never, undefined as never);
	runner.setUIContext(uiContext);
	return { runner, events };
}

describe("P1f: ui_prompt_start/ui_prompt_end", () => {
	it("brackets select/confirm/input/editor with reason/kind/title", async () => {
		const { runner, events } = await makeRunner(
			fakeUiContext({
				select: async () => "chosen",
				confirm: async () => true,
				input: async () => "typed",
				editor: async () => "edited",
			}),
		);
		const ctx = runner.createContext();

		await ctx.ui.select("Pick one", ["a", "b"]);
		await ctx.ui.confirm("Are you sure?", "message");
		await ctx.ui.input("Type something", "placeholder");
		await ctx.ui.editor("Edit this", "prefill");

		expect(events).toEqual([
			{ type: "ui_prompt_start", kind: "select", title: "Pick one" },
			{ type: "ui_prompt_end", kind: "select", title: "Pick one" },
			{ type: "ui_prompt_start", kind: "confirm", title: "Are you sure?" },
			{ type: "ui_prompt_end", kind: "confirm", title: "Are you sure?" },
			{ type: "ui_prompt_start", kind: "input", title: "Type something" },
			{ type: "ui_prompt_end", kind: "input", title: "Type something" },
			{ type: "ui_prompt_start", kind: "editor", title: "Edit this" },
			{ type: "ui_prompt_end", kind: "editor", title: "Edit this" },
		]);
	});

	it("brackets custom() with kind 'custom' and no title", async () => {
		const fakeCustom = (async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			await factory(undefined as never, undefined as never, undefined as never, () => {});
			return undefined;
		}) as ExtensionUIContext["custom"];
		const { runner, events } = await makeRunner(fakeUiContext({ custom: fakeCustom }));
		const ctx = runner.createContext();

		// The fake above calls the factory (to exercise a realistic rejection path); the factory
		// itself throws, and that rejection propagates through custom() unchanged.
		await ctx.ui
			.custom(async () => {
				throw new Error("factory intentionally rejects to verify the span still closes on error");
			})
			.catch(() => {});

		// Even on a rejecting factory, the span must still open and close around it.
		expect(events.map((e) => e.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		expect(events[0].kind).toBe("custom");
		expect(events[0].title).toBeUndefined();
	});

	it("coalesces a prompt nested inside another prompt into a single span", async () => {
		let ctxRef: ReturnType<ExtensionRunner["createContext"]> | undefined;
		const { runner, events } = await makeRunner(
			fakeUiContext({
				confirm: async () => {
					// A nested prompt triggered from within the outer prompt's own resolution.
					await ctxRef?.ui.input("Nested title", undefined);
					return true;
				},
			}),
		);
		ctxRef = runner.createContext();

		await ctxRef.ui.confirm("Outer title", "message");

		expect(events).toEqual([
			{ type: "ui_prompt_start", kind: "confirm", title: "Outer title" },
			{ type: "ui_prompt_end", kind: "confirm", title: "Outer title" },
		]);
	});

	it("never delays the prompt even when a handler throws or is slow (fire-and-forget)", async () => {
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const handlerCalls: string[] = [];

		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.on("ui_prompt_start", async () => {
					handlerCalls.push("start-begin");
					await new Promise((resolve) => setTimeout(resolve, 50));
					handlerCalls.push("start-end");
					throw new Error("handler failure must not propagate");
				});
			},
			process.cwd(),
			bus,
			runtime,
			"slow-handler-ext",
		);
		const runner = new ExtensionRunner([ext], runtime, process.cwd(), undefined as never, undefined as never);
		runner.setUIContext(fakeUiContext({ select: async () => "fast-result" }));

		const start = Date.now();
		const result = await runner.createContext().ui.select("Quick", ["a"]);
		const elapsedMs = Date.now() - start;

		expect(result).toBe("fast-result");
		// The prompt resolved without waiting for the 50ms handler.
		expect(elapsedMs).toBeLessThan(40);
		expect(handlerCalls).toEqual(["start-begin"]);
	});
});
