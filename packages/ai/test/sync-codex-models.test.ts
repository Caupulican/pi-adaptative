import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { committedRepo } from "../../coding-agent/test/git-fixture.ts";
import { tempDir } from "../../coding-agent/test/temp-dir.ts";

describe("Codex catalogue reference sync", () => {
	it("pins a newer catalogue with a released client identity and rejects unreleased identity", () => {
		const checkout = committedRepo("pi-codex-reference-");
		execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: checkout });
		const scripts = tempDir("pi-codex-sync-");
		mkdirSync(join(scripts, "data"));
		copyFileSync(new URL("../scripts/sync-codex-models.ts", import.meta.url), join(scripts, "sync.ts"));
		mkdirSync(join(checkout, "codex-rs", "models-manager"), { recursive: true });
		const cargo = join(checkout, "codex-rs", "Cargo.toml");
		const catalogue = join(checkout, "codex-rs", "models-manager", "models.json");
		writeFileSync(cargo, '[workspace.package]\nversion = "0.159.0"\n');
		writeFileSync(catalogue, JSON.stringify({ models: [{ slug: "released", supported_reasoning_levels: [] }] }));
		execFileSync("git", ["add", "codex-rs"], { cwd: checkout });
		execFileSync("git", ["commit", "-m", "released catalogue"], { cwd: checkout, stdio: "ignore" });
		execFileSync("git", ["tag", "rust-v0.159.0"], { cwd: checkout });
		writeFileSync(cargo, '[workspace.package]\nversion = "0.0.0"\n');
		writeFileSync(
			catalogue,
			JSON.stringify({ models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "low" }] }] }),
		);
		execFileSync("git", ["add", "codex-rs"], { cwd: checkout });
		execFileSync("git", ["commit", "-m", "new model"], { cwd: checkout, stdio: "ignore" });
		const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
		const script = join(scripts, "sync.ts");
		const output = join(scripts, "data", "codex-models.json");
		const rejected = spawnSync(process.execPath, [script, checkout, revision], { encoding: "utf8" });
		expect(rejected.status).toBe(1);
		expect(rejected.stderr).toContain("supply a client-release-tag");
		expect(existsSync(output)).toBe(false);
		const accepted = spawnSync(process.execPath, [script, checkout, revision, "rust-v0.159.0"], { encoding: "utf8" });
		expect(accepted.status, accepted.stderr).toBe(0);
		expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
			source: { tag: revision, clientTag: "rust-v0.159.0", clientVersion: "0.159.0" },
			models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: ["low"] }],
		});
	});
});
