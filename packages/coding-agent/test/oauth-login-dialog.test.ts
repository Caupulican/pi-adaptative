import type { TUI } from "@caupulican/pi-tui";
import { expect, it, vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";

it("delivers a blank paste and accepts a corrected code in the same dialog", async () => {
	initTheme("dark");
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const dialog = new LoginDialogComponent(tui, "anthropic", vi.fn());
	const first = dialog.showManualInput("First paste");
	dialog.handleInput("\r");
	await expect(first).resolves.toBe("");

	const corrected = dialog.showPrompt("Paste the complete code");
	dialog.pasteText("authorization#state");
	dialog.handleInput("\r");
	await expect(corrected).resolves.toBe("authorization#state");
	const rendered = dialog.render(100).join("\n");
	expect(rendered).toContain("Paste the complete code");
	expect(rendered).not.toContain("First paste");
});
