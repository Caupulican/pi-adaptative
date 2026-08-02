import { Container } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthDialogsController } from "../src/modes/interactive/auth-dialogs-controller.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const originalAwsProfile = process.env.AWS_PROFILE;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAwsProfile === undefined) delete process.env.AWS_PROFILE;
	else process.env.AWS_PROFILE = originalAwsProfile;
});

describe("authentication dialog liveness", () => {
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

		expect(order).toEqual(["done", "logout"]);
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
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const overlayHost = { swap: vi.fn() };
		const showError = vi.fn();
		const showStatus = vi.fn();
		const loginBedrockSso = vi.fn(async () => {});
		const refresh = vi.fn();
		const controller = new AuthDialogsController({
			getSession: () => ({ modelRegistry: { refresh } }) as never,
			loginBedrockSso,
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
		expect(refresh).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining('AWS profile "work-sso"'));
		expect(showError).not.toHaveBeenCalled();
		expect(overlayHost.swap).toHaveBeenLastCalledWith(editor);
	});
});
