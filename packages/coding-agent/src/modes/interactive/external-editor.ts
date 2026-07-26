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

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

function resolveEditorCommand(): string | undefined {
	return process.env.VISUAL || process.env.EDITOR;
}

/**
 * Edit text through the configured external editor while keeping all temporary
 * artifacts inside Pi's bounded user-level work directory.
 */
export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const tmpFile = path.join(
		getProcessWorkRun(getAgentDir(), "editors", "external").path,
		`pi-editor-${randomUUID()}.pi.md`,
	);

	try {
		fs.writeFileSync(tmpFile, options.content, "utf-8");
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);
		const status = await runExternalEditor(options.command, tmpFile);
		if (status !== 0) {
			return { status: "failed" };
		}
		return { status: "complete", content: fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Cleanup is best effort.
		}
	}
}

export async function openExternalEditor(host: ExternalEditorHost): Promise<void> {
	const editorCmd = resolveEditorCommand();
	if (!editorCmd) {
		host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		return;
	}

	const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();

	try {
		// Stop TUI to release terminal
		host.ui.stop();

		const result = await editInExternalEditor({ command: editorCmd, content: currentText });
		if (result.status === "complete") {
			host.editor.setText(result.content);
		}
	} finally {
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
