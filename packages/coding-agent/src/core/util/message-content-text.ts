/** The text parts of a message's or tool result's content, joined by newlines; non-text parts are skipped. */
export function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? [(part as { text: string }).text]
				: [],
		)
		.join("\n");
}
