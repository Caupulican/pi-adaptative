/**
 * `bot_mail`: a bot's own session lists the bots it may mail and sends words to one of them (`bots/bot-mail.ts`). A send
 * returns once the receiver's session took the words or they wait for it, never waiting for an answer: the receiver's
 * answer comes back on its own as a reply.
 */

import { type Static, type TSchema, Type } from "typebox";
import type { BotMailPort } from "../bots/bot-mail.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { BOT_MAIL_TOOL_NAME } from "./bot-mail-tool-name.ts";

const schema = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("send")]),
		to: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "For send: a bot's id from list." })),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "For send: the words." })),
	},
	{ additionalProperties: false },
);

type BotMailInput = Static<typeof schema>;

export function createBotMailToolDefinition(port: BotMailPort): ToolDefinition<TSchema> {
	return {
		name: BOT_MAIL_TOOL_NAME,
		label: "Bot Mail",
		description:
			"Message another of the owner's bots. Action list names the bots you may mail; action send (to, message) delivers the words to that bot's own session and returns at once. The receiver reads them as another agent's words, never as the owner's, and its answer comes back to you as a reply on its own, so never wait for one or ask for it again. Keep exchanges short: a chain of mails past its bound is refused.",
		promptSnippet: "Message the owner's other bots",
		// A mail's framing names it to the receiving bot on its first request, so a discovery round would be wasted.
		neverDefer: true,
		parameters: schema,
		async execute(_toolCallId, input: BotMailInput, signal) {
			if (signal?.aborted) throw signal.reason;
			let result: unknown;
			if (input.action === "list") {
				if (input.to !== undefined || input.message !== undefined) throw new Error("List accepts only action.");
				result = { bots: port.peers() };
			} else {
				const message = input.message?.trim();
				if (!input.to || !message) throw new Error("Send requires to and a nonempty message.");
				result = await port.send(input.to.trim(), message);
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
