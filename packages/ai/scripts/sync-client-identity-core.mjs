import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function installedCliVersion(command, executableArg, versionPattern, label) {
	let executable;
	if (executableArg) {
		executable = realpathSync(isAbsolute(executableArg) ? executableArg : resolve(executableArg));
	} else {
		for (const directory of (process.env.PATH ?? "").split(delimiter)) {
			if (!directory) continue;
			for (const name of process.platform === "win32" ? [`${command}.exe`, command] : [command]) {
				const candidate = join(directory, name);
				try {
					accessSync(candidate, constants.X_OK);
					if (statSync(candidate).isFile()) {
						executable = realpathSync(candidate);
						break;
					}
				} catch {
					continue;
				}
			}
			if (executable) break;
		}
	}
	if (!executable) throw new Error(`${label} executable was not found on PATH; pass its local path explicitly`);
	const versionOutput = execFileSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const match = versionPattern.exec(versionOutput);
	if (!match) throw new Error(`Installed ${label} did not report a supported version`);
	return match[1];
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
