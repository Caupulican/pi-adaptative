/** The error a bot's host and its stores throw in the owner's words, told to the owner as it is (`botFailureText`). */

/** An error whose message is the owner's words (`interfaceText`). */
export class BotOwnerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BotOwnerError";
	}
}
