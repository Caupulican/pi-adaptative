import { describe, expect, it, vi } from "vitest";
import type { NormalizedProfile } from "../src/core/profile-registry.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ProfileApplyContext = {
	settingsManager: {
		getProfileRegistry: () => {
			getProfile: (name: string) => NormalizedProfile | undefined;
			resolveProfileRef: (ref: string, fromDir: string) => NormalizedProfile | undefined;
		};
		setRuntimeResourceProfiles: (profiles: string[]) => void;
		setActiveProfile: (name: string | undefined, scope: string) => void;
	};
	sessionManager: {
		getCwd: () => string;
	};
	session: {
		modelRegistry: {
			getAll: () => Array<{ provider: string; id: string; name?: string }>;
			refresh: () => void;
		};
		sessionManager: {
			appendCustomEntry: (key: string, value: unknown) => void;
		};
		setModel: (
			model: { provider: string; id: string; name?: string },
			options?: { persistSettings?: boolean },
		) => void;
		setThinkingLevel: (thinking: string, options?: { persistSettings?: boolean }) => void;
	};
	handleReloadCommand: () => Promise<void>;
	footerDataProvider: {
		setExtensionStatus: (statusType: string, value: string) => void;
	};
	footer: {
		invalidate: () => void;
	};
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	maybeWarnAboutAnthropicSubscriptionAuth: (model: { provider: string; id: string; name?: string }) => void;
	checkDaxnutsEasterEgg: (model: { provider: string; id: string; name?: string }) => void;
};

type InteractiveModeProfilePrototype = {
	applyProfile(this: ProfileApplyContext, profileName: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeProfilePrototype;

describe("InteractiveMode /profiles", () => {
	it("resolves relative profile refs from cwd before applying", async () => {
		const profileRegistryResolve = vi
			.fn<(ref: string, fromDir: string) => NormalizedProfile | undefined>()
			.mockReturnValue({
				name: "reviewer",
				resources: {
					skills: {
						allow: ["read"],
					},
				},
				source: "profile-file",
				sourcePath: "/tmp/workspace/.pi/reviewer.json",
			});
		const setRuntimeResourceProfiles = vi.fn();
		const setActiveProfile = vi.fn();
		const appendCustomEntry = vi.fn();
		const handleReloadCommand = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ProfileApplyContext = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			settingsManager: {
				getProfileRegistry: () => ({
					getProfile: vi.fn(),
					resolveProfileRef: profileRegistryResolve,
				}),
				setRuntimeResourceProfiles,
				setActiveProfile,
			},
			session: {
				modelRegistry: {
					getAll: () => [{ provider: "openai", id: "gpt-4-mini", name: "gpt-4-mini" }],
					refresh: vi.fn(),
				},
				sessionManager: { appendCustomEntry },
				setModel: vi.fn(),
				setThinkingLevel: vi.fn(),
			},
			handleReloadCommand,
			footerDataProvider: { setExtensionStatus: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus,
			showError,
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};

		await interactiveModePrototype.applyProfile.call(context, "./reviewer.json");

		expect(profileRegistryResolve).toHaveBeenCalledWith("./reviewer.json", "/tmp/workspace");
		expect(context.settingsManager.setRuntimeResourceProfiles).toHaveBeenCalledWith(["reviewer"]);
		expect(appendCustomEntry).toHaveBeenCalledWith("pi.activeResourceProfiles", {
			profiles: ["reviewer"],
		});
		expect(handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Profile: reviewer");
		expect(showError).not.toHaveBeenCalled();
	});

	it("uses registry lookup for name-only profiles", async () => {
		const profileByName: NormalizedProfile = {
			name: "core-setup",
			resources: {
				extensions: {
					block: ["noisy"],
				},
			},
			source: "global-settings",
		};
		const getProfile = vi.fn<(name: string) => NormalizedProfile | undefined>(() => profileByName);
		const resolveProfileRef = vi.fn<(ref: string, fromDir: string) => NormalizedProfile | undefined>();
		const setRuntimeResourceProfiles = vi.fn();
		const setActiveProfile = vi.fn();
		const appendCustomEntry = vi.fn();
		const handleReloadCommand = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ProfileApplyContext = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			settingsManager: {
				getProfileRegistry: () => ({
					getProfile,
					resolveProfileRef,
				}),
				setRuntimeResourceProfiles,
				setActiveProfile,
			},
			session: {
				modelRegistry: {
					getAll: () => [{ provider: "openai", id: "gpt-4-mini", name: "gpt-4-mini" }],
					refresh: vi.fn(),
				},
				sessionManager: { appendCustomEntry },
				setModel: vi.fn(),
				setThinkingLevel: vi.fn(),
			},
			handleReloadCommand,
			footerDataProvider: { setExtensionStatus: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus,
			showError,
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};

		await interactiveModePrototype.applyProfile.call(context, "core-setup");

		expect(getProfile).toHaveBeenCalledWith("core-setup");
		expect(resolveProfileRef).not.toHaveBeenCalled();
		expect(context.settingsManager.setRuntimeResourceProfiles).toHaveBeenCalledWith(["core-setup"]);
		expect(appendCustomEntry).toHaveBeenCalledWith("pi.activeResourceProfiles", {
			profiles: ["core-setup"],
		});
		expect(showStatus).toHaveBeenCalledWith("Profile: core-setup");
		expect(showError).not.toHaveBeenCalled();
	});

	it("applies profile model and thinking changes without persistence", async () => {
		const profileWithModel: NormalizedProfile = {
			name: "runtime-model",
			model: "openai/gpt-4-mini",
			thinking: "low",
			resources: {
				extensions: {
					allow: ["ext"],
				},
			},
			source: "global-settings",
		};
		const getProfile = vi.fn<(name: string) => NormalizedProfile | undefined>(() => profileWithModel);
		const resolveProfileRef = vi.fn<(ref: string, fromDir: string) => NormalizedProfile | undefined>();
		const setRuntimeResourceProfiles = vi.fn();
		const setActiveProfile = vi.fn();
		const setModel = vi.fn();
		const setThinkingLevel = vi.fn();
		const modelRegistryRefresh = vi.fn();
		const appendCustomEntry = vi.fn();
		const handleReloadCommand = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ProfileApplyContext = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			settingsManager: {
				getProfileRegistry: () => ({
					getProfile,
					resolveProfileRef,
				}),
				setRuntimeResourceProfiles,
				setActiveProfile,
			},
			session: {
				modelRegistry: {
					getAll: () => [{ provider: "openai", id: "gpt-4-mini", name: "gpt-4-mini" }],
					refresh: modelRegistryRefresh,
				},
				sessionManager: { appendCustomEntry },
				setModel,
				setThinkingLevel,
			},
			handleReloadCommand,
			footerDataProvider: { setExtensionStatus: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus,
			showError,
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};

		await interactiveModePrototype.applyProfile.call(context, "runtime-model");

		expect(modelRegistryRefresh).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(
			{ provider: "openai", id: "gpt-4-mini", name: "gpt-4-mini" },
			{ persistSettings: false },
		);
		expect(setThinkingLevel).toHaveBeenCalledWith("low", { persistSettings: false });
		expect(context.settingsManager.setRuntimeResourceProfiles).toHaveBeenCalledWith(["runtime-model"]);
		expect(appendCustomEntry).toHaveBeenCalledWith("pi.activeResourceProfiles", {
			profiles: ["runtime-model"],
		});
		expect(showStatus).toHaveBeenCalledWith("Profile: runtime-model");
		expect(showError).not.toHaveBeenCalled();
	});
});
