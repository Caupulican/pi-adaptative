import { Type } from "typebox";

export const ListPeersParameters = Type.Object(
	{
		includeSelf: Type.Optional(Type.Boolean({ description: "Include the current Pi agent in the peer list." })),
	},
	{ additionalProperties: false },
);

export const AgentSendParameters = Type.Object(
	{
		to: Type.Union([
			Type.String({ description: "Peer id, name or address, or '*' for broadcast when enabled." }),
			Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "One or more peer targets." }),
		]),
		message: Type.String({ minLength: 1, description: "Concise request or information for the peer agent." }),
		expectReply: Type.Optional(Type.Boolean({ description: "Wait for the peer's acknowledgement." })),
		timeoutMs: Type.Optional(
			Type.Number({ maximum: 120_000, minimum: 1, description: "Acknowledgement wait timeout in milliseconds." }),
		),
		messageId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 128,
				pattern: "^[A-Za-z0-9._:-]+$",
				description:
					"Stable id for this send. Reuse the same id when retrying after a timeout so the peer receives it once.",
			}),
		),
		metadata: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), { description: "Optional small JSON object." }),
		),
	},
	{ additionalProperties: false },
);
