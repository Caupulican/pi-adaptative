/**
 * Pins the Codex CLI's bundled model catalogue at one release, for the model generator and for the
 * client version pi reports to the Codex models endpoint. Codex's catalogue is the source of truth
 * for which models the ChatGPT backend serves to a Codex client and how each one is driven (context
 * window, reasoning levels, Responses Lite, Ultra's wire effort); pricing is not in it and comes from
 * the public listings in generate-models.ts.
 *
 *   node scripts/sync-codex-models.ts <codex-checkout> <release-tag>
 *   node scripts/sync-codex-models.ts ../../../external/codex rust-v0.156.1
 *
 * Then regenerate (PI_FETCH_MODELS=1 npm run generate-models) and set OPENAI_CODEX_CLIENT_VERSION in
 * src/providers/openai-codex-account.ts to the written `clientVersion` (a test pins the two together).
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The fields pi derives a Codex model from; the rest of Codex's entry is Codex-CLI behavior. */
const KEPT_FIELDS = [
	"slug",
	"display_name",
	"visibility",
	"priority",
	"minimal_client_version",
	"context_window",
	"input_modalities",
	"default_reasoning_level",
	"supported_reasoning_levels",
	"multi_agent_reasoning_effort",
	"use_responses_lite",
	"supported_in_api",
] as const;

function gitShow(checkout: string, tag: string, path: string): string {
	return execFileSync("git", ["-C", checkout, "show", `${tag}:${path}`], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const [checkout, tag] = process.argv.slice(2);
if (!checkout || !tag) {
	throw new Error("Usage: node scripts/sync-codex-models.ts <codex-checkout> <release-tag>");
}

const cargo = gitShow(checkout, tag, "codex-rs/Cargo.toml");
const clientVersion = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
if (!clientVersion) throw new Error(`No [workspace.package] version in codex-rs/Cargo.toml at ${tag}`);

const catalogue = JSON.parse(gitShow(checkout, tag, "codex-rs/models-manager/models.json")) as {
	models?: Record<string, unknown>[];
};
if (!Array.isArray(catalogue.models)) throw new Error(`No models list in Codex's catalogue at ${tag}`);

const models = catalogue.models.map((model) => {
	const kept: Record<string, unknown> = {};
	for (const field of KEPT_FIELDS) {
		if (model[field] === undefined) continue;
		kept[field] =
			field === "supported_reasoning_levels" && Array.isArray(model[field])
				? (model[field] as { effort?: unknown }[]).map((level) => level.effort)
				: model[field];
	}
	return kept;
});

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "data", "codex-models.json");
writeFileSync(
	outputPath,
	`${JSON.stringify(
		{
			source: { repository: "openai/codex", tag, path: "codex-rs/models-manager/models.json", clientVersion },
			models,
		},
		null,
		"\t",
	)}\n`,
);
console.log(`Wrote ${models.length} Codex models from ${tag} (client ${clientVersion}) to ${outputPath}`);
