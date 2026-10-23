import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Api, Context, Model } from "@caupulican/pi-ai";

/**
 * Opt-in request fingerprints for finding where a provider prompt cache stops matching.
 *
 * A provider caches the longest byte-identical prefix of a request, so a miss starts at the first
 * segment (system prompt, tool, message) that differs from the previous request. With
 * `PI_CACHE_TRACE=<file>` every provider request appends one JSON line holding a hash and size per
 * segment, in wire order. No prompt text is written. Comparing consecutive lines of one session
 * names the first segment that changed.
 */

function digest(value: unknown): string {
	return createHash("sha1")
		.update(JSON.stringify(value) ?? "")
		.digest("hex")
		.slice(0, 12);
}

type SegmentFingerprint = [label: string, hash: string, chars: number];

function segment(label: string, value: unknown): SegmentFingerprint {
	return [label, digest(value), (JSON.stringify(value) ?? "").length];
}

export function traceProviderRequest(model: Model<Api>, context: Context, sessionId: string | undefined): void {
	const path = process.env.PI_CACHE_TRACE;
	if (!path) return;
	const record = {
		at: new Date().toISOString(),
		session: sessionId,
		model: `${model.provider}/${model.id}`,
		system: segment("system", context.systemPrompt ?? ""),
		tools: (context.tools ?? []).map((tool) => segment(tool.name, tool)),
		messages: context.messages.map((message, index) =>
			segment(`${index}:${message.role}`, { role: message.role, content: message.content }),
		),
	};
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}
