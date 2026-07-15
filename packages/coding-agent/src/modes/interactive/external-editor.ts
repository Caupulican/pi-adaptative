/**
 * External-editor launch flows extracted from interactive-mode.
 *
 * `openExternalEditor` edits the current editor buffer in `$VISUAL`/`$EDITOR`;
 * `openEditorForPath` opens an arbitrary file (falling back to `vi`). Both stop
 * the TUI to release the terminal, spawn the editor, and restart the TUI with a
 * forced full re-render. They operate through a narrow `ExternalEditorHost` seam;
 * interactive-mode keeps thin delegating wrappers.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorComponent, TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import { runExternalEditor } from "../../utils/external-editor-command.ts";
import { getProcessWorkRun } from "../../utils/work-directory.ts";

export interface ExternalEditorHost {
	readonly editor: EditorComponent;
	readonly ui: Pick<TUI, "stop" | "start" | "requestRender">;
	showWarning(message: string): void;
}

function resolveEditorCommand(): string | undefined {
	return process.env.VISUAL || process.env.EDITOR;
}

export async function openExternalEditor(host: ExternalEditorHost): Promise<void> {
	const editorCmd = resolveEditorCommand();
	if (!editorCmd) {
		host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		return;
	}

	const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();
	const tmpFile = path.join(
		getProcessWorkRun(getAgentDir(), "editors", "external").path,
		`pi-editor-${randomUUID()}.pi.md`,
	);

	try {
		// Write current content to temp file
		fs.writeFileSync(tmpFile, currentText, "utf-8");

		// Stop TUI to release terminal
		host.ui.stop();

		process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

		// Cross-platform executable resolution preserves quoted Windows paths without
		// asking a shell to reinterpret the temporary file path.
		const status = await runExternalEditor(editorCmd, tmpFile);

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
	let editorCmd = resolveEditorCommand();
	let isFallback = false;
	if (!editorCmd) {
		editorCmd = "vi";
		isFallback = true;
	}

	try {
		// Stop TUI to release terminal
		host.ui.stop();

		process.stdout.write(
			`Launching external editor: ${editorCmd} ${filePath}\nPi will resume when the editor exits.\n`,
		);

		const status = await runExternalEditor(editorCmd, filePath);

		if (status === null) {
			if (isFallback) {
				process.stdout.write(`\nError: Failed to launch fallback editor "vi".\n`);
			} else {
				process.stdout.write(`\nError: Failed to launch editor "${editorCmd}".\n`);
			}
			process.stdout.write(`Please set the $EDITOR or $VISUAL environment variable to edit inline.\n`);
			process.stdout.write(`Absolute file path: ${filePath}\n\nPress Enter to return to Pi...`);
			// Wait for enter, but do not remain pending if stdin closes during shutdown.
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					process.stdin.removeListener("data", finish);
					process.stdin.removeListener("end", finish);
					process.stdin.removeListener("error", finish);
					resolve();
				};
				process.stdin.once("data", finish);
				process.stdin.once("end", finish);
				process.stdin.once("error", finish);
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
