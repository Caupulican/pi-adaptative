import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai";
import { Container, type Terminal, Text, TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { LocalRuntimeDeps } from "../src/core/models/local-runtime.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { ExtensionUiHost } from "../src/modes/interactive/extension-ui-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * #31 real interactive smoke: a genuine end-to-end exercise of the "ask before installing ollama"
 * flow through InteractiveMode's REAL confirm-dialog machinery (showExtensionConfirm ->
 * showExtensionSelector -> a real ExtensionSelectorComponent, rendered and driven via its own real
 * handleInput -- not a Reflect-called event handler with a fully-stubbed `this`). Only the two
 * boundaries that must never be real in a test are faked: the network download and the extraction
 * process (see installableThenBootableDeps below) -- everything else (TUI, Container, the selector
 * component, AgentSession, OllamaRuntime's own mkdirSync/_findBinary) is the real production code.
 *
 * There is no existing harness in this suite for constructing a full, standalone InteractiveMode
 * (main.ts is the only real caller, and its constructor hardcodes `new TUI(new ProcessTerminal())`,
 * not injectable) -- building one would mean either a production constructor change just for a test,
 * or a large from-scratch fake AgentSessionRuntime, disproportionate for a smoke check. Instead this
 * drives InteractiveMode's private confirm methods directly via Reflect (the same pattern already
 * established in interactive-mode-status.test.ts/interactive-mode-routing-status.test.ts), but wires
 * them to REAL TUI/Container/ExtensionSelectorComponent instances so the rendering and keypress
 * handling are genuine, not asserted-on-a-mock.
 */

/** Same FakeTerminal shape as edit-tool-no-full-redraw.test.ts's — a real Terminal implementation
 * that captures writes instead of touching a real tty. */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for: ${description}`);
}

/** A minimal fake child process matching Pick<ChildProcess, "pid"|"kill"|"unref"|"on">. */
function fakeChild(): ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>> {
	const child: { pid: number; kill: () => boolean; unref: () => void; on: () => typeof child } = {
		pid: 1,
		kill: () => true,
		unref: () => {},
		on: () => child,
	};
	return child as unknown as ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>>;
}

/** Ollama binary genuinely missing at first; becomes present and bootable only once the (faked)
 * download+extraction step has "installed" it -- see agent-session-local-runtime.test.ts's identical
 * pattern, duplicated here to keep this smoke file self-contained. */
function installableThenBootableDeps(): { deps: LocalRuntimeDeps; extractCalls: Array<{ kind: string }> } {
	let installed = false;
	let serverUp = false;
	const extractCalls: Array<{ kind: string }> = [];
	const deps: LocalRuntimeDeps = {
		platform: () => "linux",
		arch: () => "x64",
		fetchFn: (async (url: string) => {
			if (String(url).startsWith("https://github.com/")) {
				return new Response("fake-archive-bytes", { status: 200 });
			}
			if (!serverUp) throw new Error("ECONNREFUSED");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch,
		existsFn: (path: string) => installed && path.includes("runtimes/ollama/bin/ollama"),
		extractArchive: async (_input, _destDir, kind) => {
			extractCalls.push({ kind });
			installed = true;
			return { ok: true };
		},
		spawnFn: (_command, _argv, _options) => {
			serverUp = true;
			return fakeChild();
		},
		sleepFn: async () => {},
		homeDir: "/home/tester",
	};
	return { deps, extractCalls };
}

describe("#31 real interactive smoke — install-ollama confirm through InteractiveMode's real dialog", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the real confirm dialog, resolves it on a real Enter keypress, and completes the turn on the local model", async () => {
		const { deps, extractCalls } = installableThenBootableDeps();
		const harness = await createHarness({
			settings: { modelRouter: { enabled: true, cheapModel: "ollama/qwen3:0.6b", judgeEnabled: false } },
			localRuntimeDeps: deps,
		});
		const ollamaFaux = registerFauxProvider({ provider: "ollama", models: [{ id: "qwen3:0.6b" }] });
		harness.authStorage.setRuntimeApiKey("ollama", "faux-key");
		harness.session.modelRegistry.registerProvider("ollama", {
			baseUrl: ollamaFaux.models[0].baseUrl,
			apiKey: "faux-key",
			api: ollamaFaux.api,
			models: ollamaFaux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});

		// Real TUI + real Container, a fake Terminal only at the tty-byte boundary.
		const ui = new TUI(new FakeTerminal());
		const editorContainer = new Container();
		const editor = new Text("", 0, 0);
		const statusCalls: Array<string | undefined> = [];
		// showExtensionConfirm's own body calls `this.showExtensionSelector(...)`, whose own callbacks
		// call `this.hideExtensionSelector()` -- both need to be real, callable own-properties on
		// fakeThis (not just Reflect-bound at the call site) so that internal `this.foo(...)` dispatch
		// inside those private methods resolves to the real implementation, not undefined.
		const fakeThis = {
			extensionSelector: undefined as ExtensionSelectorComponent | undefined,
			// Mirror the real ExtensionUiHost collaborator surface: showExtensionSelector/
			// hideExtensionSelector reach the TUI, the editor, and the container swap through this.ui.
			ui: {
				tui: ui,
				overlayHost: new EditorOverlayHost(editorContainer, ui),
				getEditor: () => editor,
				toggleToolsExpanded: () => {},
				footerDataProvider: {
					setExtensionStatus: (_key: string, text: string | undefined) => statusCalls.push(text),
				},
			},
			showExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "showExtensionSelector"),
			hideExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "hideExtensionSelector"),
		};

		const showExtensionConfirm = Reflect.get(ExtensionUiHost.prototype, "showExtensionConfirm") as (
			this: typeof fakeThis,
			title: string,
			message: string,
			opts?: { signal?: AbortSignal; timeout?: number },
		) => Promise<boolean>;
		const setExtensionStatus = Reflect.get(ExtensionUiHost.prototype, "setExtensionStatus") as (
			this: typeof fakeThis,
			key: string,
			text: string | undefined,
		) => void;

		// The real ExtensionUIContext.confirm/setStatus, bound to real ExtensionUiHost dialog methods.
		const realUIContext = {
			confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
				showExtensionConfirm.call(fakeThis, title, message, opts),
			setStatus: (key: string, text: string | undefined) => setExtensionStatus.call(fakeThis, key, text),
		} as unknown as ExtensionUIContext;
		(harness.session as unknown as { _extensionUIContext?: ExtensionUIContext })._extensionUIContext = realUIContext;

		try {
			const promptPromise = harness.session.prompt("Explain this code block");

			// Wait for the REAL confirm dialog to actually mount (set by the real showExtensionSelector).
			await waitFor(() => fakeThis.extensionSelector !== undefined, "the install-ollama confirm dialog to render");
			const selector = fakeThis.extensionSelector;
			if (!selector) throw new Error("unreachable — waitFor guarantees this is set");

			// Real render() call on the real component -- proves the actual confirm text is what's drawn,
			// not just what a warning message happens to say.
			const rendered = selector.render(80).join("\n");
			expect(rendered).toContain("Install Ollama?");
			expect(rendered).toContain("large one-time download");

			// Real keypress: "\n" is ExtensionSelectorComponent's own confirm key, selecting "Yes" (index 0).
			selector.handleInput("\n");

			ollamaFaux.setResponses([fauxAssistantMessage("answered locally after install")]);
			await promptPromise;

			expect(extractCalls).toHaveLength(1);
			expect(extractCalls[0]?.kind).toBe("tar-zst");
			expect(statusCalls.some((text) => text?.includes("Downloading"))).toBe(true);
			expect(statusCalls.at(-1)).toBeUndefined(); // cleared once installManaged settles

			const assistantTexts = harness.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => (message.role === "assistant" ? message.content : []))
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text);
			expect(assistantTexts).toEqual(["answered locally after install"]);
			expect(harness.eventsOfType("warning")).toHaveLength(0);
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});
});
