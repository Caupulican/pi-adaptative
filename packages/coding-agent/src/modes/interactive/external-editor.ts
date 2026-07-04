/**
 * External-editor launch flows extracted from interactive-mode.
 *
 * `openExternalEditor` edits the current editor buffer in `$VISUAL`/`$EDITOR`;
 * `openEditorForPath` opens an arbitrary file (falling back to `vi`). Both stop
 * the TUI to release the terminal, spawn the editor, and restart the TUI with a
 * forced full re-render. They operate through a narrow `ExternalEditorHost` seam;
 * interactive-mode keeps thin delegating wrappers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EditorComponent, TUI } from "@caupulican/pi-tui";

export interface ExternalEditorHost {
	readonly editor: EditorComponent;
	readonly ui: Pick<TUI, "stop" | "start" | "requestRender">;
	showWarning(message: string): void;
}

export async function openExternalEditor(host: ExternalEditorHost): Promise<void> {
	// Determine editor (respect $VISUAL, then $EDITOR)
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		return;
	}

	const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();
	const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

	try {
		// Write current content to temp file
		fs.writeFileSync(tmpFile, currentText, "utf-8");

		// Stop TUI to release terminal
		host.ui.stop();

		// Split by space to support editor arguments (e.g., "code --wait")
		const [editor, ...editorArgs] = editorCmd.split(" ");

		process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after ui.stop() pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const status = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		// On successful exit (status 0), replace editor content
		if (status === 0) {
			const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
			host.editor.setText(newContent);
		}
		// On non-zero exit, keep original text (no action needed)
	} finally {
		// Clean up temp file
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}

		// Restart TUI
		host.ui.start();
		// Force full re-render since external editor uses alternate screen
		host.ui.requestRender(true);
	}
}

export async function openEditorForPath(host: ExternalEditorHost, filePath: string): Promise<boolean> {
	let editorCmd = process.env.EDITOR || process.env.VISUAL;
	let isFallback = false;
	if (!editorCmd) {
		editorCmd = "vi";
		isFallback = true;
	}

	try {
		// Stop TUI to release terminal
		host.ui.stop();

		// Split by space to support editor arguments (e.g., "code --wait")
		const [editor, ...editorArgs] = editorCmd.split(" ");

		process.stdout.write(
			`Launching external editor: ${editorCmd} ${filePath}\nPi will resume when the editor exits.\n`,
		);

		const status = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (status === null) {
			if (isFallback) {
				process.stdout.write(`\nError: Failed to launch fallback editor "vi".\n`);
			} else {
				process.stdout.write(`\nError: Failed to launch editor "${editorCmd}".\n`);
			}
			process.stdout.write(`Please set the $EDITOR or $VISUAL environment variable to edit inline.\n`);
			process.stdout.write(`Absolute file path: ${filePath}\n\nPress Enter to return to Pi...`);
			// Wait for enter key
			await new Promise<void>((resolve) => {
				process.stdin.once("data", () => resolve());
			});
		}

		return status === 0;
	} finally {
		// Restart TUI
		host.ui.start();
		// Force full re-render since external editor uses alternate screen
		host.ui.requestRender(true);
	}
}
