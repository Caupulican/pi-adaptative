import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const release = resolve(import.meta.dirname, "release.mjs");
const redConclusions = new Set(["failure", "cancelled", "skipped"]);

for (const scenario of [
	"failure",
	"cancelled",
	"skipped",
	"pending",
	"missing",
	"success",
	"check-recovery",
	"foreign-edit",
	"version-mismatch",
	"tag-collision",
	"push-race",
	"promote-local-tag",
]) {
	const conclusion = ["failure", "cancelled", "skipped", "pending", "missing"].includes(scenario) ? scenario : "success";
	test(`adoption execution: ${scenario}`, { skip: process.platform === "win32" }, (context) => {
		const root = mkdtempSync(join(tmpdir(), "pi-release-adoption-"));
		context.after(() => rmSync(root, { recursive: true, force: true }));
		const work = join(root, "work");
		const origin = join(root, "origin.git");
		const racer = join(root, "racer");
		const bin = join(root, "bin");
		mkdirSync(join(work, "packages/ai"), { recursive: true });
		mkdirSync(bin);
		const env = {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.com",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.com",
			GH_REPO: "example/fixture",
			PATH: `${bin}:${process.env.PATH}`,
		};
		const git = (...args) => {
			const result = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		writeFileSync(join(work, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/ai"] }));
		writeFileSync(join(work, "packages/ai/package.json"), JSON.stringify({ name: "fixture-ai", version: "1.0.1" }));
		writeFileSync(join(work, "package-lock.json"), JSON.stringify({ packages: { "packages/ai": { version: "1.0.1" } } }));
		const notes =
			"## [Unreleased]\n\n### Fixed\n\n- Recovery fix.\n\n## [1.0.1] - 2026-01-02\n\n### Added\n\n- Original feature.\n\n## [1.0.0] - 2026-01-01\n";
		writeFileSync(join(work, "packages/ai/CHANGELOG.md"), notes);
		git("init", "--bare", "--initial-branch=main", origin);
		git("init", "--initial-branch=main");
		git("config", "core.autocrlf", "false");
		git("add", "package.json", "package-lock.json", "packages/ai/package.json", "packages/ai/CHANGELOG.md");
		git("commit", "-m", "Prepare local 1.0.1 release candidate");
		git("remote", "add", "origin", origin);
		git("push", "-u", "origin", "main");
		const source = git("rev-parse", "HEAD");
		if (scenario === "version-mismatch") {
			writeFileSync(join(work, "package-lock.json"), JSON.stringify({ packages: { "packages/ai": { version: "1.0.0" } } }));
			git("add", "package-lock.json");
			git("commit", "-m", "Mismatched fixture metadata");
		}
		if (["tag-collision", "promote-local-tag"].includes(scenario)) git("-c", "tag.gpgSign=false", "tag", "v1.0.1");
		const gh = join(bin, "gh");
		writeFileSync(
			gh,
			`#!/usr/bin/env node\nimport {execFileSync} from 'node:child_process';\nconst sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();\nconst verdict=${JSON.stringify(conclusion)};\nconst commitIndex=process.argv.indexOf('--commit');\nconst queriedSha=commitIndex<0?sha:process.argv[commitIndex+1];\nconsole.log(JSON.stringify(verdict==='missing'?[]:[{headSha:queriedSha,databaseId:1,status:verdict==='pending'?'in_progress':'completed',conclusion:verdict==='pending'?null:verdict,url:'https://github.com/example/fixture/actions/runs/1'}]));\n`,
		);
		chmodSync(gh, 0o755);
		const npm = join(bin, "npm");
		writeFileSync(
			npm,
			`#!/usr/bin/env node\nimport {execFileSync} from 'node:child_process';\nimport {appendFileSync,existsSync,writeFileSync} from 'node:fs';\nimport {join} from 'node:path';\nconst first=!existsSync('npm-calls.jsonl');\nappendFileSync('npm-calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');\nif (${JSON.stringify(scenario === "push-race")} && first) {\n  execFileSync('git',['clone',${JSON.stringify(origin)},${JSON.stringify(racer)}],{stdio:'ignore'});\n  writeFileSync(join(${JSON.stringify(racer)},'concurrent.txt'),'concurrent push\\n');\n  execFileSync('git',['-C',${JSON.stringify(racer)},'add','concurrent.txt'],{stdio:'ignore'});\n  execFileSync('git',['-C',${JSON.stringify(racer)},'commit','-m','Concurrent main commit'],{stdio:'ignore'});\n  execFileSync('git',['-C',${JSON.stringify(racer)},'push','origin','main'],{stdio:'ignore'});\n}\nif (first && ${JSON.stringify(["check-recovery", "foreign-edit"].includes(scenario))}) process.exit(17);\n`,
		);
		chmodSync(npm, 0o755);
		// Keep the fixture's command evidence outside the release staging surface.
		writeFileSync(join(work, ".git/info/exclude"), "npm-calls.jsonl\n");
		let result = spawnSync(process.execPath, [release, scenario === "promote-local-tag" ? "promote" : "adopt"], {
			cwd: work,
			env,
			encoding: "utf8",
			timeout: 15_000,
		});
		if (["check-recovery", "foreign-edit"].includes(scenario)) {
			assert.equal(result.status, 1);
			assert.equal(git("rev-parse", "HEAD"), source);
			assert.equal(git("tag", "-l"), "");
			assert.equal(readFileSync(join(work, "packages/ai/CHANGELOG.md"), "utf8").includes("Unreleased"), false);
			if (scenario === "foreign-edit") writeFileSync(join(work, "foreign.txt"), "another session's work");
			result = spawnSync(process.execPath, [release, "adopt"], { cwd: work, env, encoding: "utf8", timeout: 15_000 });
		}
		assert.equal(result.error, undefined);
		assert.equal(JSON.parse(readFileSync(join(work, "packages/ai/package.json"))).version, "1.0.1");
		if (["foreign-edit", "version-mismatch", "tag-collision", "promote-local-tag"].includes(scenario)) {
			assert.equal(result.status, 1, result.stdout + result.stderr);
			assert.equal(git("ls-remote", "--tags", "origin"), "");
			if (scenario === "foreign-edit") assert.equal(readFileSync(join(work, "foreign.txt"), "utf8"), "another session's work");
		} else if (redConclusions.has(scenario)) {
			assert.equal(result.status, 1, result.stdout + result.stderr);
			assert.equal(git("rev-parse", "HEAD"), source);
			assert.equal(existsSync(join(work, "npm-calls.jsonl")), false);
			assert.equal(readFileSync(join(work, "packages/ai/CHANGELOG.md"), "utf8"), notes);
			assert.equal(git("tag", "-l"), "");
			assert.equal(git("ls-remote", "--tags", "origin"), "");
			assert.match(result.stderr, new RegExp(`ci\\.yml on ${source} concluded "${conclusion}"; main is not releasable\\.`));
		} else if (scenario === "push-race") {
			assert.equal(result.status, 75, result.stdout + result.stderr);
			assert.equal(git("tag", "-l"), "");
			assert.equal(git("ls-remote", "--tags", "origin"), "");
			assert.match(result.stderr, /origin\/main moved from .* while the release was prepared; nothing was pushed\./);
		} else {
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.equal(git("tag", "-l"), "v1.0.1");
			assert.equal(git("show", "-s", "--format=%s", "v1.0.1"), "Release v1.0.1");
			assert.equal(git("show", "-s", "--format=%s", "HEAD"), "Add [Unreleased] section for next cycle");
			assert.match(git("ls-remote", "--tags", "origin", "refs/tags/v1.0.1"), /refs\/tags\/v1\.0\.1$/);
			assert.equal(readFileSync(join(work, "npm-calls.jsonl"), "utf8"), '["run","check"]\n'.repeat(scenario === "check-recovery" ? 2 : 1));
			assert.equal(git("status", "--porcelain"), "");
		}
	});
}
