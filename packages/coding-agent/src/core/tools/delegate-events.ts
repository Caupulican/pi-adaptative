import { Type } from "typebox";
import {
	type HostEventSubscriptionInput,
	MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
	parseHostEventSubscriptionInput,
} from "../events/host-event-contract.ts";
import {
	type HostEventControlPort,
	type HostEventControlScope,
	MAX_HOST_EVENT_PAGE_ITEMS,
} from "../events/host-event-control.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { OrchestrationPanelModel } from "./orchestration-panel.ts";

export const DELEGATE_EVENT_ACTIONS = ["events", "subscriptions"] as const;
export type DelegateEventAction = (typeof DELEGATE_EVENT_ACTIONS)[number];

export interface DelegateEventInput {
	readonly taskId?: string;
	readonly eventId?: string;
	readonly eventView?: "sources" | "events";
	readonly cursor?: number;
	readonly maxMessages?: number;
	readonly expectedRevision?: number;
	readonly subscriptions?: readonly HostEventSubscriptionInput[];
}

export interface DelegateEventToolDetails {
	readonly started: true;
	readonly action: DelegateEventAction;
	readonly kind: "events";
	readonly count: number;
	readonly changed: boolean;
	readonly taskId?: string;
}

export function createDelegateEventParameterSchemas() {
	const identifier = Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH });
	return {
		taskId: Type.Optional(identifier),
		eventId: Type.Optional(identifier),
		eventView: Type.Optional(
			Type.Union([Type.Literal("sources"), Type.Literal("events")], {
				description:
					"events only: sources discovers exact CI subjects/thread keys; events recalls retained attempt evidence.",
			}),
		),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		subscriptions: Type.Optional(
			Type.Array(
				Type.Object(
					{
						threadKey: identifier,
						subject: Type.Object(
							{
								host: Type.String({ minLength: 1, maxLength: 253 }),
								repositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
								workflowId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
								headSha: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
							},
							{ additionalProperties: false },
						),
						wake: Type.Union([Type.Literal("never"), Type.Literal("resume_same_task")]),
					},
					{ additionalProperties: false },
				),
				{
					maxItems: MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
					description:
						"Exact CI subjects from events/sources. start admits these with the task. subscriptions replaces the set using expectedRevision; [] revokes it. Workers may only narrow their own task. Events never widen execution authority.",
				},
			),
		),
	};
}

export function executeDelegateEventAction(
	action: DelegateEventAction,
	input: DelegateEventInput,
	port: HostEventControlPort,
	scope?: HostEventControlScope,
) {
	if (action === "subscriptions" && !input.taskId)
		throw new Error("delegate subscriptions requires taskId from delegate tasks.");
	if (input.subscriptions !== undefined && input.expectedRevision === undefined)
		throw new Error("Changing subscriptions requires expectedRevision from the subscriptions view.");
	if (input.expectedRevision !== undefined && input.subscriptions === undefined)
		throw new Error("expectedRevision applies only when replacing subscriptions.");
	const changed = action === "subscriptions" && input.subscriptions !== undefined;
	if (changed && (input.cursor !== undefined || input.maxMessages !== undefined))
		throw new Error("Pagination applies only when reading subscriptions.");
	const result = changed
		? port.changeHostEventSubscriptions(
				{
					taskId: input.taskId!,
					expectedRevision: input.expectedRevision!,
					subscriptions: input.subscriptions!.map(parseHostEventSubscriptionInput),
				},
				scope,
			)
		: port.readHostEvents(
				{
					view: action === "subscriptions" ? "subscriptions" : input.eventView,
					taskId: input.taskId,
					eventId: input.eventId,
					cursor: input.cursor,
					maxItems: Math.min(input.maxMessages ?? 16, MAX_HOST_EVENT_PAGE_ITEMS),
				},
				scope,
			);
	const count = "items" in result ? result.items.length : result.subscriptions.length;
	const details: DelegateEventToolDetails = {
		started: true,
		action,
		kind: "events",
		count,
		changed,
		...(input.taskId ? { taskId: input.taskId } : {}),
	};
	return {
		content: [
			{
				type: "text" as const,
				text: `${changed ? "Subscriptions saved." : "Retained host evidence; current=false is historical, not a current failure. Page revision changes mean the collection changed."}\n${wrapUntrustedText(JSON.stringify(result), "host-event-evidence")}\nCI events arrive automatically. Do not poll; continue independent work.`,
			},
		],
		details,
	};
}

export function delegateEventPanelModel(details: DelegateEventToolDetails): OrchestrationPanelModel {
	return {
		label: "task events",
		action: details.changed ? "subscriptions saved" : "recalled",
		status: "success",
		summary: [`${details.count} ${details.action}`, ...(details.taskId ? [`task ${details.taskId}`] : [])],
	};
}
