import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETAINED_CERTIFICATES, SteeringCertificateStore } from "../src/core/steering/certificate-store.ts";
import type { SteeringCertificate } from "../src/core/steering/types.ts";

function certificate(index: number): SteeringCertificate {
	return {
		certificate_id: `cert-${index}`,
		objective_id: `obj-${Math.floor(index / 10)}`,
		checkpoint_id: "JEV-001",
		state_digest: `digest-${index}`,
		evidence_revision: 1,
		answers: { objective_coherent: true },
		directive: "pass",
		policy: { digest: "policy" },
		question_pack: { id: "pack" },
		engine: { id: "engine", model: "jev" },
	} as unknown as SteeringCertificate;
}

describe("steering certificate store bound", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the newest certificates only, in memory and on disk, and a reload obeys the same bound", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cert-bound-"));
		dirs.push(dir);
		const path = join(dir, "certificates.json");
		const store = new SteeringCertificateStore(path);
		for (let index = 0; index < MAX_RETAINED_CERTIFICATES + 3; index++) await store.persist(certificate(index));
		expect(store.get("cert-0")).toBeUndefined();
		expect(store.get("cert-2")).toBeUndefined();
		expect(store.get("cert-3")).toBeDefined();
		expect(store.get(`cert-${MAX_RETAINED_CERTIFICATES + 2}`)).toBeDefined();
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as { certificate_id: string }[];
		expect(onDisk).toHaveLength(MAX_RETAINED_CERTIFICATES);
		expect(onDisk[0]?.certificate_id).toBe("cert-3");
		// A re-persisted certificate keeps its position: it is not made "newest" again.
		await store.persist(certificate(3));
		await store.persist(certificate(MAX_RETAINED_CERTIFICATES + 3));
		expect(store.get("cert-3")).toBeUndefined();
		expect(store.get("cert-4")).toBeDefined();
		const reloaded = new SteeringCertificateStore(path);
		expect(reloaded.get("cert-4")).toBeDefined();
		expect(reloaded.get(`cert-${MAX_RETAINED_CERTIFICATES + 3}`)).toBeDefined();
	});
});
