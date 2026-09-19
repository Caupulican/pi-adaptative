/**
 * Unified Capability Catalog.
 * Registry of tools, scripts, skills, extensions, integrations, and runtime patches.
 * Implements S1A-060, S1A-061, S1A-145.
 */

import type { CapabilityKind, CapabilityLifetime, CapabilityRecord, CapabilitySpec } from "./types.ts";

export interface CapabilityCatalogEntry {
	readonly capabilityId: string;
	readonly kind: CapabilityKind;
	readonly purpose: string;
	readonly inputShape: readonly string[];
	readonly outputShape: readonly string[];
	readonly sideEffects: readonly string[];
	readonly lifetime: CapabilityLifetime;
	readonly spec?: CapabilitySpec;
	readonly record?: CapabilityRecord;
}

export class CapabilityCatalog {
	private readonly entries = new Map<string, CapabilityCatalogEntry>();
	private catalogRevision = 1;

	constructor() {
		this.seedStandardCapabilities();
	}

	private seedStandardCapabilities(): void {
		const standards: CapabilityCatalogEntry[] = [
			{
				capabilityId: "bash_exec",
				kind: "tool",
				purpose: "Execute safe shell commands within workspace boundaries",
				inputShape: ["command: string", "cwd?: string"],
				outputShape: ["stdout: string", "exitCode: number"],
				sideEffects: ["filesystem_read_write", "process_execution"],
				lifetime: "global",
			},
			{
				capabilityId: "file_read",
				kind: "tool",
				purpose: "Read file contents from local filesystem",
				inputShape: ["path: string"],
				outputShape: ["content: string"],
				sideEffects: ["read_only"],
				lifetime: "global",
			},
			{
				capabilityId: "file_write",
				kind: "tool",
				purpose: "Create or edit files on local filesystem",
				inputShape: ["path: string", "content: string"],
				outputShape: ["success: boolean"],
				sideEffects: ["filesystem_write"],
				lifetime: "global",
			},
			{
				capabilityId: "vitest_runner",
				kind: "toolkit_script",
				purpose: "Run targeted unit and regression tests with vitest",
				inputShape: ["testPath: string"],
				outputShape: ["pass: boolean", "testResults: object"],
				sideEffects: ["test_execution"],
				lifetime: "global",
			},
			{
				capabilityId: "jscpd_clone_scanner",
				kind: "tool",
				purpose: "Scan repository for textual clone duplication",
				inputShape: ["threshold?: number"],
				outputShape: ["clones: array"],
				sideEffects: ["read_only"],
				lifetime: "global",
			},
		];

		for (const entry of standards) {
			this.entries.set(entry.capabilityId, entry);
		}
	}

	revision(): number {
		return this.catalogRevision;
	}

	listAll(): readonly CapabilityCatalogEntry[] {
		return Array.from(this.entries.values());
	}

	get(capabilityId: string): CapabilityCatalogEntry | undefined {
		return this.entries.get(capabilityId);
	}

	registerCapability(spec: CapabilitySpec, record?: CapabilityRecord): void {
		const entry: CapabilityCatalogEntry = {
			capabilityId: spec.capability_id,
			kind: spec.kind,
			purpose: spec.purpose,
			inputShape: Object.keys(spec.interface.inputs ?? {}),
			outputShape: Object.keys(spec.interface.outputs ?? {}),
			sideEffects: [...spec.side_effects],
			lifetime: spec.lifetime,
			spec,
			record,
		};
		this.entries.set(spec.capability_id, entry);
		this.catalogRevision += 1;
	}

	/**
	 * Returns compact summary for wide ranking pass.
	 * S1A-061: Wide compact roster.
	 */
	compactRoster(): readonly Record<string, unknown>[] {
		return this.listAll().map((entry) => ({
			id: entry.capabilityId,
			kind: entry.kind,
			purpose: entry.purpose,
			inputShape: entry.inputShape,
			outputShape: entry.outputShape,
			sideEffects: entry.sideEffects,
		}));
	}
}
