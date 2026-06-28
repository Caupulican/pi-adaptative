import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogManager, hashPath } from "../src/core/catalog-manager.ts";

describe("CatalogManager (round resource management)", () => {
	let tempDir: string;
	let agentDir: string;
	let catalogDir: string;

	const writeSkill = (root: string, name: string, body: string) => {
		const dir = join(root, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		catalogDir = join(tempDir, "catalog");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(catalogDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists catalog resources and reports not-installed", () => {
		writeSkill(catalogDir, "alpha", "---\nname: alpha\n---\nAlpha body");
		const mgr = new CatalogManager(agentDir, catalogDir);
		const entries = mgr.list();
		expect(entries.map((e) => `${e.kind}/${e.name}`)).toEqual(["skills/alpha"]);
		expect(mgr.status(entries[0])).toBe("not-installed");
	});

	it("installs a resource into the user level (copy)", () => {
		writeSkill(catalogDir, "alpha", "---\nname: alpha\n---\nAlpha body");
		const mgr = new CatalogManager(agentDir, catalogDir);
		const entry = mgr.list()[0];
		mgr.install(entry);
		expect(existsSync(join(agentDir, "skills", "alpha", "SKILL.md"))).toBe(true);
		expect(mgr.status(entry)).toBe("up-to-date");
	});

	it("detects an outdated install by content hash and update() re-syncs it", () => {
		writeSkill(catalogDir, "alpha", "---\nname: alpha\n---\nv1");
		const mgr = new CatalogManager(agentDir, catalogDir);
		mgr.install(mgr.list()[0]);
		expect(mgr.status(mgr.list()[0])).toBe("up-to-date");

		// Catalog updated (e.g. user pulled their repo) → installed copy is now outdated.
		writeSkill(catalogDir, "alpha", "---\nname: alpha\n---\nv2 improved");
		expect(mgr.status(mgr.list()[0])).toBe("outdated");

		const updated = mgr.update();
		expect(updated.map((e) => e.name)).toEqual(["alpha"]);
		expect(readFileSync(join(agentDir, "skills", "alpha", "SKILL.md"), "utf-8")).toContain("v2 improved");
		expect(mgr.status(mgr.list()[0])).toBe("up-to-date");
	});

	it("update() never installs resources the user has not chosen on this machine", () => {
		writeSkill(catalogDir, "alpha", "a");
		writeSkill(catalogDir, "beta", "b");
		const mgr = new CatalogManager(agentDir, catalogDir);
		mgr.install(mgr.list().find((e) => e.name === "alpha")!); // only alpha installed

		mgr.update();
		expect(existsSync(join(agentDir, "skills", "alpha"))).toBe(true);
		expect(existsSync(join(agentDir, "skills", "beta"))).toBe(false); // not auto-installed
	});

	it("backs a user-level resource up into the catalog", () => {
		writeSkill(agentDir, "local-only", "---\nname: local-only\n---\nauthored locally");
		const mgr = new CatalogManager(agentDir, catalogDir);
		mgr.backup({
			kind: "skills",
			name: "local-only",
			catalogPath: join(catalogDir, "skills", "local-only"),
			installPath: join(agentDir, "skills", "local-only"),
		});
		expect(readFileSync(join(catalogDir, "skills", "local-only", "SKILL.md"), "utf-8")).toContain("authored locally");
	});

	it("hashPath does not crash on a circular symlink (Bug #19)", async () => {
		const { symlinkSync } = await import("node:fs");
		const dir = join(catalogDir, "skills", "looped");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "content", "utf-8");
		try {
			symlinkSync(dir, join(dir, "self")); // circular: dir/self -> dir
		} catch {
			return; // symlinks unavailable on this platform → skip
		}
		// Must terminate (cycle guard), not RangeError: Maximum call stack size exceeded.
		expect(() => hashPath(dir)).not.toThrow();
		expect(typeof hashPath(dir)).toBe("string");
	});

	it("hashPath is content-based and order-stable", () => {
		writeSkill(catalogDir, "x", "same");
		writeSkill(agentDir, "x", "same");
		expect(hashPath(join(catalogDir, "skills", "x"))).toBe(hashPath(join(agentDir, "skills", "x")));
	});
});
