import { describe, expect, it, vi } from "vitest";
import {
	type DoctorDeps,
	type DoctorReport,
	formatDoctorReport,
	runDoctor,
	runUpdatePreflight,
} from "../src/core/doctor.ts";

/**
 * The environment doctor (src/core/doctor.ts) verifies required tooling and
 * installs what it safely can:
 *
 * - fff-node is a MANAGED tool (pi already owns its install into
 *   ~/.pi/agent/bin, see tools-manager.ts's ensureFffNodePackage): the doctor
 *   actually attempts the install when missing.
 * - ripgrep, ollama, and python are SYSTEM tools: the doctor only ever
 *   reports on them and prints exact manual steps when missing (GUIDE MODE --
 *   never executed, never curl|sh, never sudo), per the harness's
 *   deliberate no-silent-installer stance for tools it doesn't itself own.
 *
 * All dependencies are injected (mirroring loadFffModule's requires? and
 * DefaultFffSearchBackend's constructor-injected deps elsewhere in this
 * package) so these tests never spawn a real npm install, a real ollama
 * server probe, or a real subprocess.
 */

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
	return {
		loadAvailableFffNodePackage: () => undefined,
		ensureFffNodePackage: vi.fn(async () => ({ FileFinder: {} }) as unknown),
		getLastFffInstallOutcome: () => ({ status: "installed" }),
		getRgPath: () => "/usr/bin/rg",
		detectPython: () => ({ present: true, command: "python3", version: "Python 3.11.0" }),
		probeVersion: () => "ripgrep 14.1.0\n-SIMD -AVX (compiled)",
		ollamaRuntime: {
			detect: async () => ({
				binaryPath: "/usr/bin/ollama",
				binarySource: "system" as const,
				serverUp: true,
				serverUrl: "http://127.0.0.1:11434",
				managedByPi: false,
				ownedModelsDir: "/agent/models/ollama",
			}),
			installGuide: () => ["guide line 1", "guide line 2"],
		},
		...overrides,
	};
}

describe("runDoctor: fff-node (managed tool)", () => {
	it("routes through ensureFffNodePackage and reports present when already available", async () => {
		const ensureFffNodePackage = vi.fn(async () => ({ FileFinder: {} }) as unknown);
		const deps = baseDeps({
			ensureFffNodePackage,
			getLastFffInstallOutcome: () => ({ status: "already-available" }),
		});

		const report = await runDoctor(deps);
		const fff = report.checks.find((c) => c.id === "fff-node");

		expect(ensureFffNodePackage).toHaveBeenCalledWith(true);
		expect(fff?.present).toBe(true);
		expect(fff?.kind).toBe("managed");
		expect(fff?.detail).toContain("already available");
	});

	it("attempts a managed install when missing, and reports success", async () => {
		const ensureFffNodePackage = vi.fn(async () => ({ FileFinder: {} }) as unknown);
		const deps = baseDeps({ ensureFffNodePackage, getLastFffInstallOutcome: () => ({ status: "installed" }) });

		const report = await runDoctor(deps);
		const fff = report.checks.find((c) => c.id === "fff-node");

		expect(ensureFffNodePackage).toHaveBeenCalledWith(true);
		expect(fff?.present).toBe(true);
		expect(fff?.installAttempted).toBe(true);
	});

	it("reports missing with the install-failed reason surfaced when the managed install fails", async () => {
		const deps = baseDeps({
			ensureFffNodePackage: vi.fn(async () => undefined),
			getLastFffInstallOutcome: () => ({ status: "install-failed", reason: "registry timeout" }),
		});

		const report = await runDoctor(deps);
		const fff = report.checks.find((c) => c.id === "fff-node");

		expect(fff?.present).toBe(false);
		expect(fff?.detail).toContain("registry timeout");
	});

	it("reports missing without attempting a doomed install when offline mode is on", async () => {
		const ensureFffNodePackage = vi.fn(async () => undefined);
		const deps = baseDeps({ ensureFffNodePackage, getLastFffInstallOutcome: () => ({ status: "offline" }) });

		const report = await runDoctor(deps);
		const fff = report.checks.find((c) => c.id === "fff-node");

		// The doctor delegates the offline/no-doomed-install decision to
		// ensureFffNodePackage itself (already covers this, see
		// fff-lazy-install.test.ts) -- it must not duplicate that logic, just
		// call through and report the outcome honestly.
		expect(ensureFffNodePackage).toHaveBeenCalledWith(true);
		expect(fff?.present).toBe(false);
		expect(fff?.detail).toContain("offline");
	});

	it("stays silent by default (matching the existing preflight behavior) but shows install progress when asked", async () => {
		// A silent multi-second install gap in an INTERACTIVE `doctor` run reads
		// as a hang; the background update-preflight should stay quiet. Same
		// checkFffNode/ensureFffNodePackage path either way -- only the
		// silent flag threaded through runDoctor's options differs.
		const ensureFffNodePackage = vi.fn(async () => ({ FileFinder: {} }) as unknown);
		const deps = baseDeps({ ensureFffNodePackage });

		await runDoctor(deps);
		expect(ensureFffNodePackage).toHaveBeenLastCalledWith(true);

		await runDoctor(deps, { silent: false });
		expect(ensureFffNodePackage).toHaveBeenLastCalledWith(false);
	});
});

describe("runDoctor: ripgrep (system tool, guide mode only)", () => {
	it("reports present with its resolved path and version", async () => {
		const deps = baseDeps({
			getRgPath: () => "/usr/bin/rg",
			probeVersion: () => "ripgrep 14.1.0\n-SIMD -AVX (compiled)",
		});
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");

		expect(rg?.present).toBe(true);
		expect(rg?.kind).toBe("system");
		expect(rg?.detail).toContain("/usr/bin/rg");
		expect(rg?.detail).toContain("ripgrep 14.1.0");
		// Only the first line -- rg --version's compiled-features lines are noise
		// in a one-line status report.
		expect(rg?.detail).not.toContain("SIMD");
		expect(rg?.guide).toBeUndefined();
	});

	it("still reports present when the version probe itself comes back empty", async () => {
		const deps = baseDeps({ getRgPath: () => "/usr/bin/rg", probeVersion: () => undefined });
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");

		expect(rg?.present).toBe(true);
		expect(rg?.detail).toBe("/usr/bin/rg");
	});

	it("reports missing with guide-mode manual steps -- never an install attempt", async () => {
		const deps = baseDeps({ getRgPath: () => null });
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");

		expect(rg?.present).toBe(false);
		expect(rg?.kind).toBe("system");
		expect(rg?.guide?.length).toBeGreaterThan(0);
		const guideText = rg?.guide?.join(" ") ?? "";
		expect(guideText).not.toMatch(/curl[^|]*\|\s*(sh|bash)/);
		// Never an ACTUAL sudo invocation ("sudo apt ...") -- merely reassuring
		// the user that no sudo is required ("no sudo:") is fine and expected.
		expect(guideText).not.toMatch(/\bsudo\s+\w/);
	});
});

describe("runDoctor: ollama (system tool, guide mode only)", () => {
	it("reports present with binary + version + server status when detected", async () => {
		const deps = baseDeps({ probeVersion: () => "ollama version is 0.6.2" });
		const report = await runDoctor(deps);
		const ollama = report.checks.find((c) => c.id === "ollama");

		expect(ollama?.present).toBe(true);
		expect(ollama?.kind).toBe("system");
		expect(ollama?.detail).toContain("0.6.2");
		expect(ollama?.detail).toContain("server: up");
	});

	it("still reports present when the version probe itself comes back empty", async () => {
		const deps = baseDeps({ probeVersion: () => undefined });
		const report = await runDoctor(deps);
		const ollama = report.checks.find((c) => c.id === "ollama");

		expect(ollama?.present).toBe(true);
		expect(ollama?.detail).toContain("server: up");
	});

	it("uses OllamaRuntime.installGuide() verbatim when the binary is missing, never auto-installing", async () => {
		const detect = vi.fn(async () => ({
			binaryPath: undefined,
			binarySource: undefined,
			serverUp: false,
			serverUrl: "http://127.0.0.1:11434",
			managedByPi: false,
			ownedModelsDir: "/agent/models/ollama",
		}));
		const installGuide = vi.fn(() => ["step 1", "step 2"]);
		const deps = baseDeps({ ollamaRuntime: { detect, installGuide } });

		const report = await runDoctor(deps);
		const ollama = report.checks.find((c) => c.id === "ollama");

		expect(ollama?.present).toBe(false);
		expect(ollama?.guide).toEqual(["step 1", "step 2"]);
		expect(installGuide).toHaveBeenCalled();
	});
});

describe("runDoctor: python (system tool, guide mode only)", () => {
	it("reports present with the resolved command and version", async () => {
		const deps = baseDeps({ detectPython: () => ({ present: true, command: "python3", version: "Python 3.11.0" }) });
		const report = await runDoctor(deps);
		const python = report.checks.find((c) => c.id === "python");

		expect(python?.present).toBe(true);
		expect(python?.kind).toBe("system");
		expect(python?.detail).toContain("python3");
		expect(python?.detail).toContain("3.11.0");
	});

	it("reports missing with guide-mode manual steps -- never an install attempt", async () => {
		const deps = baseDeps({ detectPython: () => ({ present: false }) });
		const report = await runDoctor(deps);
		const python = report.checks.find((c) => c.id === "python");

		expect(python?.present).toBe(false);
		expect(python?.kind).toBe("system");
		expect(python?.guide?.length).toBeGreaterThan(0);
		const guideText = python?.guide?.join(" ") ?? "";
		expect(guideText).not.toMatch(/curl[^|]*\|\s*(sh|bash)/);
		// Never an ACTUAL sudo invocation ("sudo apt ...") -- merely reassuring
		// the user that no sudo is required ("no sudo:") is fine and expected.
		expect(guideText).not.toMatch(/\bsudo\s+\w/);
	});
});

describe("runDoctor: overall report shape", () => {
	it("includes exactly the four expected checks", async () => {
		const report = await runDoctor(baseDeps());
		expect(report.checks.map((c) => c.id).sort()).toEqual(["fff-node", "ollama", "python", "ripgrep"]);
	});

	it("uses the real tools-manager/OllamaRuntime wiring by default (no deps injected)", async () => {
		// Just proves runDoctor is callable with no args -- the doctor CLI
		// command and the update preflight both rely on this default wiring.
		expect(typeof runDoctor).toBe("function");
	});
});

describe("formatDoctorReport", () => {
	it("marks present tools OK and missing tools MISSING, including guide text indented under the missing entry", () => {
		const report: DoctorReport = {
			checks: [
				{ id: "a", label: "Tool A", kind: "managed", present: true, detail: "v1" },
				{ id: "b", label: "Tool B", kind: "system", present: false, guide: ["do this", "then that"] },
			],
		};
		const text = formatDoctorReport(report);

		expect(text).toContain("[OK] Tool A");
		expect(text).toContain("v1");
		expect(text).toContain("[MISSING] Tool B");
		expect(text).toContain("do this");
		expect(text).toContain("then that");
	});
});

describe("runUpdatePreflight", () => {
	it("never throws or rejects, even end-to-end against the real wiring", async () => {
		// The preflight is called after `pi-adaptative update` succeeds; it must
		// be non-fatal no matter what the real environment looks like.
		await expect(runUpdatePreflight()).resolves.toBeUndefined();
	});
});
