import { Type } from "typebox";

/** One finding contract for provider responses and durable advisor receipts. */
export const peerFindingsSchema = Type.Array(
	Type.Object(
		{
			summary: Type.String({ minLength: 1, maxLength: 1000 }),
			evidence: Type.String({ minLength: 1, maxLength: 1000 }),
			requiredCheck: Type.String({ minLength: 1, maxLength: 1000 }),
		},
		{ additionalProperties: false },
	),
	{ maxItems: 8 },
);
