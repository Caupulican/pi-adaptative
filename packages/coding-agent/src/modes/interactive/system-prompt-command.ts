/**
 * `/sysprompt` — edit this session's system prompt in a panel.
 *
 * The override applies to this session only and never rewrites the generated prompt; `/sysprompt
 * reset` returns to the generated prompt. Validation belongs to the session: a rejected edit shows
 * the session's own error message.
 */
import { interfaceText } from "../../core/language/interface-text.ts";
import type { SessionSystemPromptController } from "../../core/session-system-prompt-controller.ts";

export interface SystemPromptCommandHost {
	prompt: SessionSystemPromptController;
	promptForEdit(title: string, prefill: string): Promise<string | undefined>;
	showStatus(message: string): void;
	showError(message: string): void;
}

export async function handleSystemPromptCommand(host: SystemPromptCommandHost, text: string): Promise<void> {
	const { prompt } = host;
	const words = interfaceText().smallCommands.systemPrompt;
	const arg = text.slice("/sysprompt".length).trim();
	if (arg === "reset") {
		if (prompt.get() === undefined) {
			host.showStatus(words.noOverride);
			return;
		}
		prompt.set(undefined);
		host.showStatus(words.reset);
		return;
	}
	if (arg !== "" && arg !== "default") {
		host.showError(words.usage);
		return;
	}

	// Never the live prompt: it can hold text an extension applied for this turn, which saving would freeze.
	const prefill = arg === "default" ? prompt.renderGenerated() : (prompt.get() ?? prompt.renderGenerated());
	const edited = await host.promptForEdit(words.editTitle, prefill);
	if (edited === undefined) {
		host.showStatus(words.editCancelled);
		return;
	}
	if (edited.trim() === "") {
		host.showError(words.emptyRejected);
		return;
	}
	if (edited === prompt.renderGenerated()) {
		if (prompt.get() === undefined) {
			host.showStatus(words.unchanged);
			return;
		}
		prompt.set(undefined);
		host.showStatus(words.matchesGenerated);
		return;
	}
	if (edited === prompt.get()) {
		host.showStatus(words.unchanged);
		return;
	}
	try {
		prompt.set(edited);
	} catch (error: unknown) {
		if (!(error instanceof Error)) throw error;
		host.showError(error.message);
		return;
	}
	host.showStatus(words.overrideSet(edited.length));
}
