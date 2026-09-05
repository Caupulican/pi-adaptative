#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME, VERSION } from "./config.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const cliArgs = process.argv.slice(2);
const [firstArg] = cliArgs;
const packageCommands = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

// Fast path: version needs nothing beyond config.ts (already loaded). Mirrors main.ts's
// `parsed.version` output exactly; skipping main's import graph turns ~1s into ~150ms.
// Must run before HTTP/undici setup so a compiled `pi --version` cannot die on dispatcher init.
if ((firstArg === "--version" || firstArg === "-v") && cliArgs.length === 1) {
	console.log(VERSION);
	process.exit(0);
}

const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();
// Installers use the activated release's sole Herdr provisioner, without loading sessions/settings.
if (firstArg === "--provision-herdr" && cliArgs.length === 1) {
	const { runHerdrProvisionCommand } = await import("./core/collaboration/herdr-provision.ts");
	await runHerdrProvisionCommand();
	process.exit(0);
}
if ((cliArgs.includes("--help") || cliArgs.includes("-h")) && !packageCommands.has(firstArg ?? "")) {
	const [{ parseArgs, printHelp }, { takeOverStdout }] = await Promise.all([
		import("./cli/args.ts"),
		import("./core/output-guard.ts"),
	]);
	const parsed = parseArgs(cliArgs);
	if (parsed.mode === "json" || parsed.mode === "rpc" || parsed.print || !process.stdin.isTTY) {
		takeOverStdout();
	}
	printHelp([]);
	process.exit(0);
}

const { main } = await import("./main.ts");
await main(cliArgs);
