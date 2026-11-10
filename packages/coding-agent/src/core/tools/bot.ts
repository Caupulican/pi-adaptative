import { Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import { BOT_TOOL_NAME, type BotToolPort, botCreationRequestFrom } from "../delegation/bot-creation.ts";
import { LEAD_FIELDS, LEAD_LIMITS, leadRequestFrom } from "../delegation/leader-delegation.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/** The `lead` fields of the bot tool; the bot_message tool's `lead` action takes the same fields. */
export const LEAD_PROPERTIES = {
	goal: Type.Optional(
		Type.String({ minLength: 1, maxLength: LEAD_LIMITS.goalChars, description: "For lead: the goal, whole." }),
	),
	requirements: Type.Optional(
		Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1, maxLength: LEAD_LIMITS.requirementIdChars }),
					text: Type.String({ minLength: 1, maxLength: LEAD_LIMITS.requirementTextChars }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: LEAD_LIMITS.requirements, description: "For lead: what must be true when the goal is done." },
		),
	),
	constraints: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: LEAD_LIMITS.constraintChars }), {
			maxItems: LEAD_LIMITS.constraints,
			description: "For lead: rules the leader and its bots keep.",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: LEAD_LIMITS.fileChars }), {
			maxItems: LEAD_LIMITS.files,
			description:
				"For lead: project-relative paths the goal may change; leave it out for a read-only goal. Only a standing leader that can write changes files.",
		}),
	),
	budgetUsd: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "For lead: metered spending bound for the whole goal." }),
	),
	minutes: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "For lead: the goal is stopped after this many minutes." }),
	),
	context: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: LEAD_LIMITS.contextChars,
			description: "For lead: background the leader needs.",
		}),
	),
};

const schema = Type.Object(
	{
		action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("ask"), Type.Literal("lead")]),
		agentId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				description:
					"The bot's id. For create, leave it out to have the harness name the bot from its purpose. For lead, the leader to use; leave it out to appoint a goal leader.",
			}),
		),
		soul: Type.Optional(
			Type.String({ minLength: 1, description: "The bot's standing instructions: its purpose, rules and tone." }),
		),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "One line about the bot." })),
		model: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 200,
				description: "<provider>/<model>; the default worker model when omitted.",
			}),
		),
		thinkingLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		canWrite: Type.Optional(Type.Boolean({ description: "Let the bot edit files; read-only when omitted." })),
		message: Type.Optional(Type.String({ minLength: 1, description: "For ask: what to tell the bot." })),
		...LEAD_PROPERTIES,
	},
	{ additionalProperties: false },
);

const CREATE_FIELDS = ["soul", "description", "model", "thinkingLevel", "canWrite"] as const;

/** The orchestrator's tool for persistent bots on the fly, and for handing a whole goal to a leader. */
export function createBotToolDefinition(port: BotToolPort): ToolDefinition<typeof schema> {
	return {
		name: BOT_TOOL_NAME,
		label: "Bots",
		description:
			"Create a persistent bot on the fly for a purpose (action create: agentId, soul, optional model; read-only unless canWrite), list the bots (action list), message a bot (action ask: agentId, message; its answer arrives as an event), or hand a whole goal to a leader (action lead: goal, optional requirements, constraints, files, budgetUsd, minutes, context, and agentId of a leader; without agentId a goal leader is appointed for this goal). A leader splits the goal among the bots it owns and you hear back once, with one outcome, when the goal ends, or earlier only when it needs your answer (answer with ask). Only the owner makes a standing leader; a leader creates bots too, and every other bot asks a leader or you for one. For many bots at once, ask the spawner bot if the owner made one.",
		promptSnippet: "Create, list or message bots, or hand a goal to a leader",
		parameters: schema,
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw signal.reason;
			const leadFields = LEAD_FIELDS.filter((field) => input[field] !== undefined);
			if (input.action !== "lead" && leadFields.length > 0)
				throw new Error(`${leadFields.join(", ")} belong to action lead.`);
			if (input.action === "lead") {
				const createFields = CREATE_FIELDS.filter((field) => input[field] !== undefined);
				if (createFields.length > 0 || input.message !== undefined)
					throw new Error(
						`Lead accepts goal, requirements, constraints, files, budgetUsd, minutes, context and agentId; not ${[...createFields, ...(input.message !== undefined ? ["message"] : [])].join(", ")}.`,
					);
				const result = port.lead(leadRequestFrom(input));
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			}
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
