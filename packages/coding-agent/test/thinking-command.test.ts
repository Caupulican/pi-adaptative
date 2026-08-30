import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { setKeybindings } from "@caupulican/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { handleThinkingCommand } from "../src/modes/interactive/session-flow-commands.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("/thinking command and selector (P1b/P1c)", () => {
	beforeEach(() => {
		initTheme();
		setKeybindings(new KeybindingsManager());
	});

	it("sets valid thinking level directly", async () => {
		const session = {
			thinkingLevel: "off" as ThinkingLevel,
			getAvailableThinkingLevels: () =>
				["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as ThinkingLevel[],
			setThinkingLevel: vi.fn((level: ThinkingLevel) => {
				session.thinkingLevel = level;
			}),
		};
		const footer = { invalidate: vi.fn() };
		const host = {
			session,
			footer,
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as any;

		await handleThinkingCommand(host, "high");

		expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(footer.invalidate).toHaveBeenCalled();
		expect(host.showStatus).toHaveBeenCalledWith("Thinking level set to high");
	});

	it("shows error with valid levels when level is invalid", async () => {
		const session = {
			thinkingLevel: "off" as ThinkingLevel,
			getAvailableThinkingLevels: () =>
				["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as ThinkingLevel[],
			setThinkingLevel: vi.fn(),
		};
		const host = {
			session,
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as any;

		await handleThinkingCommand(host, "invalid-level");

		expect(session.setThinkingLevel).not.toHaveBeenCalled();
		expect(host.showError).toHaveBeenCalledWith(
			'Invalid thinking level "invalid-level". Valid levels: off, minimal, low, medium, high, xhigh, max, ultra',
		);
	});

	it("opens thinking selector when no arg is provided", async () => {
		const session = {
			thinkingLevel: "low" as ThinkingLevel,
			getAvailableThinkingLevels: () => ["off", "low", "high"] as ThinkingLevel[],
			setThinkingLevel: vi.fn(),
		};
		let selectorCreated = false;
		const host = {
			session,
			settingsManager: { setDefaultThinkingLevel: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: vi.fn((factory: (done: () => void) => unknown) => {
				selectorCreated = true;
				factory(() => {});
			}),
		} as any;

		await handleThinkingCommand(host, undefined);

		expect(host.showSelector).toHaveBeenCalled();
		expect(selectorCreated).toBe(true);
	});

	it("ThinkingSelectorComponent selects on Enter and saves default on Ctrl+S", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const onSelectAsDefault = vi.fn();

		const selector = new ThinkingSelectorComponent(
			"low",
			["off", "low", "high"],
			onSelect,
			onCancel,
			onSelectAsDefault,
		);

		// Press Ctrl+S (\x13)
		selector.handleInput("\x13");
		expect(onSelectAsDefault).toHaveBeenCalledWith("low");

		// Press Enter (\r)
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("low");
	});

	it("ModelSelectorComponent selects on Enter and saves default on Ctrl+S", async () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const onSelectAsDefault = vi.fn();
		const mockModel = {
			id: "gpt-4o",
			provider: "openai",
			name: "GPT-4o",
			api: "openai-responses" as const,
		};

		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as any,
			mockModel as any,
			{} as any,
			{ refresh: vi.fn(), getAvailable: vi.fn().mockResolvedValue([mockModel]), getError: () => undefined } as any,
			[],
			onSelect,
			onCancel,
			undefined,
			onSelectAsDefault,
		);

		// Wait for loadModels promise in constructor
		await new Promise((r) => setTimeout(r, 10));

		// Trigger Ctrl+S
		selector.handleInput("\x13");
		expect(onSelectAsDefault).toHaveBeenCalledWith(mockModel);

		// Trigger Enter
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(mockModel);
	});
});
