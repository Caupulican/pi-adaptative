/**
 * Sends one reply's parts through a channel transport, in order, and reports the digest of each part the transport accepts. A
 * caller keeps those digests: a draft send writes each one to the journal as it lands, and a live reply keeps them with the
 * draft it leaves when a part fails. A later send skips the leading parts of its split that match the kept digests.
 */

import type { ChannelProvider } from "../gateways/channel-provider.ts";
import { digest } from "./channel-journal.ts";

/** The conversation a reply's parts go to, and the id that names them to the transport. */
export interface ReplyPartsTarget {
	readonly conversationKey: string;
	readonly address: string;
	readonly id: string;
}

/** How many leading parts are already accepted: the recorded digests that match the first parts of this split, in order. */
export function acceptedPrefixLength(parts: readonly string[], accepted: readonly string[]): number {
	let skip = 0;
	while (skip < accepted.length && skip < parts.length && digest(parts[skip] ?? "") === accepted[skip]) skip++;
	return skip;
}

/**
 * Sends the parts the transport has not accepted yet. `onAccepted` receives the digests of every part accepted so far, after
 * each one. A part that fails ends the send: when earlier parts were accepted, the error says how many of the reply's parts
 * went out, and a later send of the draft sends only the rest.
 */
export async function sendReplyParts(
	provider: ChannelProvider,
	target: ReplyPartsTarget,
	parts: readonly string[],
	accepted: readonly string[] = [],
	onAccepted?: (digests: readonly string[]) => void,
): Promise<void> {
	const skip = acceptedPrefixLength(parts, accepted);
	let recorded = accepted.slice(0, skip);
	for (const [index, text] of parts.entries()) {
		if (index < skip) continue;
		try {
			await provider.send({
				conversationKey: target.conversationKey,
				address: target.address,
				text,
				kind: "message",
				eventId: `reply:${target.id}:${index + 1}/${parts.length}`,
				final: index === parts.length - 1,
			});
		} catch (error) {
			if (recorded.length === 0) throw error;
			const cause = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${recorded.length} of ${parts.length} parts were sent before this one failed; sending the draft again sends the rest. ${cause}`,
				{ cause: error },
			);
		}
		recorded = [...recorded, digest(text)];
		onAccepted?.(recorded);
	}
}
