/** Prepares a bounded mixed message batch without changing the session tree. */
import { isCommittedPlannerRecord } from "../transient-records.ts";
import type { SessionAppendReceipt } from "./session-append-receipt.ts";
import { deliveredOwnerInput, deliveredTurnOrigin, deliveredWorkerControl } from "./session-context-builder.ts";
import type { CustomMessageEntry, SessionEntry } from "./session-entries.ts";
import type { SessionMessageBatchEntry } from "./session-manager-types.ts";

export const MAX_SESSION_MESSAGE_BATCH_ENTRIES = 256;

export type SessionMessageBatchCommitArgs = [
	batch: readonly SessionMessageBatchEntry[],
	onCommitted?: (receipt: SessionAppendReceipt) => void,
	attempt?: symbol,
];

export function prepareSessionMessageBatch(
	batch: readonly SessionMessageBatchEntry[],
	parentId: string | null,
	nextId: () => string,
) {
	if (batch.length > MAX_SESSION_MESSAGE_BATCH_ENTRIES) {
		throw new RangeError(
			`Session message batch cannot contain more than ${MAX_SESSION_MESSAGE_BATCH_ENTRIES} entries.`,
		);
	}
	const entries: SessionEntry[] = [];
	const sourceMessages: object[] = [];
	const customBindings: Array<{ message: object; entry: CustomMessageEntry }> = [];
	for (const item of batch) {
		if (!item || typeof item !== "object") {
			throw new TypeError("Session message batch items must be objects.");
		}
		const id = nextId();
		let entry: SessionEntry;
		if (item.kind === "message") {
			const message = item.message;
			if (!message || typeof message !== "object") {
				throw new TypeError("Session message batch message items require a message object.");
			}
			entry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				...deliveredWorkerControl(message),
				message,
				...(item.origin === undefined ? {} : { origin: item.origin }),
				...deliveredOwnerInput(message),
				...deliveredTurnOrigin(message),
			};
			sourceMessages.push(message);
		} else if (item.kind === "custom") {
			const message = item.message;
			if (!message || typeof message !== "object") {
				throw new TypeError("Session message batch custom items require a message object.");
			}
			entry = {
				type: "custom_message",
				...(isCommittedPlannerRecord(message) ? { origin: "local" as const } : {}),
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				id,
				parentId,
				timestamp: new Date().toISOString(),
			};
			customBindings.push({ message, entry });
			sourceMessages.push(message);
		} else {
			throw new TypeError("Session message batch items must use kind message or custom.");
		}
		entries.push(entry);
		parentId = id;
	}
	return { entries, sourceMessages, customBindings };
}
