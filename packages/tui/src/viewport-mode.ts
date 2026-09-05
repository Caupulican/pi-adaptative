/** Terminal-owned full-screen/mouse lifetime; stop, suspend and external editors use the same exit. */
export class TerminalViewportMode {
	private active = false;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	enter(): void {
		if (this.active) return;
		this.active = true;
		this.write("\x1b[?1049h\x1b[H\x1b[?1002h\x1b[?1006h");
	}

	leave(): void {
		if (!this.active) return;
		this.active = false;
		this.write("\x1b[?1002l\x1b[?1006l\x1b[?1049l");
	}
}
