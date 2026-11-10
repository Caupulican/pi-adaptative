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
import { carryTextRanges, type EditorComponent, type TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { runExternalEditor } from "../../utils/external-editor-command.ts";
import { waitForStdinEvent } from "../../utils/stdin-events.ts";
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
		process.stdout.write(interfaceText().queue.launching(options.command));
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
		host.showWarning(interfaceText().queue.noEditor);
		return;
	}

	const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();

	try {
		// Stop TUI to release terminal
		host.ui.stop();

		const result = await editInExternalEditor({ command: editorCmd, content: currentText });
		if (result.status === "complete") {
			// The pasted ranges follow the edit. One edit is diffed as a whole, so a change that reaches into pasted text
			// leaves everything it rewrote pasted: an external editor never turns pasted words into typed ones.
			const pasted = host.editor.getPastedRanges?.() ?? [];
			host.editor.setText(result.content, carryTextRanges(currentText, result.content, pasted, "pasted"));
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

		process.stdout.write(interfaceText().queue.launching(`${editorCmd} ${filePath}`));

		const status = await runExternalEditor(editorCmd, filePath);

		if (status === null) {
			if (isFallback) {
				process.stdout.write(interfaceText().queue.launchFailedFallback("vi"));
			} else {
				process.stdout.write(interfaceText().queue.launchFailed(editorCmd));
			}
			process.stdout.write(`${interfaceText().queue.setEditorVariable}\n`);
			process.stdout.write(interfaceText().queue.absolutePath(filePath));
			// Wait for enter, but do not remain pending if stdin closes during shutdown.
			await waitForStdinEvent();
		}

		return status === 0;
	} finally {
		// Restart TUI
		host.ui.start();
		// Force full re-render since external editor uses alternate screen
		host.ui.requestRender(true);
	}
}
