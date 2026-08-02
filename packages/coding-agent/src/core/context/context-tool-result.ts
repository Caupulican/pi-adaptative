import type { ToolResultMessage } from "@caupulican/pi-ai";

export function getToolResultArtifactId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

export function getToolResultText(message: ToolResultMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}
