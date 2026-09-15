import assert from "node:assert/strict";
import test from "node:test";
import { githubOriginPinPlan, parseGhResolvedMap, parseGithubOriginSlug } from "./github-origin.mjs";

test("parses GitHub HTTPS, SSH, and ssh-protocol origin URLs", () => {
	assert.equal(parseGithubOriginSlug("https://github.com/Caupulican/pi-adaptative.git"), "Caupulican/pi-adaptative");
	assert.equal(parseGithubOriginSlug("git@github.com:Caupulican/pi-adaptative.git"), "Caupulican/pi-adaptative");
	assert.equal(parseGithubOriginSlug("ssh://git@github.com/Caupulican/pi-adaptative.git"), "Caupulican/pi-adaptative");
	assert.equal(parseGithubOriginSlug("https://github.com/Caupulican/pi-adaptative"), "Caupulican/pi-adaptative");
});

test("rejects non-GitHub remotes and incomplete paths", () => {
	assert.throws(() => parseGithubOriginSlug("https://gitlab.com/foo/bar.git"), /Not a GitHub origin URL/);
	assert.throws(() => parseGithubOriginSlug("https://github.com/only-owner"), /Not a GitHub origin URL/);
	assert.throws(() => parseGithubOriginSlug(""), /Not a GitHub origin URL/);
	assert.throws(() => parseGithubOriginSlug("https://earendil-works/pi.git"), /Not a GitHub origin URL/);
});

test("pin plan sets origin and clears gh-resolved on other remotes", () => {
	const parentPinned = parseGhResolvedMap("remote.upstream.gh-resolved base\nremote.origin.gh-resolved\n");
	const plan = githubOriginPinPlan("https://github.com/Caupulican/pi-adaptative.git", parentPinned);
	assert.deepEqual(plan, { setOrigin: true, unset: ["upstream"] });
	const already = githubOriginPinPlan("https://github.com/Caupulican/pi-adaptative.git", { origin: "base" });
	assert.deepEqual(already, { setOrigin: false, unset: [] });
});

test("pin plan refuses a non-GitHub origin before touching remotes", () => {
	assert.throws(
		() => githubOriginPinPlan("https://gitlab.com/foo/bar.git", { upstream: "base" }),
		/Not a GitHub origin URL/,
	);
});
