/**
 * How held operations are named in one bounded line (the held notice, the prepared or held reason a model reads): their
 * actions as one, a watch's check naming the watch and the call that arms it first, in the operator's own wording
 * (`edgeOperation`, in English, since these lines are kept and read by the model). The watch id gives way before the
 * action does, so a long id never pushes the command or page out of the line.
 */

import { englishText } from "../language/interface-text.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import { boundedActionLine, type EdgeOperation } from "./edge-policy.ts";

/** The shortest a watch id is cut to before the action itself is shortened. */
const MIN_HELD_WATCH_ID_CHARS = 8;

/** A call's operations with what the call is made for (a watch's check), which a hold names and a draft keeps. */
export function withPurpose(operations: EdgeOperation[], purpose: NestedCallPurpose | undefined): EdgeOperation[] {
	return purpose ? operations.map((operation) => ({ ...operation, purpose })) : operations;
}

/** What the held operations were made for: every operation of one call carries the same purpose (`withPurpose`). */
export function heldPurpose(operations: readonly Pick<EdgeOperation, "purpose">[]): NestedCallPurpose | undefined {
	return operations.find((operation) => operation.purpose)?.purpose;
}

/** A held operation as the model reads it: the action, its class and the reason it was held. */
export function describedOperation(operation: EdgeOperation): string {
	return `${operation.operation} (${operation.class}: ${operation.reason})`;
}

/**
 * One line of at most `bound` characters naming the held `actions` between `head` and `tail` (`boundedActionLine`).
 * When the line would not fit, a watch's id is shortened first (to no fewer than {@link MIN_HELD_WATCH_ID_CHARS}
 * characters), and only then the actions.
 */
export function boundedHeldLine(
	head: string,
	purpose: NestedCallPurpose | undefined,
	actions: readonly string[],
	tail: string,
	bound: number,
): string {
	const operation = actions.join("; ");
	const named = (shown: NestedCallPurpose | undefined) =>
		englishText().interactive.edgeOperation({ operation, purpose: shown });
	let action = named(purpose);
	const excess = head.length + action.length + tail.length - bound;
	if (purpose && excess > 0 && purpose.watchId.length > MIN_HELD_WATCH_ID_CHARS) {
		const kept = Math.max(MIN_HELD_WATCH_ID_CHARS - 1, purpose.watchId.length - excess - 1);
		action = named({ ...purpose, watchId: `${purpose.watchId.slice(0, kept)}…` });
	}
	return boundedActionLine(head, action, tail, bound);
}
