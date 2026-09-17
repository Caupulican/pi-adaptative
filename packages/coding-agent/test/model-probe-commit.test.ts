import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ModelAdaptationStore,
	type ModelProtocolCalibration,
	type ModelToolProbe,
} from "../src/core/models/adaptation-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const dirs: string[] = [];
const key = "fixture/model";
const at = "2026-09-17T00:00:00.000Z";
const probe: ModelToolProbe = { version: 1, status: "text-protocol", variant: "tool-tag", probedAt: at };
const calibration: ModelProtocolCalibration = {
	version: 1,
	status: "calibrated",
	variant: "tool-tag",
	calibratedAt: at,
};
const fingerprint = () => ({ id: "fixture", cpu: "fixture", cores: 1, totalMemGb: 1 });

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-probe-commit-"));
	dirs.push(dir);
	const path = join(dir, "adaptation.json");
	const store = new ModelAdaptationStore(path, { fingerprint, readOnly: false });
	store.setToolProbe(key, { version: 1, status: "native", probedAt: at });
	const read = () => new ModelAdaptationStore(path, { fingerprint, readOnly: true }).get(key);
	return { path, store, read };
}

describe("graded probe commit", () => {
	it("exposes the previous pair before rename and the complete new pair after one rename", () => {
		const { store, read } = fixture();
		const before = read();
		const rename = nodeFs.renameSync;
		const observed: unknown[] = [];
		const writes = vi.spyOn(nodeFs, "renameSync").mockImplementation((from, to) => {
			observed.push(read());
			rename(from, to);
			observed.push(read());
		});
		store.setToolProbe(key, probe, at, calibration);
		expect(writes).toHaveBeenCalledTimes(1);
		expect(observed).toEqual([before, { ...before, toolProbe: probe, protocol: calibration }]);
	});

	it("retains the previous pair when rename fails before commit", () => {
		const { store, read } = fixture();
		const before = read();
		vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
			throw new Error("fixture disk error");
		});
		expect(() => store.setToolProbe(key, probe, at, calibration)).toThrow("fixture disk error");
		expect(read()).toEqual(before);
		expect(store.get(key)).toEqual(before);
	});

	it("keeps read-only stores from persisting either field", () => {
		const { path, read } = fixture();
		const before = read();
		const reader = new ModelAdaptationStore(path, { fingerprint, readOnly: true });
		reader.setToolProbe(key, probe, at, calibration);
		expect(read()).toEqual(before);
	});
});
