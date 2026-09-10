/**
 * Terminal-owned full-screen lifetime; stop, suspend and external editors use the same exit.
 *
 * The alternate screen and mouse capture are separate decisions. The screen is the workbench's;
 * the mouse stays with the terminal emulator unless the operator asks for capture, because
 * button-event tracking takes every click, drag and right-click away from the emulator — native
 * selection, copy-on-select and right-click paste all stop working the moment it is on.
 */
export class TerminalViewportMode {
	private active = false;
	private mouseWanted: boolean;
	private mouseActive = false;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void, options: { mouse?: boolean } = {}) {
		this.write = write;
		this.mouseWanted = options.mouse ?? false;
	}

	get mouseTracking(): boolean {
		return this.mouseWanted;
	}

	enter(): void {
		if (this.active) return;
		this.active = true;
		this.write("\x1b[?1049h\x1b[H");
		if (this.mouseWanted) this.enableMouse();
	}

	leave(): void {
		if (!this.active) return;
		this.active = false;
		this.disableMouse();
		this.write("\x1b[?1049l");
	}

	/** Remember the operator's choice; apply it now when the screen is live, else on the next enter. */
	setMouseTracking(enabled: boolean): void {
		this.mouseWanted = enabled;
		if (!this.active) return;
		if (enabled) this.enableMouse();
		else this.disableMouse();
	}

	private enableMouse(): void {
		if (this.mouseActive) return;
		this.mouseActive = true;
		this.write("\x1b[?1002h\x1b[?1006h");
	}

	private disableMouse(): void {
		if (!this.mouseActive) return;
		this.mouseActive = false;
		this.write("\x1b[?1002l\x1b[?1006l");
	}
}
