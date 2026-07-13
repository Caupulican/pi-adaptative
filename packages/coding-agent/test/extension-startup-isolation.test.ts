import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(
	args: string[],
	cwd: string,
	agentDir: string,
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}> {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			NO_COLOR: "1",
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stderr });
		});
	});
}

describe("extension startup isolation", () => {
	it("reports a throwing extension as a warning instead of a fatal startup diagnostic", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-extension-startup-isolation-"));
		tempDirs.push(tempRoot);
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const extensionPath = join(tempRoot, "throwing-extension.ts");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	pi.sendMessage({ customType: "invalid-load-action", content: "not allowed during load", display: false });
}
`,
			"utf8",
		);

		const result = await runCli(
			["--no-extensions", "--extension", extensionPath, "--model", "missing-model", "-p", "hi"],
			projectDir,
			agentDir,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain(`Warning: Failed to load extension "${extensionPath}"`);
		expect(result.stderr).not.toContain(`Error: Failed to load extension "${extensionPath}"`);
	});
});
