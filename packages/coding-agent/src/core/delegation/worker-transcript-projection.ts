import type { Message } from "@caupulican/pi-ai";

/** Inspection excludes provider replay signatures, never similarly named user/tool arguments. */
export function projectWorkerTranscriptForInspection(message: Message): Message {
	if (message.role !== "assistant") return message;
	return {
		...message,
		content: message.content.map((block) => {
			switch (block.type) {
				case "text": {
					const { textSignature: _signature, ...content } = block;
					return content;
				}
				case "thinking": {
					const { thinkingSignature: _signature, ...content } = block;
					return content;
				}
				case "toolCall": {
					const { thoughtSignature: _signature, ...content } = block;
					return content;
				}
				default:
					throw new TypeError("Unsupported worker transcript content.");
			}
		}),
	};
}
