import { Type } from "typebox";
import { ORCHESTRATION_THINKING_LEVELS } from "./contracts.ts";

/** Shared provider-facing thinking-level vocabulary for schemas at the orchestration boundary. */
export function orchestrationThinkingLevelSchema(description?: string) {
	return Type.Union(
		[
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[0]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[1]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[2]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[3]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[4]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[5]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[6]),
			Type.Literal(ORCHESTRATION_THINKING_LEVELS[7]),
		],
		description === undefined ? {} : { description },
	);
}

export const ORCHESTRATION_THINKING_LEVEL_SCHEMA = orchestrationThinkingLevelSchema();

/** Model defaults intentionally exclude `off`; absence represents the provider/model default. */
export const MODEL_DEFAULT_THINKING_LEVEL_SCHEMA = Type.Exclude(
	ORCHESTRATION_THINKING_LEVEL_SCHEMA,
	Type.Literal("off"),
);
