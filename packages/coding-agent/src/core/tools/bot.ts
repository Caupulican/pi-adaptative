import { Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import { BOT_TOOL_NAME, type BotToolPort, botCreationRequestFrom } from "../delegation/bot-creation.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const schema = Type.Object(
	{
		action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("ask")]),
		agentId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				description: "The bot's id. For create, leave it out to have the harness name the bot from its purpose.",
			}),
		),
		soul: Type.Optional(
			Type.String({ minLength: 1, description: "The bot's standing instructions: its purpose, rules and tone." }),
		),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "One line about the bot." })),
		model: Type.Optional(
			Type.String({ minLength: 1, maxLength: 200, description: "<provider>/<model>; yours when omitted." }),
		),
		thinkingLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		canWrite: Type.Optional(Type.Boolean({ description: "Let the bot edit files; read-only when omitted." })),
		message: Type.Optional(Type.String({ minLength: 1, description: "For ask: what to tell the bot." })),
	},
	{ additionalProperties: false },
);

/** The orchestrator's tool for creating a persistent bot on the fly, for whatever purpose the owner has. */
export function createBotToolDefinition(port: BotToolPort): ToolDefinition<typeof schema> {
	return {
		name: BOT_TOOL_NAME,
		label: "Bots",
		description:
			"Create a persistent bot on the fly for a purpose (action create: agentId, soul, optional model; read-only unless canWrite), list the bots (action list), or message a bot (action ask: agentId, message; its answer arrives as an event). Only the owner makes a bot a leader; a leader creates bots too, and every other bot asks a leader or you for one. For many bots at once, ask the spawner bot if the owner made one.",
		promptSnippet: "Create or list bots",
		parameters: schema,
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw signal.reason;
			if (input.action === "ask") {
				if (!input.agentId || !input.message) throw new Error("Ask requires agentId and message.");
				harnessLog.info("bots", "the orchestrator asked a bot", {
					agentId: input.agentId,
					chars: input.message.length,
				});
				await port.ask(input.agentId, input.message);
				const sent = { sent: true, agentId: input.agentId };
				return { content: [{ type: "text", text: JSON.stringify(sent) }], details: sent };
			}
			if (input.action === "list") {
				if (input.agentId || input.soul || input.model || input.canWrite !== undefined)
					throw new Error("List accepts only action.");
				const bots = port.list();
				return { content: [{ type: "text", text: JSON.stringify({ bots }) }], details: { bots } };
			}
			const created = port.create(botCreationRequestFrom(input));
			return { content: [{ type: "text", text: JSON.stringify(created) }], details: created };
		},
	};
}
