import { TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("login dialog paste", () => {
	it("inserts clipboard text into the authorization input", async () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {});
		tui.addChild(dialog);
		tui.setFocus(dialog);
		const pending = dialog.showPrompt("Paste the Antigravity authorization code or callback URL:");
		const url = "https://antigravity.google/oauth-callback?code=pasted-code&state=pasted-state\n";
		expect(tui.pasteText(url)).toBe(true);
		dialog.handleInput("\r");
		await expect(pending).resolves.toBe(
			"https://antigravity.google/oauth-callback?code=pasted-code&state=pasted-state",
		);
	});

	it("does not paste into an unfocused dialog", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const dialog = new LoginDialogComponent(tui, "google-antigravity", () => {});
		tui.addChild(dialog);
		expect(tui.pasteText("token")).toBe(false);
	});
});
