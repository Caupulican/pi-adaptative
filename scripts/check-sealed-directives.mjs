#!/usr/bin/env node
/**
 * The sealed directives (packages/coding-agent/src/kernel/sealed-directives.ts) are the owner's standing rules for every
 * agent in every role. This check keeps them from being changed or bypassed by accident:
 *
 * 1. The digest of their canonical text equals the one pinned in scripts/sealed-directives.sha256. Changing the text is
 *    an owner decision: it needs both files edited in the same change, which review sees.
 * 2. The provider request planner writes the seal (`sealSystemPrompt`) where it composes every request's system prompt.
 * 3. The seal is a kernel module with no imports from core/.
 *
 *   node scripts/check-sealed-directives.mjs            # verifies
 *   node scripts/check-sealed-directives.mjs --update   # rewrites the pinned digest (an owner-approved change)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "packages/coding-agent/src");
const module = readFileSync(join(src, "kernel/sealed-directives.ts"), "utf8");
const planner = readFileSync(join(src, "kernel/provider-request-planner.ts"), "utf8");
const pinPath = join(root, "scripts/sealed-directives.sha256");

// The canonical text is the array of string literals under `text: [ ... ].join("\n\n")` of each directive.
const blocks = [...module.matchAll(/id:\s*"([a-z-]+)",\s*text:\s*\[([\s\S]*?)\]\.join\("\\n\\n"\)/g)];
const failures = [];
if (blocks.length === 0) failures.push("no sealed directive could be read from kernel/sealed-directives.ts");
const canonical = blocks
	.map(([, id, body]) => {
		const paragraphs = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
		return `${id}\n${paragraphs.join("\n\n")}`;
	})
	.join("\n---\n");
const digest = createHash("sha256").update(canonical).digest("hex");

if (process.argv.includes("--update")) {
	writeFileSync(pinPath, `${digest}\n`);
	console.log(`check-sealed-directives: pinned ${digest}`);
	process.exit(0);
}

let pinned = "";
try {
	pinned = readFileSync(pinPath, "utf8").trim();
} catch {
	failures.push("scripts/sealed-directives.sha256 is missing");
}
if (pinned && pinned !== digest)
	failures.push(`the sealed text changed (digest ${digest}) but the pinned digest is ${pinned}; an owner-approved change updates both`);
if (!/sealSystemPrompt\(\s*composeRequestSystemPrompt\(\s*sanitized\.systemPrompt,\s*plan\.transientSystemPrompt\s*\)\s*\)/.test(planner))
	failures.push("kernel/provider-request-planner.ts no longer seals, with the default directives, the system prompt it composes for each request");
if (!/SEALED_DIRECTIVES:\s*readonly SealedDirective\[\]\s*=\s*\[\s*CRAFT_LAW\s*\]/.test(module))
	failures.push("SEALED_DIRECTIVES must list exactly the pinned directives (an owner-approved change updates this check)");
const agent = readFileSync(join(src, "kernel/agent.ts"), "utf8");
if (!/requestSystemPrompt\(\): string \{[\s\S]*?sealSystemPrompt\(/.test(agent))
	failures.push("kernel/agent.ts requestSystemPrompt no longer seals the prompt a summarizer request sends");
if (/from\s+"\.\.\/core\//.test(module) || /from\s+"@caupulican\/pi-coding-agent/.test(module))
	failures.push("kernel/sealed-directives.ts must not import from core/");

if (failures.length > 0) {
	console.error("Sealed directives check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`check-sealed-directives: ${blocks.length} sealed directive(s), digest ${digest.slice(0, 12)}`);
