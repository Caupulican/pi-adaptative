/**
 * Auth / login / OAuth dialog controller.
 *
 * Extracted verbatim from interactive-mode.ts (god-file decomposition). Owns the /login and /logout
 * command flows: provider selection, subscription (OAuth) login dialogs, API-key login dialogs, the
 * Amazon Bedrock setup notice, the OAuth in-dialog select prompt, and post-login model adoption. It
 * holds NO state of its own — every credential/provider fact lives in session.modelRegistry.authStorage
 * — so it takes narrow deps (a live session accessor plus a UI callback surface, including the
 * editor-overlay-backed showSelector and the shared EditorOverlayHost for dialog swaps) rather than
 * the whole InteractiveMode instance.
 */

import * as path from "node:path";
import { getProviders, type Model, type OAuthProviderId, type OAuthSelectPrompt } from "@caupulican/pi-ai";
import type { Component, TUI } from "@caupulican/pi-tui";
import { getAuthPath, getDocsPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { cliProviderAliases, defaultModelPerProvider } from "../../core/model-resolver.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import type { EditorOverlayHost } from "./editor-overlay-host.ts";
import { theme } from "./theme/theme.ts";

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

export interface AuthDialogsControllerUi {
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	requestRender(): void;
	readonly tui: TUI;
	readonly overlayHost: EditorOverlayHost;
	getEditor(): Component;
	updateAvailableProviderCount(): Promise<void>;
	invalidateFooter(): void;
	updateEditorBorderColor(): void;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<any>): void;
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
}

export interface AuthDialogsControllerDeps {
	getSession(): AgentSession;
	ui: AuthDialogsControllerUi;
}

export class AuthDialogsController {
	private readonly deps: AuthDialogsControllerDeps;

	constructor(deps: AuthDialogsControllerDeps) {
		this.deps = deps;
	}

	private get session(): AgentSession {
		return this.deps.getSession();
	}
	private get ui(): AuthDialogsControllerUi {
		return this.deps.ui;
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private resolveAuthProviderOption(
		providerReference: string,
		providerOptions: AuthSelectorProvider[],
	): AuthSelectorProvider | undefined {
		const normalized = providerReference.trim().toLowerCase();
		if (!normalized) return undefined;
		const exactMatch = providerOptions.find((provider) => {
			const id = provider.id.toLowerCase();
			const name = provider.name.toLowerCase();
			return id === normalized || name === normalized;
		});
		if (exactMatch) return exactMatch;
		const aliasTarget = cliProviderAliases[normalized] ?? normalized;
		return providerOptions.find((provider) => {
			const id = provider.id.toLowerCase();
			const name = provider.name.toLowerCase();
			return id === aliasTarget || name === aliasTarget;
		});
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
			this.showBedrockSetupDialog(providerOption.id, providerOption.name);
		} else {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		}
	}

	private showLoginAuthTypeSelector(): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		this.ui.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel],
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType: "oauth" | "api_key"): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.ui.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}

		this.ui.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerReference?: string): Promise<void> {
		if (mode === "login") {
			if (providerReference) {
				const providerOptions = this.getLoginProviderOptions();
				const providerOption = this.resolveAuthProviderOption(providerReference, providerOptions);
				if (!providerOption) {
					this.ui.showError(
						`Unknown login provider "${providerReference}". Use /login to select from available providers.`,
					);
					return;
				}
				await this.startProviderLogin(providerOption);
				return;
			}
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.ui.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		if (providerReference) {
			const providerOption = this.resolveAuthProviderOption(providerReference, providerOptions);
			if (!providerOption) {
				this.ui.showError(
					`No stored credentials found for "${providerReference}". Use /logout to select a saved provider.`,
				);
				return;
			}
			try {
				this.session.modelRegistry.authStorage.logout(providerOption.id);
				this.session.modelRegistry.refresh();
				await this.ui.updateAvailableProviderCount();
				const message =
					providerOption.authType === "oauth"
						? `Logged out of ${providerOption.name}`
						: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
				this.ui.showStatus(message);
			} catch (error: unknown) {
				this.ui.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		this.ui.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.ui.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.ui.showStatus(message);
					} catch (error: unknown) {
						this.ui.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.ui.updateAvailableProviderCount();
		this.ui.invalidateFooter();
		this.ui.updateEditorBorderColor();
		if (selectedModel) {
			this.ui.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.ui.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.ui.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.ui.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.ui.showError(selectionError);
			} else {
				void this.ui.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const restoreEditor = () => {
			this.ui.overlayHost.swap(this.ui.getEditor());
		};

		const dialog = new LoginDialogComponent(
			this.ui.tui,
			providerId,
			() => restoreEditor(),
			providerName,
			"Amazon Bedrock setup",
		);
		dialog.showInfo([
			theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
			theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);

		this.ui.overlayHost.swap(dialog);
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui.tui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.ui.overlayHost.swap(dialog);

		const restoreEditor = () => {
			this.ui.overlayHost.swap(this.ui.getEditor());
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.ui.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.ui.overlayHost.swap(dialog);
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.ui.overlayHost.swap(selector);
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui.tui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		// Show dialog in editor container
		this.ui.overlayHost.swap(dialog);

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.ui.overlayHost.swap(this.ui.getEditor());
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onDeviceCode: (info) => {
					dialog.showDeviceCode(info);
					dialog.showWaiting("Waiting for authentication...");
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.ui.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}
}
