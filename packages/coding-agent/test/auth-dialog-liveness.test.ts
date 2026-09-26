import type { Api, Model } from "@caupulican/pi-ai";
import { Container } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountModelCatalog } from "../src/core/model-router/account-models.ts";
import { AuthDialogsController } from "../src/modes/interactive/auth-dialogs-controller.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const originalAwsProfile = process.env.AWS_PROFILE;
const originalAwsRegion = process.env.AWS_REGION;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAwsProfile === undefined) delete process.env.AWS_PROFILE;
	else process.env.AWS_PROFILE = originalAwsProfile;
	if (originalAwsRegion === undefined) delete process.env.AWS_REGION;
	else process.env.AWS_REGION = originalAwsRegion;
});

describe("authentication dialog liveness", () => {
	it("refreshes account availability after logout before reporting success", async () => {
		const model = { provider: "openrouter", id: "deepseek/x", baseUrl: "https://openrouter.ai/api/v1" } as Model<Api>;
		let configured = true;
		const accountModels = new AccountModelCatalog({
			getModels: () => [model],
			hasConfiguredAuth: () => configured,
			getRequestAuth: async () => ({ apiKey: "rejected-key" }),
			fetch: async () => new Response("{}", { status: 401 }),
		});
		await accountModels.refresh();
		expect(accountModels.availability(model)).toBe("unavailable");
		const order: string[] = [];
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					modelRegistry: {
						authStorage: {
							list: () => ["openrouter"],
							get: () => ({ type: "api_key", key: "secret" }),
							logout: () => {
								order.push("logout");
								configured = false;
							},
						},
						getProviderDisplayName: () => "OpenRouter",
						refresh: () => order.push("uncoordinated-registry"),
					},
					refreshModelsAfterAuthChange: async (provider: string) => {
						order.push("registry");
						order.push(`account:${provider}`);
						await accountModels.refreshAfterAuthChange(provider);
					},
				}) as never,
			ui: {
				updateAvailableProviderCount: async () => {
					order.push("count");
				},
				showStatus: () => order.push("status"),
				showError: vi.fn(),
			} as never,
		});

		await controller.showOAuthSelector("logout", "openrouter");

		expect(accountModels.availability(model)).toBe("unknown");
		expect(order).toEqual(["logout", "registry", "account:openrouter", "count", "status"]);
	});

	it("waits for account availability refresh before reporting login success", async () => {
		const refresh = Promise.withResolvers<void>();
		const refreshModelsAfterAuthChange = vi.fn(() => refresh.promise);
		const updateAvailableProviderCount = vi.fn(async () => {});
		const showStatus = vi.fn();
		const previousModel = { provider: "openrouter", id: "deepseek/x" } as Model<Api>;
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					model: previousModel,
					modelRegistry: { refresh: vi.fn() },
					refreshModelsAfterAuthChange,
				}) as never,
			ui: {
				updateAvailableProviderCount,
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				showStatus,
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			} as never,
		});
		const completion = (
			controller as unknown as {
				completeProviderAuthentication(
					providerId: string,
					providerName: string,
					authType: "oauth" | "api_key",
					previousModel: Model<Api> | undefined,
				): Promise<void>;
			}
		).completeProviderAuthentication("openrouter", "OpenRouter", "api_key", previousModel);
		await Promise.resolve();

		expect(refreshModelsAfterAuthChange).toHaveBeenCalledWith("openrouter");
		expect(updateAvailableProviderCount).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		refresh.resolve();
		await completion;
		expect(updateAvailableProviderCount).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Saved API key for OpenRouter"));
	});

	it("closes and focuses the provider selector before dispatching its selected action", async () => {
		const order: string[] = [];
		let mounted: { component: unknown; focus: unknown } | undefined;
		const done = vi.fn(() => order.push("done"));
		const logout = vi.fn(() => order.push("logout"));
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					modelRegistry: {
						authStorage: {
							list: () => ["test-provider"],
							get: () => ({ type: "api_key", key: "secret" }),
							getAuthStatus: () => ({ configured: true, source: "stored" }),
							logout,
						},
						getProviderDisplayName: () => "Test Provider",
						refresh: vi.fn(),
					},
					refreshModelsAfterAuthChange: async () => order.push("refresh"),
				}) as never,
			ui: {
				showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => {
					mounted = create(done);
				},
				updateAvailableProviderCount: vi.fn(async () => {}),
				showStatus: vi.fn(),
			} as never,
		});

		await controller.showOAuthSelector("logout");
		expect(mounted?.component).toBeInstanceOf(OAuthSelectorComponent);
		expect(mounted?.focus).toBe(mounted?.component);
		if (!(mounted?.component instanceof OAuthSelectorComponent)) throw new Error("expected provider selector");
		mounted.component.handleInput("\r");
		await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce());

		expect(order).toEqual(["done", "logout", "refresh"]);
	});

	it("reports API-key and OAuth failures only after restoring the editor", async () => {
		const editor = { render: () => [] };
		const events: string[] = [];
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("api-key");
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					model: { provider: "test-provider", id: "test-model" },
					modelRegistry: {
						authStorage: {
							set: () => {
								throw new Error("write failed");
							},
							getOAuthProviders: () => [{ id: "test-provider", usesCallbackServer: false }],
							login: async () => {
								throw new Error("provider unavailable");
							},
						},
					},
				}) as never,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost: {
					swap: (component: unknown) => {
						events.push(component === editor ? "restore" : "mount");
					},
				},
				getEditor: () => editor,
				showError: (message: string) => events.push(message),
			} as never,
		});
		const privateController = controller as unknown as {
			showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
			showLoginDialog(providerId: string, providerName: string): Promise<void>;
		};

		await privateController.showApiKeyLoginDialog("test-provider", "Test Provider");
		await privateController.showLoginDialog("test-provider", "Test Provider");

		expect(events).toEqual([
			"mount",
			"restore",
			"Failed to save API key for Test Provider: write failed",
			"mount",
			"restore",
			"Failed to login to Test Provider: provider unavailable",
		]);
	});

	it("cancels a pending prompt exactly once", async () => {
		const onComplete = vi.fn();
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as never, "test-provider", onComplete);
		const prompt = dialog.showPrompt("API key");

		dialog.cancel();
		dialog.cancel();

		await expect(prompt).rejects.toThrow("Login cancelled");
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it("rejects a displaced input prompt instead of orphaning its promise", async () => {
		const onComplete = vi.fn();
		const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as never, "test-provider", onComplete);
		const first = dialog.showPrompt("First value");
		const second = dialog.showPrompt("Second value");

		await expect(first).rejects.toThrow("Login input superseded");
		dialog.cancel();
		await expect(second).rejects.toThrow("Login cancelled");
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it("settles an active API-key dialog when the controller is cancelled", async () => {
		const editor = { render: () => [] };
		const overlayHost = { swap: vi.fn() };
		const showError = vi.fn();
		const session = {
			model: { provider: "test-provider", id: "test-model" },
			modelRegistry: { authStorage: { set: vi.fn() } },
		};
		const controller = new AuthDialogsController({
			getSession: () => session as never,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost,
				getEditor: () => editor,
				showError,
			} as never,
		});
		const showApiKeyDialog = (
			controller as unknown as {
				showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showApiKeyLoginDialog.bind(controller);
		const pending = showApiKeyDialog("test-provider", "Test Provider");

		controller.cancelActiveDialog();

		await expect(pending).resolves.toBeUndefined();
		expect(showError).not.toHaveBeenCalled();
		expect(overlayHost.swap).toHaveBeenLastCalledWith(editor);
	});

	it("settles a login without restoring over an overlay that superseded its dialog", async () => {
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const replacement = { render: () => ["replacement"], invalidate: () => {} };
		const container = new Container();
		const overlayHost = new EditorOverlayHost(container, {
			setFocus: vi.fn(),
			restoreFocus: vi.fn(),
			requestRender: vi.fn(),
		});
		const showError = vi.fn();
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					model: { provider: "test-provider", id: "test-model" },
					modelRegistry: { authStorage: { set: vi.fn() } },
				}) as never,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost,
				getEditor: () => editor,
				showError,
			} as never,
		});
		const showApiKeyDialog = (
			controller as unknown as {
				showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showApiKeyLoginDialog.bind(controller);
		const pending = showApiKeyDialog("test-provider", "Test Provider");

		overlayHost.swap(replacement);
		const outcome = await Promise.race([
			pending.then(() => "settled"),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		]);

		expect(outcome).toBe("settled");
		expect(showError).not.toHaveBeenCalled();
		expect(container.children).toEqual([replacement]);
	});

	it("settles a nested OAuth selector when another overlay supersedes it", async () => {
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const replacement = { render: () => ["replacement"], invalidate: () => {} };
		const container = new Container();
		const overlayHost = new EditorOverlayHost(container, {
			setFocus: vi.fn(),
			restoreFocus: vi.fn(),
			requestRender: vi.fn(),
		});
		const showError = vi.fn();
		const login = vi.fn(async (_providerId: string, options: Record<string, unknown>) => {
			const onSelect = options.onSelect as (prompt: {
				message: string;
				options: Array<{ id: string; label: string }>;
			}) => Promise<string | undefined>;
			await onSelect({ message: "Choose account", options: [{ id: "one", label: "One" }] });
			throw new Error("Login cancelled");
		});
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					model: { provider: "test-provider", id: "test-model" },
					modelRegistry: {
						authStorage: {
							getOAuthProviders: () => [{ id: "test-provider", usesCallbackServer: false }],
							login,
						},
					},
				}) as never,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost,
				getEditor: () => editor,
				showError,
			} as never,
		});
		const showLoginDialog = (
			controller as unknown as {
				showLoginDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showLoginDialog.bind(controller);
		const pending = showLoginDialog("test-provider", "Test Provider");

		overlayHost.swap(replacement);
		await expect(pending).resolves.toBeUndefined();
		expect(login).toHaveBeenCalledOnce();
		expect(showError).not.toHaveBeenCalled();
		expect(container.children).toEqual([replacement]);
	});

	it("runs Bedrock login for the configured profile and restores the editor", async () => {
		process.env.AWS_PROFILE = "work-sso";
		delete process.env.AWS_REGION;
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("us-east-2");
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const overlayHost = { swap: vi.fn() };
		const showError = vi.fn();
		const showStatus = vi.fn();
		const loginBedrockSso = vi.fn(async () => {});
		const verifiedScope = {
			region: "us-east-2",
			profile: "work-sso",
			modelIds: ["us.anthropic.claude-sonnet-5"],
			verifiedAt: "2026-08-03T12:00:00.000Z",
			verification: "identity+control-plane+runtime" as const,
		};
		const verifyBedrockScope = vi.fn(async () => verifiedScope);
		const setBedrockScopeSettings = vi.fn();
		const setProviderModelScope = vi.fn();
		const refresh = vi.fn();
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					settingsManager: {
						getBedrockScopeSettings: () => ({
							region: "us-west-2",
							profile: "old-sso",
							modelIds: ["us.anthropic.claude-opus-4-6-v1"],
							verifiedAt: "2026-08-02T12:00:00.000Z",
							verification: "identity+control-plane+runtime",
						}),
						setBedrockScopeSettings,
					},
					modelRegistry: { getAll: () => [], refresh, setProviderModelScope },
				}) as never,
			loginBedrockSso,
			verifyBedrockScope,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost,
				getEditor: () => editor,
				showError,
				showStatus,
				updateAvailableProviderCount: vi.fn(async () => {}),
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
			} as never,
		});
		const showBedrockDialog = (
			controller as unknown as {
				showBedrockSsoDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showBedrockSsoDialog.bind(controller);

		await showBedrockDialog("amazon-bedrock", "Amazon Bedrock");

		expect(loginBedrockSso).toHaveBeenCalledWith("work-sso", expect.objectContaining({ signal: expect.anything() }));
		expect(verifyBedrockScope).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work-sso",
				region: "us-east-2",
				signal: expect.anything(),
				credentialMode: "profile",
			}),
			expect.anything(),
		);
		expect(setBedrockScopeSettings).toHaveBeenCalledWith(verifiedScope);
		expect(setProviderModelScope).toHaveBeenCalledWith("amazon-bedrock", verifiedScope.modelIds);
		expect(process.env.AWS_REGION).toBe("us-east-2");
		expect(refresh).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining('AWS profile "work-sso"'));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("1 model in us-east-2"));
		expect(showError).not.toHaveBeenCalled();
		expect(overlayHost.swap).toHaveBeenLastCalledWith(editor);
	});

	it("does not start SSO when the mandatory Bedrock region is empty", async () => {
		process.env.AWS_PROFILE = "work-sso";
		delete process.env.AWS_REGION;
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("   ");
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const showError = vi.fn();
		const loginBedrockSso = vi.fn(async () => {});
		const verifyBedrockScope = vi.fn();
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					settingsManager: { getBedrockScopeSettings: () => undefined },
					modelRegistry: {},
				}) as never,
			loginBedrockSso,
			verifyBedrockScope,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost: { swap: vi.fn() },
				getEditor: () => editor,
				showError,
			} as never,
		});

		await (
			controller as unknown as {
				showBedrockSsoDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showBedrockSsoDialog("amazon-bedrock", "Amazon Bedrock");

		expect(loginBedrockSso).not.toHaveBeenCalled();
		expect(verifyBedrockScope).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("AWS region cannot be empty"));
	});

	it("verifies ambient IAM or bearer credentials in us-east-2 without invoking SSO", async () => {
		delete process.env.AWS_PROFILE;
		delete process.env.AWS_REGION;
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("us-east-2");
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const scope = {
			region: "us-east-2",
			modelIds: ["us.anthropic.claude-sonnet-5"],
			verifiedAt: "2026-08-03T12:00:00.000Z",
			verification: "runtime" as const,
		};
		const verifyBedrockScope = vi.fn(async () => scope);
		const setBedrockScopeSettings = vi.fn();
		const setProviderModelScope = vi.fn();
		const showStatus = vi.fn();
		const controller = new AuthDialogsController({
			getSession: () =>
				({
					settingsManager: {
						getBedrockScopeSettings: () => ({
							region: "us-west-2",
							profile: "old-sso",
							modelIds: ["us.anthropic.claude-opus-4-6-v1"],
							verifiedAt: "2026-08-02T12:00:00.000Z",
							verification: "identity+control-plane+runtime",
						}),
						setBedrockScopeSettings,
					},
					modelRegistry: { getAll: () => [], setProviderModelScope, refresh: vi.fn() },
				}) as never,
			verifyBedrockScope,
			ui: {
				tui: { requestRender: vi.fn() },
				overlayHost: { swap: vi.fn() },
				getEditor: () => editor,
				showError: vi.fn(),
				showStatus,
				updateAvailableProviderCount: vi.fn(async () => {}),
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
			} as never,
		});

		await (
			controller as unknown as {
				showBedrockCredentialInfoDialog(providerId: string, providerName: string): Promise<void>;
			}
		).showBedrockCredentialInfoDialog("amazon-bedrock", "Amazon Bedrock");

		expect(verifyBedrockScope).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-east-2",
				profile: undefined,
				signal: expect.anything(),
				credentialMode: "ambient",
			}),
			expect.anything(),
		);
		expect(setBedrockScopeSettings).toHaveBeenCalledWith(scope);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("us-east-2"));
	});
});
