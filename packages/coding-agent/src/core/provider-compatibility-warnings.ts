import type { AssistantMessage } from "@caupulican/pi-ai";

/** Project provider-owned compatibility diagnostics into the existing session warning channel. */
export class ProviderCompatibilityWarnings {
	private previous: string | undefined;

	read(message: AssistantMessage): string | undefined {
		const diagnostic = message.diagnostics?.find((entry) => entry.type === "anthropic_client_compatibility");
		const text = diagnostic?.details?.message;
		if (typeof text !== "string") {
			if (diagnostic) this.previous = undefined;
			return undefined;
		}
		const warning = text.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500);
		if (!warning || warning === this.previous) return undefined;
		this.previous = warning;
		return warning;
	}
}
