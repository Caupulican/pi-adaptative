import { getKeybindings } from "@caupulican/pi-tui";
import { theme } from "../../../presentation/theme-model.ts";

/** The raised surface and muted frame ink shared by the floating card windows. */
export function cardPalette(): { surface: (text: string) => string; border: (text: string) => string } {
	const surface = (text: string) => theme.bg("customMessageBg", text);
	return { surface, border: (text: string) => surface(theme.fg("borderMuted", text)) };
}

/** The scroll step a key asks for, or undefined when the key does not scroll. `vim` also accepts j and k. */
export function scrollDelta(data: string, pageRows: number, vim: boolean): number | undefined {
	const keys = getKeybindings();
	if (keys.matches(data, "tui.select.up") || (vim && data === "k")) return -1;
	if (keys.matches(data, "tui.select.down") || (vim && data === "j")) return 1;
	if (keys.matches(data, "tui.select.pageUp")) return -pageRows;
	if (keys.matches(data, "tui.select.pageDown")) return pageRows;
	return undefined;
}

export function scrolledOffset(offset: number, delta: number, totalRows: number, bodyRows: number): number {
	return Math.max(0, Math.min(Math.max(0, totalRows - bodyRows), offset + delta));
}
