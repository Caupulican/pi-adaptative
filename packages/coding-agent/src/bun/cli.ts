#!/usr/bin/env node
import { APP_NAME, VERSION } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

const cliArgs = process.argv.slice(2);
const [firstArg] = cliArgs;
if ((firstArg === "--version" || firstArg === "-v") && cliArgs.length === 1) {
	console.log(VERSION);
	process.exit(0);
}

await import("../core/extensions/bundled-virtual-modules.ts");
const { restoreSandboxEnv } = await import("./restore-sandbox-env.ts");
restoreSandboxEnv();
await import("./register-bedrock.ts");
await import("../cli.ts");
