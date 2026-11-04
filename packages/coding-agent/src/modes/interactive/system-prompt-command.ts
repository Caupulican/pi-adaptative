/**
 * `/sysprompt` — edit this session's system prompt in a panel.
 *
 * The override applies to this session only and never rewrites the generated prompt; `/sysprompt
 * reset` returns to the generated prompt. Validation belongs to the session: a rejected edit shows
 * the session's own error message.
 */
import type { SessionSystemPromptController } from "../../core/session-system-prompt-controller.ts";

export interface SystemPromptCommandHost {
	prompt: SessionSystemPromptController;
	promptForEdit(title: string, prefill: string): Promise<string | undefined>;
	showStatus(message: string): void;
	showError(message: string): void;
}

const USAGE = "Usage: /sysprompt [default|reset]";

export async function handleSystemPromptCommand(host: SystemPromptCommandHost, text: string): Promise<void> {
	const { prompt } = host;
	const arg = text.slice("/sysprompt".length).trim();
	if (arg === "reset") {
		if (prompt.get() === undefined) {
			host.showStatus("No session system prompt override is active.");
			return;
		}
		prompt.set(undefined);
		host.showStatus(
			"Session system prompt reset to the generated prompt. The provider prompt cache restarts on the next request.",
		);
		return;
	}
	if (arg !== "" && arg !== "default") {
		host.showError(USAGE);
		return;
	}

	// Never the live prompt: it can hold text an extension applied for this turn, which saving would freeze.
	const prefill = arg === "default" ? prompt.renderGenerated() : (prompt.get() ?? prompt.renderGenerated());
	const edited = await host.promptForEdit("Edit system prompt (this session only)", prefill);
	if (edited === undefined) {
		host.showStatus("System prompt edit cancelled.");
		return;
	}
	if (edited.trim() === "") {
		host.showError("An empty system prompt is rejected; use /sysprompt reset to return to the generated prompt.");
		return;
	}
	if (edited === prompt.renderGenerated()) {
		if (prompt.get() === undefined) {
			host.showStatus("System prompt unchanged.");
			return;
		}
		prompt.set(undefined);
		host.showStatus("Session system prompt matches the generated prompt; override cleared.");
		return;
	}
	if (edited === prompt.get()) {
		host.showStatus("System prompt unchanged.");
		return;
	}
	try {
		prompt.set(edited);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		host.showError(error.message);
		return;
	}
	host.showStatus(
		`Session system prompt override set (${edited.length} chars). It applies from the next request and restarts the provider prompt cache.`,
	);
}
