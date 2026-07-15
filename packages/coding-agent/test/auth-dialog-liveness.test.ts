import { Container } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthDialogsController } from "../src/modes/interactive/auth-dialogs-controller.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("authentication dialog liveness", () => {
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
});
