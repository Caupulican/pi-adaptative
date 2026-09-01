/**
 * Env-gated provider-request payload dump for prefix-stability diagnosis.
 *
 * When `PI_REQUEST_DUMP_DIR` is set, every accepted provider request is serialized to one
 * numbered JSON file in that directory. The files are the ground truth the fingerprints in
 * `request_snapshot` entries only summarize: diffing two consecutive dumps shows the first
 * divergent byte of the request a provider prefix cache would have seen, and therefore which
 * pass moved it. Diagnostic only — never enabled by default, never trusted by any runtime path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@caupulican/pi-ai";

let sequence = 0;

export function dumpProviderRequest(requestId: string, context: Context): void {
	const dir = process.env.PI_REQUEST_DUMP_DIR;
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		const payload = {
			requestId,
			systemPrompt: context.systemPrompt,
			// Full projected tool payload (name, description, AND parameters schema) — not just
			// name/description. Tool-schema churn is exactly the kind of prefix-stability defect this
			// dump exists to diagnose, and a schema-only diff was invisible to a dump that dropped
			// `parameters`.
			tools: (context.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			messages: context.messages,
		};
		const name = `request-${String(sequence++).padStart(4, "0")}.json`;
		writeFileSync(join(dir, name), JSON.stringify(payload, null, 1));
	} catch {
		// A failed diagnostic write must never fail the request it observes.
	}
}
