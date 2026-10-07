import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstalledCli, readInstalledCliVersion } from "../src/utils/installed-cli.ts";

export async function installedCliVersion(command, executableArg, versionPattern, label) {
	const installation = await findInstalledCli(command, executableArg);
	if (!installation) throw new Error(`${label} executable was not found on PATH; pass its local path explicitly`);
	return readInstalledCliVersion(installation, versionPattern);
}

export function writeClientIdentity(outputArg, defaultOutput, constantName, config, label) {
	const output = outputArg ? resolve(outputArg) : fileURLToPath(defaultOutput);
	const fields = Object.entries(config).map(([key, value]) => `\t${key}: ${JSON.stringify(value)},`).join("\n");
	const content = `export const ${constantName} = {\n${fields}\n} as const;\n`;
	if (existsSync(output) && readFileSync(output, "utf8") === content) {
		console.log(`${label} identity config is current: ${config.version}`);
		return;
	}
	const temporary = `${output}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, content, { flag: "wx" });
		renameSync(temporary, output);
	} finally {
		if (existsSync(temporary)) rmSync(temporary);
	}
	console.log(`Wrote ${label} identity config for ${config.version}`);
}
