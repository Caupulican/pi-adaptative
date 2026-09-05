import { Type } from "typebox";
import { Value } from "typebox/value";
import { type CollaborationAgent, CollaborationBackendError, type CollaborationPane } from "./backend.ts";
import { NATIVE_PI_SOURCE_PATTERN } from "./native-pi-protocol.ts";

export const herdrHandle = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9:_-]*$" });
export const herdrSequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const paneSchema = Type.Object({
	pane_id: herdrHandle,
	terminal_id: herdrHandle,
	workspace_id: herdrHandle,
	tab_id: herdrHandle,
});
const agentSchema = Type.Intersect([
	paneSchema,
	Type.Object({
		name: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
		agent: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
		agent_status: Type.Union([
			Type.Literal("idle"),
			Type.Literal("working"),
			Type.Literal("blocked"),
			Type.Literal("done"),
			Type.Literal("unknown"),
		]),
		interactive_ready: Type.Optional(Type.Boolean()),
		launch_pending: Type.Optional(Type.Boolean()),
		state_change_seq: Type.Optional(herdrSequence),
		revision: herdrSequence,
		state_labels: Type.Optional(
			Type.Object({
				blocked: Type.Optional(Type.String({ maxLength: 2000 })),
				idle: Type.Optional(Type.String({ maxLength: 80 })),
			}),
		),
	}),
]);

export function malformedHerdrResponse(): never {
	throw new CollaborationBackendError("invalid_response", "Malformed Herdr response; no mutation will be replayed.");
}

export function herdrRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return malformedHerdrResponse();
	return value as Record<string, unknown>;
}

export function parseHerdrPane(value: unknown): CollaborationPane {
	if (!Value.Check(paneSchema, value)) return malformedHerdrResponse();
	return {
		paneId: value.pane_id,
		terminalId: value.terminal_id,
		workspaceId: value.workspace_id,
		tabId: value.tab_id,
	};
}

export function parseHerdrAgent(value: unknown): CollaborationAgent {
	if (!Value.Check(agentSchema, value)) return malformedHerdrResponse();
	return {
		...parseHerdrPane(value),
		name: value.name ?? undefined,
		kind: value.agent ?? undefined,
		status: value.agent_status,
		// Shell-launched wrappers have no Herdr ManagedAgentPhase. Admission names them only
		// after a fresh expected-kind stopped report; the native prompt API also checks foreground identity.
		interactiveReady:
			value.agent === "pi"
				? !value.launch_pending &&
					(value.state_change_seq ?? 0) > 0 &&
					value.agent_status !== "unknown" &&
					NATIVE_PI_SOURCE_PATTERN.test(value.state_labels?.idle ?? "")
				: value.interactive_ready === true ||
					Boolean(
						value.name &&
							value.agent &&
							!value.launch_pending &&
							(value.state_change_seq ?? 0) > 0 &&
							value.agent_status !== "unknown",
					),
		launchPending: value.launch_pending ?? false,
		stateChangeSequence: value.state_change_seq ?? 0,
		revision: value.revision,
		...(value.agent_status === "blocked" && value.state_labels?.blocked
			? { question: value.state_labels.blocked }
			: {}),
	};
}

export function herdrTarget(value: string): string {
	if (!Value.Check(herdrHandle, value))
		throw new CollaborationBackendError(
			"invalid_target",
			"An explicit collaboration identity is required.",
			"not-submitted",
		);
	return value;
}
