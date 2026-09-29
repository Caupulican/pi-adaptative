import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { SourceInfo } from "./source-info.ts";

const SECRET_STORE_REQUEST_ALIASES = [
	"secret store",
	"credentials",
	"credential",
	"authentication",
	"oauth",
	"api key",
];
const UNGATED_TOOL_SOURCES = new Set(["builtin", "bundled", "inline", "sdk"]);

export function optionalToolRequestAliases(
	toolName: string,
	sourceInfo: SourceInfo | undefined,
	getExtensionVerificationTarget?: () => { toolName: string; path: string } | undefined,
): readonly string[] | undefined {
	if (toolName === "secret_store") return SECRET_STORE_REQUEST_ALIASES;
	if (!sourceInfo || UNGATED_TOOL_SOURCES.has(sourceInfo.source)) return undefined;
	const verification = getExtensionVerificationTarget?.();
	if (verification?.toolName === toolName && verification.path === sourceInfo.path) return undefined;
	return [toolName.replaceAll("_", " ").replaceAll("-", " ")];
}

export function enforceExplicitOptionalToolRequest(input: {
	toolName: string;
	aliases: readonly string[];
	request: string;
}): BeforeToolCallResult | undefined {
	const request = normalizedWords(input.request);
	const requested = input.aliases.some((alias) => {
		const normalizedAlias = normalizedWords(alias);
		return normalizedAlias.length > 0 && ` ${request} `.includes(` ${normalizedAlias} `);
	});
	if (requested) return undefined;
	return {
		block: true,
		reason: `Optional tool ${input.toolName} was blocked because the current owner request does not explicitly ask for it. Continue the requested work without this integration. Do not probe credentials or another optional integration as a fallback.`,
	};
}

function normalizedWords(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{Letter}\p{Number}]+/gu, " ")
		.trim();
}
