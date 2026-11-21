/** Project a pending root reply into bounded, addressable pages. Only its final page carries the acknowledgement token. */
import type { SessionRootReply } from "../delegation/session-root-mailbox.ts";

interface ReplyPage extends Omit<SessionRootReply, "ackToken"> {
	ackToken?: string;
	cursor?: number;
	next?: { action: "inbox"; messageId: string; cursor: number };
}

export function inboxReplyPageJson(
	replies: readonly SessionRootReply[],
	cursor: number,
	maxBytes: number,
	envelope: (pages: readonly ReplyPage[], omittedCount: number) => unknown,
): string {
	const pages: ReplyPage[] = [];
	const render = (selected: readonly ReplyPage[]) =>
		JSON.stringify(envelope(selected, replies.length - selected.length));
	for (const reply of replies) {
		if (cursor > reply.content.length) throw new RangeError("Inbox cursor is beyond the end of this reply.");
		const full = cursor === 0 ? reply : { ...reply, cursor, content: reply.content.slice(cursor) };
		if (full.content.length <= maxBytes && Buffer.byteLength(render([...pages, full])) <= maxBytes) {
			pages.push(full);
			continue;
		}
		// A later reply fits a fresh page once the preceding messages are acknowledged.
		if (pages.length > 0) break;
		const { content, ackToken: _token, ...metadata } = reply;
		const renderPart = (end: number) =>
			render([
				{
					...metadata,
					cursor,
					content: content.slice(cursor, end),
					next: { action: "inbox", messageId: reply.messageId, cursor: end },
				},
			]);
		let low = cursor,
			high = Math.min(content.length, cursor + maxBytes);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (Buffer.byteLength(renderPart(mid)) <= maxBytes) low = mid;
			else high = mid - 1;
		}
		// A valid pair stays on one page. Lone UTF-16 code units still round-trip through JSON escapes.
		if (
			low < content.length &&
			low > cursor &&
			/[\uD800-\uDBFF]/u.test(content[low - 1]!) &&
			/[\uDC00-\uDFFF]/u.test(content[low]!)
		)
			low--;
		if (low <= cursor) throw new Error("Inbox reply metadata leaves no room for content.");
		return renderPart(low);
	}
	return render(pages);
}
