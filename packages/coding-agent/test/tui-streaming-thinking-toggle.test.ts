import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { type Component, Container } from "@caupulican/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { type SettingsSelectorHost, showSettingsSelector } from "../src/modes/interactive/settings-selector-flow.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type StreamingMessageComponent = Component & {
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: AssistantMessage): void;
};

type ToggleThinkingHost = {
	hideThinkingBlock: boolean;
	settingsManager: { setHideThinkingBlock(hide: boolean): void };
	rebuildChatFromMessages(): Promise<void>;
	streamingComponent: StreamingMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	attachStreamingToolActions(message: AssistantMessage, argumentsComplete: boolean): void;
	updateRuntimeStatus(message: AssistantMessage): void;
	chatContainer: Container;
	ui: { requestRender(): void };
	showStatus(message: string): void;
	toggleThinkingBlockVisibility(): Promise<void>;
	updateThinkingBlockVisibility(): void;
};

function createStreamingComponent(): StreamingMessageComponent {
	return {
		render: () => ["streaming-line"],
		invalidate: () => {},
		setHideThinkingBlock: vi.fn(),
		updateContent: vi.fn(),
	};
}

describe("InteractiveMode thinking visibility toggle (F4)", () => {
	let fakeThis: ToggleThinkingHost;
	let message: AssistantMessage;
	let transcriptAssistant: AssistantMessageComponent;
	let activeToolComponent: Component;

	beforeEach(() => {
		initTheme("dark");
		message = fauxAssistantMessage([
			{ type: "thinking", thinking: "reasoning" },
			fauxToolCall("bash", { command: "printf in-flight" }),
		]);
		transcriptAssistant = new AssistantMessageComponent(message, false);
		// Simulate a running tool component holding partial output
		const partialOutput = "partial output line 1\npartial output line 2";
		activeToolComponent = {
			render: () => partialOutput.split("\n"),
			invalidate: () => {},
		};

		const chatContainer = new Container();
		chatContainer.addChild(transcriptAssistant);
		chatContainer.addChild(activeToolComponent);

		const streamingComponent = createStreamingComponent();

		fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			rebuildChatFromMessages: vi.fn(async () => {}),
			streamingComponent,
			streamingMessage: message,
			attachStreamingToolActions: vi.fn(),
			updateRuntimeStatus: vi.fn(),
			chatContainer,
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			toggleThinkingBlockVisibility: (InteractiveMode.prototype as unknown as ToggleThinkingHost)
				.toggleThinkingBlockVisibility,
			updateThinkingBlockVisibility: (InteractiveMode.prototype as unknown as ToggleThinkingHost)
				.updateThinkingBlockVisibility,
		};
	});

	test("toggling thinking updates visibility in-place without rebuilding or clearing running tool output", async () => {
		const initialChildren = [...fakeThis.chatContainer.children];
		expect(initialChildren).toContain(activeToolComponent);
		// Real transcript component actually shows the thinking content before the toggle.
		expect(transcriptAssistant.render(80).join("\n")).toContain("reasoning");

		const updateContentSpy = vi.spyOn(transcriptAssistant, "updateContent");

		await fakeThis.toggleThinkingBlockVisibility.call(fakeThis);

		// Verified in-place: rebuildChatFromMessages was NOT called
		expect(fakeThis.rebuildChatFromMessages).not.toHaveBeenCalled();
		// Active tool component is still in chatContainer exactly where it was
		expect(fakeThis.chatContainer.children).toEqual(initialChildren);
		// Partial output rendered by tool component is intact
		expect(activeToolComponent.render(80)).toEqual(["partial output line 1", "partial output line 2"]);
		// Visibility was flipped on streaming component and settings
		expect(fakeThis.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(fakeThis.streamingComponent?.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
		// The in-place path must not rebuild: setHideThinkingBlock never calls updateContent.
		expect(updateContentSpy).not.toHaveBeenCalled();
		// And the real transcript component actually repaints with the flipped visibility.
		expect(transcriptAssistant.render(80).join("\n")).not.toContain("reasoning");
	});

	test("AssistantMessageComponent.setHideThinkingBlock invalidates in place without calling updateContent (F4/E7)", () => {
		const component = new AssistantMessageComponent(message, false);
		const updateContentSpy = vi.spyOn(component, "updateContent");

		expect(component.render(80).join("\n")).toContain("reasoning");

		component.setHideThinkingBlock(true);

		expect(updateContentSpy).not.toHaveBeenCalled();
		expect(component.render(80).join("\n")).not.toContain("reasoning");

		component.setHideThinkingBlock(false);

		expect(updateContentSpy).not.toHaveBeenCalled();
		expect(component.render(80).join("\n")).toContain("reasoning");
	});

	test("settings-selector path updates thinking visibility in-place", () => {
		const host: SettingsSelectorHost = {
			session: {
				autoCompactionEnabled: true,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				thinkingLevel: "medium",
				getAvailableThinkingLevels: () => ["off", "medium", "high"],
			} as any,
			settingsManager: {
				getProjectSettings: () => ({}),
				getProfileRegistry: () => ({ listProfiles: () => [] }),
				getCostGuardSettings: () => ({ enabled: false }),
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getImageAutoResize: () => true,
				getBlockImages: () => false,
				getEnableSkillCommands: () => true,
				getTransport: () => "auto",
				getHttpIdleTimeoutMs: () => 300000,
				getTheme: () => "dark",
				isResourceAllowedByProfile: () => true,
				getHideThinkingBlock: () => false,
				getProjectContextFiles: () => "off",
				getProjectContextFilesScope: () => "global",
				getCollapseChangelog: () => false,
				getDoubleEscapeAction: () => "tree",
				getTreeFilterMode: () => "default",
				getShowHardwareCursor: () => false,
				getEditorPaddingX: () => 0,
				getAutocompleteMaxVisible: () => 5,
				getQuietStartup: () => false,
				getClearOnShrink: () => false,
				getShowTerminalProgress: () => false,
				getWarnings: () => ({}),
				getSelfModificationSettings: () => ({ enabled: false }),
				getAutonomySettings: () => ({ mode: "off", maxStallTurns: 20 }),
				getResearchLaneSettings: () => ({}),
				getWorkerDelegationSettings: () => ({}),
				getContextCurationSettings: () => ({}),
				getLearningPolicySettings: () => ({}),
				getModelCapabilitySettings: () => ({}),
				getModelRouterSettings: () => ({}),
				getAutoLearnSettings: () => ({}),
				getContextPromptEnforcementSettings: () => ({}),
				getMemoryRetrievalSettings: () => ({}),
				getActiveResourceProfileNames: () => [],
				getExternalResourceRoots: () => [],
				getTrustedResourceRoots: () => [],
				setHideThinkingBlock: vi.fn(),
			} as any,
			footer: {} as any,
			chatContainer: fakeThis.chatContainer,
			ui: fakeThis.ui as any,
			defaultEditor: {} as any,
			editor: {} as any,
			hideThinkingBlock: false,
			showSelector: vi.fn((create) => {
				const { component } = create(() => {});
				(component as any).settingsList.onChange("hide-thinking", "true");
				return { component, focus: component };
			}),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			getAutoLearnModelOptions: () => [],
			setupAutocompleteProvider: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildChatFromMessages: vi.fn(async () => {}),
			updateThinkingBlockVisibility: vi.fn(() => {
				fakeThis.updateThinkingBlockVisibility.call(fakeThis);
			}),
			validateSelfModificationSource: () => undefined,
			applyAutonomyMode: vi.fn(),
			validateAutoLearnModelValue: () => undefined,
			updateAutoLearnFooter: vi.fn(),
			handleResourcesHubAction: vi.fn(async () => {}),
		};

		showSettingsSelector(host);

		expect(host.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(host.updateThinkingBlockVisibility).toHaveBeenCalled();
		expect(host.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.children).toContain(activeToolComponent);
	});
});
