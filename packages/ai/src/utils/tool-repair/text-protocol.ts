import type { Tool } from "../../types.ts";

export interface ParsedTextToolCalls {
	calls: [];
	text: string;
}

export function generateTextToolProtocolPrimer(_tools: readonly Tool[]): string {
	return "";
}

export function parseTextToolCalls(text: string, _knownTools: readonly Tool[]): ParsedTextToolCalls {
	return { calls: [], text };
}
