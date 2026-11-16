/** The error a bot's host and its stores throw in the owner's words, told to the owner as it is (`botFailureText`). */
import { englishText, type InterfaceText, interfaceText } from "../language/interface-text.ts";

/** A failure's sentence in the language of the catalogue passed in: one formatter for the owner's words and a model's. */
export type BotFailureWords = (text: InterfaceText) => string;

/**
 * An error whose message is the owner's words (`interfaceText`), and whose `words` give the same sentence in another
 * catalogue: a model that reads the failure (a bot mailing another, the orchestrator asking one) reads it in English.
 */
export class BotOwnerError extends Error {
	readonly words: BotFailureWords;

	constructor(words: BotFailureWords, options?: ErrorOptions) {
		super(words(interfaceText()), options);
		this.name = "BotOwnerError";
		this.words = words;
	}
}

/** `error` as a model reads it: a bot's failure in English (model-facing text stays English), any other as it is. */
export function botFailureForModel(error: unknown): unknown {
	return error instanceof BotOwnerError ? new Error(error.words(englishText()), { cause: error }) : error;
}
