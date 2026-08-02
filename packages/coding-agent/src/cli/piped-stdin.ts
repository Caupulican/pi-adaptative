import type { Readable } from "node:stream";

/** Collect piped UTF-8 input without repeatedly copying the accumulated prefix. */
export async function readPipedInput(input: Readable, isTTY = false): Promise<string | undefined> {
	if (isTTY) return undefined;

	input.setEncoding("utf8");
	const chunks: string[] = [];
	for await (const chunk of input) {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	}
	const content = chunks.join("").trim();
	return content || undefined;
}
