/**
 * Semantic System One outcomes translated into the canonical objective-route vocabulary.
 * Not a second router: composeObjectiveRoute consumes these as one composition input.
 */

import type { ObjectiveRouteName } from "../objective-execution/objective-route.ts";

export type SystemOnePreflightRoute = "allow" | "retrieve" | "replan" | "test" | "block" | "escalate";

export type SystemOnePostflightStatus =
	| "continue"
	| "verify"
	| "retrieve_more"
	| "replan"
	| "rollback"
	| "completion_candidate"
	| "blocked";

export interface SystemOneControlDirective {
	readonly source: "preflight" | "postflight" | "tool_gate";
	readonly objectiveRoute: ObjectiveRouteName;
	readonly reasonCodes: readonly string[];
}

export function directiveFromPreflight(route: SystemOnePreflightRoute): SystemOneControlDirective | undefined {
	switch (route) {
		case "allow":
			return undefined;
		case "retrieve":
			return { source: "preflight", objectiveRoute: "retrieve", reasonCodes: ["system_one_preflight_retrieve"] };
		case "replan":
			return { source: "preflight", objectiveRoute: "replan", reasonCodes: ["system_one_preflight_replan"] };
		case "test":
			return {
				source: "preflight",
				objectiveRoute: "deterministic_test",
				reasonCodes: ["system_one_preflight_test"],
			};
		case "block":
			return {
				source: "preflight",
				objectiveRoute: "blocked_external",
				reasonCodes: ["system_one_preflight_block"],
			};
		case "escalate":
			return {
				source: "preflight",
				objectiveRoute: "escalate_capability",
				reasonCodes: ["system_one_preflight_escalate"],
			};
	}
}

export function directiveFromPostflight(status: SystemOnePostflightStatus): SystemOneControlDirective | undefined {
	switch (status) {
		case "continue":
			return undefined;
		case "verify":
			return { source: "postflight", objectiveRoute: "verify", reasonCodes: ["system_one_postflight_verify"] };
		case "retrieve_more":
			return {
				source: "postflight",
				objectiveRoute: "retrieve",
				reasonCodes: ["system_one_postflight_retrieve_more"],
			};
		case "replan":
			return { source: "postflight", objectiveRoute: "replan", reasonCodes: ["system_one_postflight_replan"] };
		case "rollback":
			return {
				source: "postflight",
				objectiveRoute: "replan",
				reasonCodes: ["system_one_postflight_rollback"],
			};
		case "completion_candidate":
			return {
				source: "postflight",
				objectiveRoute: "completion_candidate",
				reasonCodes: ["system_one_postflight_completion_candidate"],
			};
		case "blocked":
			return {
				source: "postflight",
				objectiveRoute: "blocked_external",
				reasonCodes: ["system_one_postflight_blocked"],
			};
	}
}

export function directiveFromToolReplan(tool: string): SystemOneControlDirective {
	return {
		source: "tool_gate",
		objectiveRoute: "replan",
		reasonCodes: [`system_one_tool_replan:${tool}`],
	};
}
