import { execFileSync, execSync } from "child_process";
import { platform } from "os";
import { spawnProcess, waitForChildProcessWithTermination } from "./child-process.ts";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";
import { isWslEnvironment } from "./platform.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const MAX_CLIPBOARD_TEXT_BYTES = 10 * 1024 * 1024;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							const proc = spawnProcess("wl-copy", [], {
								detached: process.platform !== "win32",
								stdio: ["pipe", "ignore", "ignore"],
							});
							const terminalPromise = waitForChildProcessWithTermination(proc, {
								timeoutMs: options.timeout,
								killGraceMs: 1_000,
							});
							proc.stdin?.on("error", () => {
								// The terminal result below decides whether the copy succeeded.
							});
							proc.stdin?.end(text);
							const terminal = await terminalPromise;
							if (terminal.reason !== "exited" || terminal.code !== 0) {
								throw new Error(`wl-copy failed with code ${terminal.code ?? "unknown"}`);
							}
							copied = true;
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}

export async function readClipboardText(): Promise<string | null> {
	const p = platform();
	if (isRemoteSession()) return null;

	if (clipboard && p !== "linux") {
		try {
			const text = await clipboard.getText();
			if (text) return text;
		} catch {}
	}

	const read = (command: string, args: string[]): string | null => {
		try {
			const output = execFileSync(command, args, {
				encoding: "utf8",
				maxBuffer: MAX_CLIPBOARD_TEXT_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3000,
			});
			return output.length > 0 ? output : null;
		} catch {
			return null;
		}
	};

	if (p === "darwin") return read("pbpaste", []);
	if (p === "win32") {
		return read("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]);
	}
	if (process.env.TERMUX_VERSION) {
		const termux = read("termux-clipboard-get", []);
		if (termux) return termux;
	}
	if (isWslEnvironment()) {
		const windows = read("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]);
		if (windows) return windows.replace(/\r\n/g, "\n");
	}
	if (isWaylandSession()) {
		const wayland = read("wl-paste", ["--no-newline", "--type", "text"]);
		if (wayland) return wayland;
	}
	return (
		read("xclip", ["-selection", "clipboard", "-target", "UTF8_STRING", "-o"]) ??
		read("xsel", ["--clipboard", "--output"])
	);
}
