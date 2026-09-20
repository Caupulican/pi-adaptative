#!/usr/bin/env node
/**
 * Optional live-provider smoke.
 *
 * Runs only in an authorized local environment that already has credentials, and is never invoked
 * by CI. Without credentials it reports `not run` and exits 0: an absent live smoke is not a
 * failure, and it is never a release blocker by itself.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER_KEY_VARIABLES = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"TYPESAFE_API_KEY",
];

function credentialsPresent() {
	if (PROVIDER_KEY_VARIABLES.some((name) => process.env[name])) return true;
	return existsSync(join(homedir(), ".pi", "agent", "auth.json"));
}

if (process.env.CI) {
	console.log("live-provider smoke: not run (never invoked by CI)");
	process.exit(0);
}

if (!credentialsPresent()) {
	console.log("live-provider smoke: not run (no credentials in this environment)");
	process.exit(0);
}

console.log("live-provider smoke: credentials present.");
console.log("Run the smoke explicitly in an authorized environment; this command never spends tokens on its own.");
console.log("live-provider smoke: not run");
