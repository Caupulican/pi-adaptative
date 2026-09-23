let held = false;

/**
 * Keys typed while an interactive launch is still loading. Until the TUI takes the terminal it is in
 * cooked mode: the line discipline echoes the typing over the screen and turns Enter (CR) into LF, so
 * a prompt typed during startup reached the editor as text plus a newline instead of a submit. The
 * launch that will own the terminal takes raw mode as soon as it knows, so queued keys arrive as the
 * keys they were; the TUI then takes the terminal in the same mode and reads them.
 *
 * Terminal mode belongs to the device, not the process: a supervised child's TUI restores cooked mode
 * when it stops, and this process restores it on exit, so a launch that dies before its TUI starts
 * never leaves the terminal raw.
 */
export function holdStartupTypeahead(stdin: NodeJS.ReadStream = process.stdin): void {
	if (!stdin.isTTY || stdin.isRaw || typeof stdin.setRawMode !== "function") return;
	stdin.setRawMode(true);
	if (held) return;
	held = true;
	process.once("exit", () => {
		if (!stdin.destroyed) stdin.setRawMode(false);
	});
}

/** Takes the hold again after a startup prompt whose readline returned the terminal to cooked mode. */
export function resumeStartupTypeahead(): void {
	if (held) holdStartupTypeahead();
}
