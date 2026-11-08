/**
 * The subscription-allowance term of the room formula, decided on the account the dispatch's own model runs on (never
 * the foreground's): an exhausted allowance admits nothing until its windows reset; room, or a reading that is missing,
 * stale or not a subscription at all, leaves the term unbounded (provider refusals and cost room govern those).
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "../../channels/channel-policy.ts";
import type {
	SubscriptionAllowance,
	SubscriptionAllowanceReader,
} from "../../provider-admission/subscription-allowance.ts";
import type { RoomTerm } from "../fleet-types.ts";

export interface AllowanceReading {
	readonly accountKey: string;
	readonly allowance: SubscriptionAllowance;
}

/** What the fleet reads allowance through: synchronous cached readings, and a signal when an account's reading changes. */
export interface FleetAllowancePort {
	read(model: Model<Api>): AllowanceReading;
	subscribe(onChange: (accountKey: string) => void): () => void;
}

/** The production port over a session's subscription reader, at the owner-channel quota line. */
export function subscriptionAllowancePort(reader: () => SubscriptionAllowanceReader): FleetAllowancePort {
	return {
		read: (model) => ({
			accountKey: reader().accountKey(model),
			allowance: reader().read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model),
		}),
		subscribe: (onChange) => reader().subscribe(onChange),
	};
}

export function allowanceWaitKey(accountKey: string): string {
	return `account:${accountKey}`;
}

export function allowanceRoomTerm(reading: AllowanceReading): RoomTerm {
	const waitKey = allowanceWaitKey(reading.accountKey);
	const { allowance } = reading;
	if (allowance.kind !== "exhausted")
		return {
			reason: "account_window",
			room: Number.POSITIVE_INFINITY,
			waitKey,
			detail: `allowance ${allowance.kind}`,
		};
	return {
		reason: "account_window",
		room: 0,
		waitKey,
		...(allowance.retryAt !== undefined ? { retryAt: allowance.retryAt } : {}),
		detail: `the subscription allowance is used up (${allowance.reason})${allowance.retryAt !== undefined ? `; it reopens at ${new Date(allowance.retryAt).toISOString()}` : ""}`,
	};
}
