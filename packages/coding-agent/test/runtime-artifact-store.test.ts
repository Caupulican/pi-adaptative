import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeArtifactStore } from "../src/cli/runtime-artifact-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-artifact-"));
	roots.push(root);
	const origin = join(root, "origin");
	const artifacts = join(root, "artifacts");
	await mkdir(join(origin, "src"), { recursive: true });
	await mkdir(artifacts);
	await writeFile(join(origin, "src", "cli.mjs"), "known good");
	const store = new RuntimeArtifactStore(
		{
			root: origin,
			entries: ["src"],
			target: { executable: process.execPath, argsPrefix: [join(origin, "src", "cli.mjs")] },
		},
		artifacts,
	);
	return { root, origin, artifacts, store };
}

describe("immutable runtime artifacts", () => {
	it("reserves retention capacity before concurrent captures start", async () => {
		const f = await fixture();
		const store = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: { executable: join(f.origin, "src", "cli.mjs"), argsPrefix: [] },
			},
			f.artifacts,
		);
		const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.capture()));
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const retained = results.find((result) => result.status === "fulfilled");
		if (retained?.status !== "fulfilled") throw new Error("Missing captured generation.");
		await store.retire(retained.value);
		await expect(store.capture()).resolves.toBeTypeOf("string");
	});

	it("retains code independently of in-place edits and remaps internal links", async () => {
		const f = await fixture();
		await symlink(join(f.origin, "src", "cli.mjs"), join(f.origin, "src", "alias.mjs"));
		const artifact = await f.store.capture();
		await writeFile(join(f.origin, "src", "cli.mjs"), "broken replacement");
		expect(await readFile(join(artifact, "src", "alias.mjs"), "utf8")).toBe("known good");
		expect(f.store.target(artifact).argsPrefix).toEqual([join(artifact, "src", "cli.mjs")]);
		const next = await f.store.capture();
		expect(await readFile(join(next, "src", "cli.mjs"), "utf8")).toBe("broken replacement");
		await f.store.retire(next);
		await expect(f.store.retire(f.origin)).rejects.toThrow("owned");
		expect(await readFile(join(f.origin, "src", "cli.mjs"), "utf8")).toBe("broken replacement");
	});

	it("rejects external links instead of retaining mutable code outside the snapshot", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "external.mjs"), "external");
		await symlink(join(f.root, "external.mjs"), join(f.origin, "src", "outside.mjs"));
		await expect(f.store.capture()).rejects.toThrow("outside");
		await rm(join(f.origin, "src", "outside.mjs"));
		await expect(f.store.capture()).resolves.toBeTypeOf("string");
	});

	it("remaps relative and inline loader paths, rejecting unresolved external loaders", async () => {
		const f = await fixture();
		const relativeRoot = join(f.origin, "src", "cli.mjs");
		const store = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: {
					executable: process.execPath,
					argsPrefix: [`--import=${relative(process.cwd(), relativeRoot)}`, relativeRoot],
				},
			},
			f.artifacts,
		);
		const artifact = await store.capture();
		expect(store.target(artifact).argsPrefix).toEqual([
			`--import=${join(artifact, "src", "cli.mjs")}`,
			join(artifact, "src", "cli.mjs"),
		]);
		const unsafe = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: { executable: process.execPath, argsPrefix: ["--import", "unresolved-loader", relativeRoot] },
			},
			f.artifacts,
		);
		await expect(unsafe.capture()).rejects.toThrow("loader");
		const compact = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: { executable: process.execPath, argsPrefix: [`-r${relativeRoot}`, relativeRoot] },
			},
			f.artifacts,
		);
		const compactArtifact = await compact.capture();
		expect(compact.target(compactArtifact).argsPrefix[0]).toBe(
			`--require=${join(compactArtifact, "src", "cli.mjs")}`,
		);
	});

	it("copies each version once into the pool and links it into every generation that needs it", async () => {
		const f = await fixture();
		const pool = join(f.root, "pool");
		const pooled = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: { executable: process.execPath, argsPrefix: [join(f.origin, "src", "cli.mjs")] },
			},
			f.artifacts,
			pool,
		);
		const first = await pooled.capture();
		const second = await pooled.capture();
		const [a, b] = await Promise.all([lstat(join(first, "src", "cli.mjs")), lstat(join(second, "src", "cli.mjs"))]);
		// One pooled copy shared by both generations, never the source inode itself.
		expect(a.ino).toBe(b.ino);
		expect(a.ino).not.toBe((await lstat(join(f.origin, "src", "cli.mjs"))).ino);
		expect(a.nlink).toBe(3);
		expect(a.mode & 0o222).toBe(0);
		// An in-place edit of the source is a new version: the generations keep what they captured.
		await writeFile(join(f.origin, "src", "cli.mjs"), "edited in place");
		const third = await pooled.capture();
		expect(await readFile(join(first, "src", "cli.mjs"), "utf8")).toBe("known good");
		expect(await readFile(join(third, "src", "cli.mjs"), "utf8")).toBe("edited in place");
		await pooled.settle();
	});

	it("prunes pool versions no live generation links once they are past the grace window", async () => {
		const f = await fixture();
		const pool = join(f.root, "pool");
		const pooled = new RuntimeArtifactStore(
			{
				root: f.origin,
				entries: ["src"],
				target: { executable: process.execPath, argsPrefix: [join(f.origin, "src", "cli.mjs")] },
			},
			f.artifacts,
			pool,
		);
		const old = await pooled.capture();
		await pooled.settle();
		const entries = async () =>
			(await Promise.all((await readdir(pool)).map((shard) => readdir(join(pool, shard))))).flat();
		const captured = (await lstat(join(old, "src", "cli.mjs"))).ino;
		let oldPath: string | undefined;
		for (const shard of await readdir(pool))
			for (const name of await readdir(join(pool, shard)))
				if ((await lstat(join(pool, shard, name))).ino === captured) oldPath = join(pool, shard, name);
		if (!oldPath) throw new Error("The captured version is not pooled.");
		const oldEntry = basename(oldPath);
		await pooled.retire(old);
		const past = new Date(Date.now() - 60 * 60_000);
		await utimes(oldPath, past, past);
		await writeFile(join(f.origin, "src", "cli.mjs"), "next version");
		const next = await pooled.capture();
		await pooled.settle();
		const remaining = await entries();
		expect(remaining).not.toContain(oldEntry);
		// The new cli.mjs version and the host executable (outside the origin, captured under .host).
		expect(remaining).toHaveLength(2);
		expect(await readFile(join(next, "src", "cli.mjs"), "utf8")).toBe("next version");
	});
});
