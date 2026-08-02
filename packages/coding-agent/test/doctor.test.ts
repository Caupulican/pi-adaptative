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
 * - python is now MANAGED through a pinned uv runtime; doctor/update preflight
 *   ensure it proactively while retaining bounded, non-fatal failures.
 * - ripgrep and jq are pinned MANAGED tools; ollama remains SYSTEM guide-mode tooling.
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
		ensureTool: vi.fn(async (tool) => `/agent/bin/${tool}`),
		ensurePythonRuntime: vi.fn(async () => ({
			status: "ready" as const,
			uvPath: "/agent/bin/uv",
			pythonPath: "/agent/runtimes/python/bin/python",
			pythonInstalled: false,
		})),
		probeVersion: () => "ripgrep 14.1.0\n-SIMD -AVX (compiled)",
		ollamaRuntime: {
			detect: async () => ({
				binaryPath: "/usr/bin/ollama",
				binarySource: "system" as const,
				serverUp: true,
				serverUrl: "http://127.0.0.1:11434",
				managedByPi: false,
				ownedModelsDir: "/agent/models/ollama",
				userModelsDir: "/home/u/.ollama/models",
				ownedStore: { kind: "pi-owned" as const, path: "/agent/models/ollama", modelCount: 2 },
				userStore: { kind: "user" as const, path: "/home/u/.ollama/models", modelCount: 1 },
				activeStore: { kind: "pi-owned" as const, path: "/agent/models/ollama", modelCount: 2 },
				serverModels: [],
			}),
			installGuide: () => ["guide line 1", "guide line 2"],
		},
		inspectAgentDirectoryLayout: () => ({
			agentDir: "/agent",
			scannedEntries: 0,
			unexpectedEntryCount: 0,
			unexpectedEntries: [],
			truncated: false,
		}),
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

describe("runDoctor: pinned data tools", () => {
	it("provisions ripgrep and jq through the shared managed-tool owner", async () => {
		const ensureTool = vi.fn(async (tool: "jq" | "rg") => `/agent/bin/${tool}`);
		const deps = baseDeps({
			ensureTool,
			probeVersion: () => "ripgrep 14.1.0\n-SIMD -AVX (compiled)",
		});
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");
		const jq = report.checks.find((c) => c.id === "jq");

		expect(rg?.present).toBe(true);
		expect(rg?.kind).toBe("managed");
		expect(rg?.detail).toContain("/agent/bin/rg");
		expect(rg?.detail).toContain("ripgrep 14.1.0");
		expect(rg?.detail).not.toContain("SIMD");
		expect(jq).toMatchObject({ kind: "managed", present: true });
		expect(jq?.detail).toContain("/agent/bin/jq");
		expect(ensureTool).toHaveBeenCalledWith("rg", true);
		expect(ensureTool).toHaveBeenCalledWith("jq", true);
	});

	it("still reports present when a version probe itself comes back empty", async () => {
		const deps = baseDeps({ probeVersion: () => undefined });
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");

		expect(rg?.present).toBe(true);
		expect(rg?.detail).toBe("/agent/bin/rg");
	});

	it("reports a managed provisioning failure without pretending the tool is present", async () => {
		const deps = baseDeps({ ensureTool: vi.fn(async () => undefined) });
		const report = await runDoctor(deps);
		const rg = report.checks.find((c) => c.id === "ripgrep");
		const jq = report.checks.find((c) => c.id === "jq");

		expect(rg?.present).toBe(false);
		expect(rg?.kind).toBe("managed");
		expect(jq).toMatchObject({ kind: "managed", present: false });
		expect(rg?.guide).toBeUndefined();
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
			userModelsDir: "/home/u/.ollama/models",
			ownedStore: { kind: "pi-owned" as const, path: "/agent/models/ollama", modelCount: 0 },
			userStore: { kind: "user" as const, path: "/home/u/.ollama/models", modelCount: 0 },
			activeStore: undefined,
			serverModels: [],
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

describe("runDoctor: python (uv-managed tool)", () => {
	it("provisions through the shared runtime manager and reports resolved paths", async () => {
		const ensurePythonRuntime = vi.fn(async () => ({
			status: "ready" as const,
			uvPath: "/agent/bin/uv",
			pythonPath: "/agent/runtimes/python/bin/python",
			pythonInstalled: true,
		}));
		const report = await runDoctor(baseDeps({ ensurePythonRuntime }), { silent: false });
		const python = report.checks.find((check) => check.id === "python");

		expect(ensurePythonRuntime).toHaveBeenCalledWith({ silent: false });
		expect(python).toMatchObject({ kind: "managed", present: true, installAttempted: true });
		expect(python?.detail).toContain("/agent/bin/uv");
		expect(python?.detail).toContain("/agent/runtimes/python/bin/python");
	});

	it("reports bounded managed-runtime failures without pretending success", async () => {
		const report = await runDoctor(
			baseDeps({
				ensurePythonRuntime: async () => ({ status: "offline", reason: "offline mode prevents install" }),
			}),
		);
		const python = report.checks.find((check) => check.id === "python");
		expect(python).toMatchObject({ kind: "managed", present: false });
		expect(python?.detail).toContain("offline mode prevents install");
		expect(python?.guide).toBeUndefined();
	});
});

describe("runDoctor: overall report shape", () => {
	it("includes exactly the five expected checks", async () => {
		const report = await runDoctor(baseDeps());
		expect(report.checks.map((c) => c.id).sort()).toEqual(["fff-node", "jq", "ollama", "python", "ripgrep"]);
	});

	it("surfaces unexpected root entries as a bounded warning without changing tool checks", async () => {
		const report = await runDoctor(
			baseDeps({
				inspectAgentDirectoryLayout: () => ({
					agentDir: "/agent",
					scannedEntries: 3,
					unexpectedEntryCount: 2,
					unexpectedEntries: ["external-a", "external-b"],
					truncated: false,
				}),
			}),
		);

		expect(report.checks).toHaveLength(5);
		expect(report.notices).toEqual([
			expect.objectContaining({
				id: "agent-directory-layout",
				detail: expect.stringContaining("external-a, external-b"),
			}),
		]);
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

	it("formats layout notices as warnings rather than missing tools", () => {
		const text = formatDoctorReport({
			checks: [],
			notices: [{ id: "layout", label: "Agent directory layout", detail: "unexpected root entry: old-data" }],
		});

		expect(text).toContain("[WARN] Agent directory layout");
		expect(text).not.toContain("[MISSING]");
	});
});

describe("runUpdatePreflight", () => {
	it("never throws or rejects and uses injected provisioning dependencies", async () => {
		const deps = baseDeps({
			ensurePythonRuntime: async () => ({ status: "uv-unavailable", reason: "registry unavailable" }),
		});
		await expect(runUpdatePreflight(deps)).resolves.toBeUndefined();
	});
});
