import { type ExtensionAPI, piChatExtension, renderTitleBadge } from "@caupulican/pi-adaptative";
import { Text } from "@caupulican/pi-tui";

export const piConfig = { tools: ["list_peers", "agent_send"] };

type IncomingDetails = {
	kind?: string;
	from?: { id?: string; name?: string; address?: string; verified?: boolean };
	expectReply?: boolean;
	metadata?: Record<string, unknown>;
	message?: string;
	messageBytes?: number;
	messageLines?: number;
	receivedAt?: string;
};

function isIncoming(value: unknown): value is IncomingDetails {
	return typeof value === "object" && value !== null && (value as IncomingDetails).kind === "incoming";
}

export default function chat(pi: ExtensionAPI): void {
	piChatExtension(pi);
	pi.registerMessageRenderer("pi-chat", (message, options, theme) => {
		if (!isIncoming(message.details)) {
			return new Text(`${renderTitleBadge(theme, { label: "pi-chat" })} ${String(message.content ?? "")}`, 0, 0);
		}
		const details = message.details;
		const fromName = details.from?.name ?? "unknown peer";
		const bytes = details.messageBytes ?? Buffer.byteLength(details.message ?? "", "utf8");
		const lines = details.messageLines ?? (details.message ? details.message.split(/\r?\n/).length : 0);
		let text = renderTitleBadge(theme, {
			label: "pi-chat",
			action: `message from ${fromName} [${details.from?.verified === true ? "verified pi session" : "UNVERIFIED peer"}]`,
			details: [
				`${lines} line${lines === 1 ? "" : "s"}`,
				`${bytes} byte${bytes === 1 ? "" : "s"}`,
				"Ctrl+O to open",
			],
			status: details.expectReply ? "warning" : "info",
		});
		if (details.expectReply) text += theme.fg("warning", " · reply requested");
		if (options.expanded) {
			text += `\n${theme.fg("dim", `from id: ${details.from?.id ?? "unknown-id"}, label: ${fromName} (self-declared)${details.from?.address ? ` ${details.from.address}` : ""}`)}`;
			if (details.receivedAt) text += `\n${theme.fg("dim", `received: ${details.receivedAt}`)}`;
			text += `\n\n${details.message ?? ""}`;
			if (details.metadata && Object.keys(details.metadata).length > 0) {
				text += `\n\n${theme.fg("dim", `metadata: ${JSON.stringify(details.metadata, null, 2)}`)}`;
			}
		}
		return new Text(text, 0, 0);
	});
}
