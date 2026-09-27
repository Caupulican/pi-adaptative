import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import { tempDir } from "./temp-dir.ts";

function createRepo(root: string, name: string): string {
	const repo = join(root, name);
	mkdirSync(join(repo, ".git"), { recursive: true });
	writeFileSync(join(repo, ".git", "HEAD"), `ref: refs/heads/${name}\n`);
	return repo;
}

describe("FooterDataProvider branch listener isolation", () => {
	it("contains a failing listener and continues the branch transition", () => {
		const root = tempDir("footer-listener-failure-");
		const firstRepo = createRepo(root, "first");
		const secondRepo = createRepo(root, "second");
		const provider = new FooterDataProvider(firstRepo, { watchGit: false });
		const later = vi.fn();
		provider.onBranchChange(() => {
			throw new Error("extension footer failed");
		});
		provider.onBranchChange(later);

		expect(() => provider.setCwd(secondRepo)).not.toThrow();
		expect(later).toHaveBeenCalledOnce();
		expect(provider.getGitBranch()).toBe("second");
		provider.dispose();
	});

	it("admits listeners registered during a branch transition on the next transition", () => {
		const root = tempDir("footer-listener-generation-");
		const firstRepo = createRepo(root, "first");
		const secondRepo = createRepo(root, "second");
		const thirdRepo = createRepo(root, "third");
		const provider = new FooterDataProvider(firstRepo, { watchGit: false });
		const observed: string[] = [];
		const late = vi.fn(() => observed.push("late"));
		provider.onBranchChange(() => {
			observed.push("first");
			provider.onBranchChange(late);
		});
		provider.onBranchChange(() => observed.push("existing"));

		provider.setCwd(secondRepo);
		expect(observed).toEqual(["first", "existing"]);

		observed.length = 0;
		provider.setCwd(thirdRepo);
		expect(observed).toEqual(["first", "existing", "late"]);
		provider.dispose();
	});

	it("contains a rejected listener promise without delaying later listeners", async () => {
		const root = tempDir("footer-listener-rejection-");
		const firstRepo = createRepo(root, "first");
		const secondRepo = createRepo(root, "second");
		const provider = new FooterDataProvider(firstRepo, { watchGit: false });
		const later = vi.fn();
		provider.onBranchChange(() => Promise.reject(new Error("async extension footer failed")));
		provider.onBranchChange(later);

		provider.setCwd(secondRepo);
		expect(later).toHaveBeenCalledOnce();
		await new Promise<void>((resolve) => setImmediate(resolve));
		provider.dispose();
	});

	it("applies listener removal after the current branch-transition generation", () => {
		const root = tempDir("footer-listener-removal-");
		const firstRepo = createRepo(root, "first");
		const secondRepo = createRepo(root, "second");
		const thirdRepo = createRepo(root, "third");
		const provider = new FooterDataProvider(firstRepo, { watchGit: false });
		const observed: string[] = [];
		let removeSecond = () => {};
		provider.onBranchChange(() => {
			observed.push("first");
			removeSecond();
		});
		removeSecond = provider.onBranchChange(() => observed.push("second"));

		provider.setCwd(secondRepo);
		expect(observed).toEqual(["first", "second"]);

		observed.length = 0;
		provider.setCwd(thirdRepo);
		expect(observed).toEqual(["first"]);
		provider.dispose();
	});
});
