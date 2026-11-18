import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	createFileArtifactStore,
	createInMemoryArtifactStore,
	createLineageArtifactStore,
	readArtifactRefs,
} from "../src/core/context/context-artifacts.ts";

const write = { kind: "tool_output", content: "captured", createdAtTurn: 1, reproducible: true } as const;

it("observes metadata and payload changes on every file batch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ref-batch-"));
	try {
		const baseDir = join(dir, "artifacts");
		const store = createFileArtifactStore({ baseDir });
		expect(readArtifactRefs(store, new Set(["abc"])).size).toBe(0);
		expect(existsSync(baseDir)).toBe(false);
		const { ref } = store.write(write);
		const ids = new Set([ref.id]);
		const meta = join(baseDir, `${ref.id}.meta.json`);
		const payload = join(baseDir, `${ref.id}.payload`);
		const original = readFileSync(meta, "utf8");
		const first = readArtifactRefs(store, ids);
		writeFileSync(meta, "{");
		expect(readArtifactRefs(store, ids).size).toBe(0);
		writeFileSync(meta, JSON.stringify({ ref: { ...ref, id: "different" }, references: [] }));
		expect(store.readRef(ref.id)).toBeUndefined();
		expect(store.has(ref.id)).toBe(false);
		expect(readArtifactRefs(store, ids).size).toBe(0);
		writeFileSync(meta, original);
		unlinkSync(payload);
		expect(readArtifactRefs(store, ids).size).toBe(0);
		store.write(write);
		expect(readArtifactRefs(store, ids).get(ref.id)).toEqual(ref);
		expect(first.get(ref.id)).toEqual(ref);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("looks up only genuine local misses in the parent and stops at an incomplete nearer copy", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-lineage-refs-"));
	try {
		const own = createFileArtifactStore({ baseDir: dir });
		const parent = createInMemoryArtifactStore();
		const local = own.write(write).ref;
		const inherited = parent.write({ ...write, content: "inherited" }).ref;
		parent.write(write);
		const parentRead = vi.fn((id: string) => parent.readRef(id));
		const resolveAncestors = vi.fn(() => [{ ...parent, readRef: parentRead, visitRefs: undefined }]);
		const lineage = createLineageArtifactStore(own, resolveAncestors);
		expect(readArtifactRefs(lineage, new Set([local.id])).get(local.id)).toEqual(local);
		expect(resolveAncestors).not.toHaveBeenCalled();
		unlinkSync(join(dir, `${local.id}.payload`));
		const found = readArtifactRefs(lineage, new Set([local.id, inherited.id]));
		expect([...found.keys()]).toEqual([inherited.id]);
		expect(parentRead.mock.calls).toEqual([[inherited.id]]);
		expect(lineage.readRef(local.id)).toBeUndefined();
		expect(lineage.has(local.id)).toBe(false);
		expect(lineage.has(inherited.id)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("uses the public adapter of a wrapped store and ignores unrequested metadata", () => {
	const backing = createInMemoryArtifactStore();
	const known = backing.write(write).ref;
	const other = backing.write({ ...write, content: "other" }).ref;
	const wrapped = {
		...createLineageArtifactStore(backing, () => []),
		visitRefs: vi.fn((_ids: ReadonlySet<string>, visit: (id: string, ref: typeof known | undefined) => void) => {
			visit(other.id, other);
			visit(known.id, { ...known, toolName: "adapter" });
		}),
	};
	const result = readArtifactRefs(wrapped, new Set([known.id]));
	expect([...result.keys()]).toEqual([known.id]);
	expect(result.get(known.id)?.toolName).toBe("adapter");
	expect(wrapped.visitRefs).toHaveBeenCalledOnce();
});
