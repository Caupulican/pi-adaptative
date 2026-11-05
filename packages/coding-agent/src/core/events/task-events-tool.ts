import { type Static, Type } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
import { createDelegateEventParameterSchemas, executeDelegateEventAction } from "../tools/delegate-events.ts";
import type { HostEventControlPort, HostEventControlScope } from "./host-event-control.ts";
import { MAX_HOST_EVENT_PAGE_ITEMS } from "./host-event-control.ts";
import { TASK_EVENTS_TOOL_NAME } from "./host-event-tool-names.ts";

/** Task and caller identities come only from the admitted worker execution. */
export function createTaskEventsTool(options: {
	readonly port: HostEventControlPort;
	readonly callerAgentId: string;
	readonly taskId: string;
	readonly execution: NonNullable<HostEventControlScope["execution"]>;
}): AgentTool {
	const fields = createDelegateEventParameterSchemas();
	const parameters = Type.Object(
		{
			action: Type.Union([Type.Literal("events"), Type.Literal("subscriptions")]),
			eventId: fields.eventId,
			eventView: fields.eventView,
			cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
			maxMessages: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_HOST_EVENT_PAGE_ITEMS })),
			expectedRevision: fields.expectedRevision,
			subscriptions: fields.subscriptions,
		},
		{ additionalProperties: false },
	);
	return {
		name: TASK_EVENTS_TOOL_NAME,
		label: "Task events",
		description:
			"Read this task's retained CI evidence or subscriptions. events with eventView=sources lists exact watched subjects; current=false means historical. subscriptions reads the revision, or narrows the existing set with expectedRevision and subscriptions ([] revokes). Cannot add subjects or widen wake policy. Notifications arrive automatically; do not poll.",
		parameters,
		execute: async (_toolCallId, args, signal) => {
			signal?.throwIfAborted();
			const input = args as Static<typeof parameters>;
			if (input.action === "events" && (input.subscriptions !== undefined || input.expectedRevision !== undefined))
				throw new Error("Subscription changes require action=subscriptions.");
			if (input.action === "subscriptions" && (input.eventId !== undefined || input.eventView !== undefined))
				throw new Error("eventId and eventView apply only to action=events.");
			return executeDelegateEventAction(input.action, { ...input, taskId: options.taskId }, options.port, {
				callerAgentId: options.callerAgentId,
				execution: options.execution,
			});
		},
	};
}
