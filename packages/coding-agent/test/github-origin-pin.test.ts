import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	githubOriginPinDiagnostic,
	pinGithubOriginForSession,
	reportGithubOriginPinForSession,
} from "../src/core/github-origin-pin.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pinGithubOriginForSession", () => {
	it("skips a git-less tree", async () => {
		const cwd = await mkdtemp(join(await realpath(tmpdir()), "pi-origin-pin-"));
		temporaryRoots.push(cwd);
		const result = pinGithubOriginForSession(cwd);
		expect(result.status).toBe("skipped");
	});

	it("pins a GitHub origin that is not yet the gh default", () => {
		const config: Record<string, string> = {};
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:Caupulican/pi-adaptative.git\n";
			if (args[0] === "config" && args[1] === "--get-regexp") {
				return Object.entries(config)
					.map(([remote, value]) => `remote.${remote}.gh-resolved ${value}`)
					.join("\n");
			}
			if (args[0] === "config" && args[1] === "remote.origin.gh-resolved") {
				config.origin = args[2] ?? "";
				return "";
			}
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		expect(result).toEqual({ status: "pinned", slug: "Caupulican/pi-adaptative" });
		expect(config.origin).toBe("base");
	});

	it("reports already when origin is already the gh default", () => {
		let regexpCalls = 0;
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "https://github.com/Caupulican/pi-adaptative.git\n";
			if (args[0] === "config" && args[1] === "--get-regexp") {
				regexpCalls += 1;
				return "remote.origin.gh-resolved base\n";
			}
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		expect(result).toEqual({ status: "already", slug: "Caupulican/pi-adaptative" });
		expect(regexpCalls).toBe(1);
	});

	it("skips a non-GitHub origin", () => {
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "git@gitlab.com:group/project.git\n";
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		expect(result).toEqual({ status: "skipped", reason: "not a GitHub origin" });
	});

	it("reports failed when a GitHub origin cannot be pinned", () => {
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:Caupulican/pi-adaptative.git\n";
			throw new Error("error: could not lock config file .git/config");
		});
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.reason).toContain("could not lock config file");
	});

	it("fails when a competing remote cannot be unset and does not claim pinned", () => {
		const config: Record<string, string> = { origin: "base", upstream: "base" };
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:Caupulican/pi-adaptative.git\n";
			if (args[0] === "config" && args[1] === "--get-regexp") {
				return Object.entries(config)
					.map(([remote, value]) => `remote.${remote}.gh-resolved ${value}`)
					.join("\n");
			}
			if (args[0] === "config" && args[1] === "--unset-all") {
				const error = new Error("error: could not lock config file .git/config") as Error & {
					status: number;
				};
				error.status = 4;
				throw error;
			}
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		expect(result.status).toBe("failed");
		expect(config.upstream).toBe("base");
		expect(config.origin).toBe("base");
	});

	it("fails when unset is suppressed by the runner but competing remotes remain on readback", () => {
		const config: Record<string, string> = { origin: "base", upstream: "base" };
		const result = pinGithubOriginForSession("/repo", (args) => {
			if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:Caupulican/pi-adaptative.git\n";
			if (args[0] === "config" && args[1] === "--get-regexp") {
				return Object.entries(config)
					.map(([remote, value]) => `remote.${remote}.gh-resolved ${value}`)
					.join("\n");
			}
			if (args[0] === "config" && args[1] === "--unset-all") return "";
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.reason).toContain("competing gh-resolved remotes remain");
		expect(config.upstream).toBe("base");
	});

	it("fails in a real repo when competing remotes cannot be rewritten", async () => {
		const cwd = await mkdtemp(join(await realpath(tmpdir()), "pi-origin-git-"));
		temporaryRoots.push(cwd);
		execFileSync("git", ["init"], { cwd, stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:Caupulican/pi-adaptative.git"], {
			cwd,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "add", "upstream", "git@github.com:earendil-works/pi.git"], {
			cwd,
			stdio: "ignore",
		});
		execFileSync("git", ["config", "remote.origin.gh-resolved", "base"], { cwd, stdio: "ignore" });
		execFileSync("git", ["config", "remote.upstream.gh-resolved", "base"], { cwd, stdio: "ignore" });
		const lockPath = join(cwd, ".git/config.lock");
		writeFileSync(lockPath, "locked");
		try {
			const result = pinGithubOriginForSession(cwd);
			expect(result.status).toBe("failed");
		} finally {
			unlinkSync(lockPath);
		}
		const remaining = execFileSync("git", ["config", "--get", "remote.upstream.gh-resolved"], {
			cwd,
			encoding: "utf8",
		}).trim();
		expect(remaining).toBe("base");
	});

	it("surfaces only failed pins as diagnostics", () => {
		expect(githubOriginPinDiagnostic({ status: "failed", reason: "could not lock config file" })).toBe(
			"GitHub origin pin failed: could not lock config file",
		);
		expect(githubOriginPinDiagnostic({ status: "already", slug: "Caupulican/pi-adaptative" })).toBeUndefined();
		expect(githubOriginPinDiagnostic({ status: "skipped", reason: "not a GitHub origin" })).toBeUndefined();
		expect(githubOriginPinDiagnostic({ status: "pinned", slug: "Caupulican/pi-adaptative" })).toBeUndefined();
	});

	it("does not pin or diagnose child sessions", () => {
		const appendCustomMessageEntry = vi.fn();
		reportGithubOriginPinForSession("/repo", true, { appendCustomMessageEntry }, () => {
			throw new Error("child sessions must not run git");
		});
		expect(appendCustomMessageEntry).not.toHaveBeenCalled();
	});

	it("records a failed pin diagnostic on root sessions", () => {
		const appendCustomMessageEntry = vi.fn(() => "id");
		reportGithubOriginPinForSession("/repo", false, { appendCustomMessageEntry }, () => {
			throw new Error("could not lock config file");
		});
		expect(appendCustomMessageEntry).toHaveBeenCalledWith(
			"github_origin_pin",
			"GitHub origin pin failed: could not lock config file",
			true,
			{ status: "failed", reason: "could not lock config file" },
		);
	});
});
