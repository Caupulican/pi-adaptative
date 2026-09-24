import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [executableArg, outputArg, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error("Usage: node scripts/sync-claude-identity.mjs [claude-executable] [output-file]");

function executableFromPath() {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const name of process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"]) {
			const candidate = join(directory, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				continue;
			}
		}
	}
	throw new Error("Claude executable was not found on PATH; pass its local path explicitly");
}

const executable = realpathSync(executableArg ? (isAbsolute(executableArg) ? executableArg : resolve(executableArg)) : executableFromPath());
const versionOutput = execFileSync(executable, ["--version"], {
	encoding: "utf8",
	timeout: 5000,
	maxBuffer: 1024,
	stdio: ["ignore", "pipe", "pipe"],
}).trim();
const match = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(versionOutput);
if (!match) throw new Error("Installed Claude did not report a supported Claude Code version");
const version = match[1];
const config = {
	version,
	messagesUserAgent: `claude-cli/${version} (external, cli)`,
	usageUserAgent: `claude-code/${version}`,
};
const output = outputArg
	? resolve(outputArg)
	: fileURLToPath(new URL("../src/providers/anthropic-client-config.generated.ts", import.meta.url));
const fields = Object.entries(config).map(([key, value]) => `\t${key}: ${JSON.stringify(value)},`).join("\n");
const content = `export const ANTHROPIC_CLIENT_CONFIG = {\n${fields}\n} as const;\n`;
if (existsSync(output) && readFileSync(output, "utf8") === content) {
	console.log(`Claude identity config is current: ${version}`);
	process.exit(0);
}
const temporary = `${output}.${process.pid}.tmp`;
try {
	writeFileSync(temporary, content, { flag: "wx" });
	renameSync(temporary, output);
} finally {
	if (existsSync(temporary)) rmSync(temporary);
}
console.log(`Wrote Claude identity config for ${version}`);
