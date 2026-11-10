/**
 * Auth / login / OAuth dialog controller.
 *
 * Extracted verbatim from interactive-mode.ts (god-file decomposition). Owns the /login and /logout
 * command flows: provider selection, subscription (OAuth) login dialogs, API-key login dialogs, the
 * Amazon Bedrock setup notice, the OAuth in-dialog select prompt, and post-login model adoption. It
 * holds NO state of its own — every credential/provider fact lives in the model registry's authStorage
 * — so it takes narrow deps (a live session accessor plus a UI callback surface, including the
 * editor-overlay-backed showSelector and the shared EditorOverlayHost for dialog swaps) rather than
 * the whole InteractiveMode instance.
 */

import * as path from "node:path";
import { getProviders, type Model, type OAuthProviderId, type OAuthSelectPrompt } from "@caupulican/pi-ai";
import type { Component, TUI } from "@caupulican/pi-tui";
import { getAuthPath, getDocsPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	activateVerifiedBedrockScope,
	BEDROCK_PROVIDER_ID,
	type BedrockScopeVerificationRequest,
	verifyBedrockScope,
} from "../../core/bedrock-scope.ts";
import { type BedrockSsoLoginOptions, loginBedrockSsoProfile } from "../../core/bedrock-sso-login.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { cliProviderAliases, defaultModelPerProvider } from "../../core/model-resolver.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import { TYPESAFE_PROVIDER } from "../../core/review/typesafe-contract.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { theme } from "../../presentation/theme-model.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import type { EditorOverlayHost } from "./editor-overlay-host.ts";

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const LOGIN_CANCELLATION_MESSAGES = ["Login cancelled"] as const;
const BEDROCK_CANCELLATION_MESSAGES = ["Login cancelled", "AWS SSO login was cancelled"] as const;

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

/** The value behind the label a selector returned, so the words on screen never decide the branch the code takes. */
function valueOfLabel<T>(
	options: readonly { readonly label: string; readonly value: T }[],
	chosen: string,
): T | undefined {
	return options.find((option) => option.label === chosen)?.value;
}

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
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	ui: AuthDialogsControllerUi;
	loginBedrockSso?: (profile: string, options?: BedrockSsoLoginOptions) => Promise<void>;
	verifyBedrockScope?: typeof verifyBedrockScope;
}

export class AuthDialogsController {
	private readonly deps: AuthDialogsControllerDeps;
	private activeLoginDialog: LoginDialogComponent | undefined;
	private activeLoginDialogOnUnmount: (() => void) | undefined;
	private suppressActiveLoginDialogUnmount = false;
	private activeOAuthSelectorCancel: (() => void) | undefined;

	constructor(deps: AuthDialogsControllerDeps) {
		this.deps = deps;
	}

	private get session(): AgentSession {
		return this.deps.getSession();
	}
	private get settingsManager(): SettingsManager {
		return this.deps.getSettingsManager();
	}
	private get modelRegistry(): ModelRegistry {
		return this.deps.getModelRegistry();
	}
	private get ui(): AuthDialogsControllerUi {
		return this.deps.ui;
	}

	cancelActiveDialog(): void {
		const cancelSelector = this.activeOAuthSelectorCancel;
		this.activeOAuthSelectorCancel = undefined;
		cancelSelector?.();
		const dialog = this.activeLoginDialog;
		if (!dialog || !this.clearActiveDialog(dialog)) return;
		dialog.cancel();
		this.ui.overlayHost.swap(this.ui.getEditor());
	}

	private clearActiveDialog(dialog: LoginDialogComponent): boolean {
		if (this.activeLoginDialog !== dialog) return false;
		this.activeLoginDialog = undefined;
		this.activeLoginDialogOnUnmount = undefined;
		this.suppressActiveLoginDialogUnmount = false;
		return true;
	}

	private mountLoginDialog(dialog: LoginDialogComponent): void {
		this.activeLoginDialog = dialog;
		const onUnmount = () => {
			if (this.suppressActiveLoginDialogUnmount && this.activeLoginDialog === dialog) {
				this.suppressActiveLoginDialogUnmount = false;
				return;
			}
			if (!this.clearActiveDialog(dialog)) return;
			dialog.cancel();
		};
		this.activeLoginDialogOnUnmount = onUnmount;
		this.ui.overlayHost.swap(dialog, { onUnmount });
	}

	private restoreEditorFromDialog(dialog: LoginDialogComponent): boolean {
		if (!this.clearActiveDialog(dialog)) return false;
		this.ui.overlayHost.swap(this.ui.getEditor());
		return true;
	}

	private detachLoginDialogForSelector(dialog: LoginDialogComponent): void {
		if (this.activeLoginDialog === dialog && this.activeLoginDialogOnUnmount) {
			this.suppressActiveLoginDialogUnmount = true;
		}
	}

	private remountLoginDialog(dialog: LoginDialogComponent): boolean {
		if (this.activeLoginDialog !== dialog || !this.activeLoginDialogOnUnmount) return false;
		this.ui.overlayHost.swap(dialog, { onUnmount: this.activeLoginDialogOnUnmount });
		return true;
	}

	private async runMountedLoginDialog(
		dialog: LoginDialogComponent,
		authenticate: () => Promise<void>,
		onAuthenticated: () => Promise<void>,
		errorPrefix: string,
		cancellationMessages: readonly string[] = LOGIN_CANCELLATION_MESSAGES,
	): Promise<void> {
		try {
			await authenticate();
			if (!this.restoreEditorFromDialog(dialog)) return;
			await onAuthenticated();
		} catch (error: unknown) {
			if (!this.restoreEditorFromDialog(dialog)) return;
			const message = error instanceof Error ? error.message : String(error);
			if (!cancellationMessages.includes(message)) this.ui.showError(`${errorPrefix}${message}`);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
			loginLabel: provider.loginLabel,
		}));

		const modelProviders = new Set(this.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}
		if (!options.some((option) => option.id === TYPESAFE_PROVIDER)) {
			options.push({ id: TYPESAFE_PROVIDER, name: "TypeSafe (System One)", authType: "api_key" });
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.modelRegistry.getProviderDisplayName(providerId),
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

	private async logoutProvider(providerOption: AuthSelectorProvider): Promise<void> {
		try {
			this.modelRegistry.authStorage.logout(providerOption.id);
			await this.session.refreshModelsAfterAuthChange(providerOption.id);
			await this.ui.updateAvailableProviderCount();
			const text = interfaceText().dialogs.authDialogs;
			const message =
				providerOption.authType === "oauth"
					? text.loggedOut(providerOption.name)
					: text.apiKeyRemoved(providerOption.name);
			this.ui.showStatus(message);
		} catch (error: unknown) {
			this.ui.showError(
				interfaceText().dialogs.authDialogs.logoutFailed(error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private showLoginAuthTypeSelector(): void {
		const text = interfaceText().dialogs.authDialogs;
		// The method's own id decides the flow; the label is only what the selector hands back.
		const methods: readonly { readonly value: "oauth" | "api_key"; readonly label: string }[] = [
			{ value: "oauth", label: text.methodSubscription },
			{ value: "api_key", label: text.methodApiKey },
		];
		this.ui.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				text.methodTitle,
				methods.map((method) => method.label),
				(chosen) => {
					done();
					const authType = valueOfLabel(methods, chosen);
					if (authType) this.showLoginProviderSelector(authType);
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
			const text = interfaceText().dialogs.authDialogs;
			this.ui.showStatus(authType === "oauth" ? text.noSubscriptionProviders : text.noApiKeyProviders);
			return;
		}

		this.showProviderSelector(
			"login",
			providerOptions,
			(providerOption) => this.startProviderLogin(providerOption),
			() => this.showLoginAuthTypeSelector(),
		);
	}

	private showProviderSelector(
		mode: "login" | "logout",
		providerOptions: AuthSelectorProvider[],
		onSelect: (providerOption: AuthSelectorProvider) => Promise<void>,
		onCancel: () => void,
	): void {
		this.ui.showSelector((done) => {
			let settled = false;
			const finish = () => {
				if (settled) return false;
				settled = true;
				done();
				return true;
			};
			const selector = new OAuthSelectorComponent(
				mode,
				this.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					if (!finish()) return;
					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (providerOption) await onSelect(providerOption);
				},
				() => {
					if (finish()) onCancel();
				},
				mode === "login" ? (providerId) => this.modelRegistry.getProviderAuthStatus(providerId) : undefined,
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
					this.ui.showError(interfaceText().dialogs.authDialogs.unknownLoginProvider(providerReference));
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
			this.ui.showStatus(interfaceText().dialogs.authDialogs.noStoredCredentials);
			return;
		}

		if (providerReference) {
			const providerOption = this.resolveAuthProviderOption(providerReference, providerOptions);
			if (!providerOption) {
				this.ui.showError(interfaceText().dialogs.authDialogs.noStoredCredentialsFor(providerReference));
				return;
			}
			await this.logoutProvider(providerOption);
			return;
		}

		this.showProviderSelector(
			mode,
			providerOptions,
			(providerOption) => this.logoutProvider(providerOption),
			() => this.ui.requestRender(),
		);
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		await this.session.refreshModelsAfterAuthChange(providerId);
		const text = interfaceText().dialogs.authDialogs;
		if (providerId === TYPESAFE_PROVIDER) {
			this.ui.showStatus(text.typesafeStatus);
			return;
		}

		const actionLabel = authType === "oauth" ? text.loggedIn(providerName) : text.apiKeySaved(providerName);

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = text.noDefaultModel(actionLabel, providerId);
			} else if (providerModels.length === 0) {
				selectionError = text.noModels(actionLabel);
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = text.defaultModelUnavailable(actionLabel, defaultModelId);
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = text.selectModelFailed(actionLabel, errorMessage);
					}
				}
			}
		}

		await this.ui.updateAvailableProviderCount();
		this.ui.invalidateFooter();
		this.ui.updateEditorBorderColor();
		if (selectedModel) {
			this.ui.showStatus(text.statusSelected(actionLabel, selectedModel.id, getAuthPath()));
			void this.ui.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.ui.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.ui.showStatus(text.statusSaved(actionLabel, getAuthPath()));
			if (selectionError) {
				this.ui.showError(selectionError);
			} else {
				void this.ui.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const text = interfaceText().dialogs.authDialogs;
		const configuredProfile = this.getConfiguredBedrockProfile();
		const ssoLabel = configuredProfile ? text.bedrockSsoProfile(configuredProfile) : text.bedrockSso;
		const otherLabel = text.bedrockOther;
		// Whichever way the owner signs in is a value of its own; the labels only carry it to the screen.
		const routes: readonly { readonly value: "sso" | "credentials"; readonly label: string }[] = [
			{ value: "sso", label: ssoLabel },
			{ value: "credentials", label: otherLabel },
		];
		this.ui.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				text.bedrockTitle,
				routes.map((route) => route.label),
				(chosen) => {
					done();
					if (valueOfLabel(routes, chosen) === "sso") void this.showBedrockSsoDialog(providerId, providerName);
					else void this.showBedrockCredentialInfoDialog(providerId, providerName);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private getConfiguredBedrockProfile(): string | undefined {
		return process.env.AWS_PROFILE?.trim() || this.settingsManager.getBedrockScopeSettings()?.profile;
	}

	private getConfiguredBedrockRegion(): string {
		return (
			process.env.AWS_REGION?.trim() ||
			this.settingsManager.getBedrockScopeSettings()?.region ||
			process.env.AWS_DEFAULT_REGION?.trim() ||
			"us-east-1"
		);
	}

	private async verifyAndActivateBedrockScope(
		request: BedrockScopeVerificationRequest,
	): Promise<Awaited<ReturnType<typeof verifyBedrockScope>>> {
		const scope = await (this.deps.verifyBedrockScope ?? verifyBedrockScope)(request, this.modelRegistry);
		activateVerifiedBedrockScope(this.settingsManager, this.modelRegistry, scope);
		return scope;
	}

	private async completeBedrockSetup(
		scope: Awaited<ReturnType<typeof verifyBedrockScope>>,
		message: string,
	): Promise<void> {
		this.modelRegistry.refresh();
		await this.ui.updateAvailableProviderCount();
		this.ui.invalidateFooter();
		this.ui.updateEditorBorderColor();
		this.ui.showStatus(
			interfaceText().dialogs.authDialogs.bedrockVerified(message, scope.modelIds.length, scope.region),
		);
	}

	/** The login dialog a Bedrock setup draws, already mounted over the editor. */
	private bedrockDialog(providerId: string, providerName: string, title: string): LoginDialogComponent {
		const dialog = new LoginDialogComponent(
			this.ui.tui,
			providerId,
			() => {
				this.restoreEditorFromDialog(dialog);
			},
			providerName,
			title,
		);
		this.mountLoginDialog(dialog);
		return dialog;
	}

	private async showBedrockCredentialInfoDialog(providerId: string, providerName: string): Promise<void> {
		this.cancelActiveDialog();
		const text = interfaceText().dialogs.authDialogs;
		const dialog = this.bedrockDialog(providerId, providerName, text.bedrockCredentialInfoTitle);
		dialog.showInfo([
			theme.fg("text", text.bedrockCredentialUses),
			theme.fg("text", text.bedrockCredentialConfigure),
			theme.fg("muted", text.see),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);
		this.mountLoginDialog(dialog);
		let scope: Awaited<ReturnType<typeof verifyBedrockScope>> | undefined;
		await this.runMountedLoginDialog(
			dialog,
			async () => {
				const region = (await dialog.showPrompt(text.regionPrompt, this.getConfiguredBedrockRegion())).trim();
				if (!region) throw new Error(text.regionEmpty);
				dialog.showProgress(text.verifyingAws);
				scope = await this.verifyAndActivateBedrockScope({
					region,
					profile: process.env.AWS_PROFILE?.trim(),
					signal: dialog.signal,
					credentialMode: "ambient",
				});
			},
			async () => {
				if (!scope) return;
				await this.completeBedrockSetup(scope, text.bedrockReady);
			},
			text.configureFailed(providerName),
			BEDROCK_CANCELLATION_MESSAGES,
		);
	}

	private async showBedrockSsoDialog(providerId: string, providerName: string): Promise<void> {
		this.cancelActiveDialog();
		const text = interfaceText().dialogs.authDialogs;
		const dialog = this.bedrockDialog(providerId, providerName, text.bedrockSsoTitle);
		let profile = "";
		let scope: Awaited<ReturnType<typeof verifyBedrockScope>> | undefined;
		await this.runMountedLoginDialog(
			dialog,
			async () => {
				const configuredProfile = this.getConfiguredBedrockProfile();
				profile =
					configuredProfile ?? (await dialog.showPrompt(text.ssoProfilePrompt, text.ssoProfileExample)).trim();
				if (!profile) throw new Error(text.profileEmpty);
				const region = (await dialog.showPrompt(text.regionPrompt, this.getConfiguredBedrockRegion())).trim();
				if (!region) throw new Error(text.regionEmpty);

				if (configuredProfile) {
					dialog.showInfo([
						theme.fg("text", text.usingProfile(profile)),
						theme.fg("text", text.bedrockRegion(region)),
						theme.fg("muted", text.finishSignIn),
					]);
				}
				dialog.showProgress(text.waitingForSso);
				await (this.deps.loginBedrockSso ?? loginBedrockSsoProfile)(profile, { signal: dialog.signal });
				dialog.showProgress(text.verifyingAws);
				scope = await this.verifyAndActivateBedrockScope({
					profile,
					region,
					signal: dialog.signal,
					credentialMode: "profile",
				});
			},
			async () => {
				if (!scope) return;
				await this.completeBedrockSetup(scope, text.bedrockSignedIn(profile));
			},
			text.signInFailed(providerName),
			BEDROCK_CANCELLATION_MESSAGES,
		);
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		this.cancelActiveDialog();
		const previousModel = this.session.model;
		const text = interfaceText().dialogs.authDialogs;

		const dialog = new LoginDialogComponent(
			this.ui.tui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.mountLoginDialog(dialog);
		await this.runMountedLoginDialog(
			dialog,
			async () => {
				const apiKey = (await dialog.showPrompt(text.apiKeyPrompt)).trim();
				if (!apiKey) throw new Error(text.apiKeyEmpty);
				const saved = this.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
				if (saved === false) throw new Error(text.apiKeyNotSaved);
			},
			() => this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel),
			text.saveApiKeyFailed(providerName),
		);
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		this.activeOAuthSelectorCancel?.();
		return new Promise((resolve) => {
			let settled = false;
			let selector: ExtensionSelectorComponent;
			const finish = (value: string | undefined, restoreDialog = true) => {
				if (settled) return;
				settled = true;
				if (this.activeOAuthSelectorCancel === cancel) this.activeOAuthSelectorCancel = undefined;
				selector.dispose();
				if (restoreDialog) {
					this.remountLoginDialog(dialog);
				} else if (this.clearActiveDialog(dialog)) {
					dialog.cancel();
				}
				resolve(value);
			};
			const cancel = () => finish(undefined);
			this.activeOAuthSelectorCancel = cancel;
			const labels = prompt.options.map((option) => option.label);
			selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => finish(prompt.options.find((option) => option.label === optionLabel)?.id),
				cancel,
			);
			this.detachLoginDialogForSelector(dialog);
			this.ui.overlayHost.swap(selector, { onUnmount: () => finish(undefined, false) });
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		this.cancelActiveDialog();
		const providerInfo = this.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;
		const text = interfaceText().dialogs.authDialogs;

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
		this.mountLoginDialog(dialog);

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		await this.runMountedLoginDialog(
			dialog,
			() =>
				this.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
					onAuth: (info: { url: string; instructions?: string }) => {
						dialog.showAuth(info.url, info.instructions);

						if (usesCallbackServer) {
							// Show input for manual paste, racing with callback
							dialog
								.showManualInput(text.manualCodePrompt)
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
						dialog.showWaiting(text.waitingForAuth);
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
				}),
			() => this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel),
			text.loginFailed(providerName),
		);
	}
}
