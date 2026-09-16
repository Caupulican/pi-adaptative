import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test launch bootstrap", () => {
	it("removes inherited terminal and worker authority before tests can use live host resources", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bootstrap-authority-"));
		const inherited = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: join(directory, "host.sock"),
			HERDR_PANE_ID: "host-pane",
			HERDR_SESSION: "host-session",
			PI_COLLABORATION_STATE_DIR: directory,
			PI_COLLABORATION_PEER_TOKEN: "fixture-token",
			PI_PARENT_PID: "12345",
			PI_PARENT_SESSION: "host-parent",
			PI_SESSION_ROLE: "worker",
			PI_ORCHESTRATION_AGENT_ID: "host-agent",
			PI_TASK_REF: "host-task",
			PI_WORKTREE_LANE: "host-lane",
			PI_WORKER_ALLOWED_PATHS: "host-paths",
		};
		try {
			const entry = join(directory, "probe.mjs");
			writeFileSync(
				entry,
				[
					`import ${JSON.stringify(new URL("./test-launch-env-setup.ts", import.meta.url).href)};`,
					`console.log(JSON.stringify({ retained: ${JSON.stringify(Object.keys(inherited))}.filter(key => process.env[key] !== undefined), control: process.env.PI_NO_LOCAL_LLM, ordinary: process.env.TEST_ORDINARY_VALUE }));`,
				].join("\n"),
			);
			const result = spawnSync(process.execPath, ["--conditions=pi-source", entry], {
				encoding: "utf8",
				timeout: 10_000,
				env: { ...process.env, ...inherited, PI_NO_LOCAL_LLM: "1", TEST_ORDINARY_VALUE: "kept" },
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ retained: [], control: "1", ordinary: "kept" });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("sanitizes launch metadata before importing config while preserving explicit runtime overrides outside tests", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bootstrap-regression-"));
		try {
			writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "poisoned-runtime", version: "0.0.0" }));
			for (const sanitize of [false, true]) {
				const entry = join(directory, "probe.mjs");
				writeFileSync(
					entry,
					[
						sanitize
							? `import ${JSON.stringify(new URL("./test-launch-env-setup.ts", import.meta.url).href)};`
							: "",
						`import { PACKAGE_NAME, getPackageDependencyVersion } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};`,
						"console.log(PACKAGE_NAME);",
						"console.log(getPackageDependencyVersion('jscpd'));",
					].join("\n"),
				);
				const result = spawnSync(process.execPath, ["--conditions=pi-source", entry], {
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, PI_PACKAGE_DIR: directory },
				});
				expect(result.error).toBeUndefined();
				if (sanitize) {
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout).not.toContain("poisoned-runtime");
				} else {
					expect(result.status).not.toBe(0);
					expect(result.stdout).toContain("poisoned-runtime");
					expect(result.stderr).toContain("must pin 'jscpd'");
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
