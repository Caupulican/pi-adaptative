#!/usr/bin/env node
/**
 * Pin `gh` to this clone's origin. Forks of earendil-works/pi otherwise resolve
 * Actions/releases to the parent when there is no TTY and no set-default.
 * Writes only git config (`remote.origin.gh-resolved`); no GitHub API.
 * Parser ownership is packages/coding-agent/src/core/github-origin-pin.ts.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	githubOriginPinPlan,
	parseGhResolvedMap,
	parseGithubOriginSlug,
} from "../packages/coding-agent/src/core/github-origin-pin.ts";

export { githubOriginPinPlan, parseGhResolvedMap, parseGithubOriginSlug };

export function pinGithubOriginGhDefault({ cwd, git } = {}) {
	const run =
		git ??
		((args, options = {}) => {
			try {
				return execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				if (options.allowFail) return typeof error.stdout === "string" ? error.stdout : "";
				throw error;
			}
		});
	const originUrl = run(["remote", "get-url", "origin"]).trim();
	const resolvedText = run(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true });
	const plan = githubOriginPinPlan(originUrl, parseGhResolvedMap(resolvedText));
	if (plan.setOrigin) run(["config", "remote.origin.gh-resolved", "base"]);
	for (const remote of plan.unset) {
		run(["config", "--unset-all", `remote.${remote}.gh-resolved`], { allowFail: true });
	}
	return { slug: parseGithubOriginSlug(originUrl), ...plan };
}

function main() {
	const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const result = pinGithubOriginGhDefault({ cwd });
	if (result.setOrigin || result.unset.length) {
		process.stdout.write(`gh default pinned to origin (${result.slug})\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
