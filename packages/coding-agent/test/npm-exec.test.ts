import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmExec } from "../src/core/objective-execution/npm-exec.ts";

describe("npmExec", () => {
	it("runs npm directly on posix", () => {
		expect(npmExec(undefined, "linux", "/usr/bin/node")).toEqual({ command: "npm", args: [] });
	});

	it("runs the node distribution's npm-cli.js on windows instead of npm.cmd", () => {
		const root = join(tmpdir(), `pi-npm-exec-${process.pid}`);
		const cli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
		mkdirSync(join(root, "node_modules", "npm", "bin"), { recursive: true });
		writeFileSync(cli, "");
		const execPath = join(root, "node.exe");
		expect(npmExec(undefined, "win32", execPath)).toEqual({ command: execPath, args: [cli] });
	});

	it("fails closed when the windows node distribution has no npm-cli.js", () => {
		expect(() => npmExec(undefined, "win32", join(tmpdir(), "missing-node", "node.exe"))).toThrow(
			"npm_cli_unavailable",
		);
	});

	it("keeps an explicit npm command", () => {
		expect(npmExec(["/opt/npm", "--prefix", "/tmp"], "win32", "/usr/bin/node")).toEqual({
			command: "/opt/npm",
			args: ["--prefix", "/tmp"],
		});
	});
});
