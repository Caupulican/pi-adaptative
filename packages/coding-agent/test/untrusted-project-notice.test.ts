import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

/**
 * Without an interactive app nobody can be asked to trust a project, so it runs untrusted; the run says
 * so, since its own settings (toolkit scripts, models, extensions) silently not applying reads as them
 * being broken. A project trusted for the run by --approve gets no notice.
 */
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function run(args: string[]) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-untrusted-notice-")));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	const home = join(root, "home");
	mkdirSync(join(home, "agent"), { recursive: true });
	return spawnSync(process.execPath, ["--conditions=pi-source", cli, ...args], {
		cwd: project,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: join(home, "agent"),
			HOME: home,
			USERPROFILE: home,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
		},
		encoding: "utf8",
		timeout: 120_000,
	});
}

// Each case starts the CLI from source; a cold start on the Windows runners outlasts the default 30 s.
describe("untrusted project notice", { timeout: 150_000 }, () => {
	it("tells a non-interactive run that an undecided project runs untrusted, and how to trust it", () => {
		const result = run(["-p", "hello"]);
		expect(result.stderr).toContain(
			"is not trusted, so its .pi settings, extensions and instructions are not loaded",
		);
		expect(result.stderr).toContain("--approve (-a)");
	});

	it("says nothing when the run trusts the project", () => {
		expect(run(["-a", "-p", "hello"]).stderr).not.toContain("is not trusted");
	});

	it("says nothing for an invocation that runs no session", () => {
		expect(run(["--help"]).stderr).not.toContain("is not trusted");
	});
});
