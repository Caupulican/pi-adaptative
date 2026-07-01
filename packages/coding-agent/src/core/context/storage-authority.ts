/**
 * Storage authority/rebuildability metadata for future SQLite table design (Phase M0/M3).
 *
 * No SQLite implementation exists yet. This module only records, per prospective table,
 * whether its rows are the only copy of something (canonical_local_state), rebuildable
 * from another canonical source (derived_rebuildable), disposable performance data
 * (runtime_cache_disposable), or audit/calibration telemetry whose loss does not affect
 * current task truth (append_only_telemetry). Per memory-architecture.md: cleanup and
 * prompt safety must never depend only on disposable/derived rows.
 */

export type StorageAuthorityClass =
	| "derived_rebuildable"
	| "runtime_cache_disposable"
	| "append_only_telemetry"
	| "canonical_local_state";

export interface StorageTableAuthority {
	table: string;
	authorityClass: StorageAuthorityClass;
	/** Canonical sources this table can be rebuilt from, if authorityClass is derived_rebuildable. */
	rebuildableFrom?: string[];
	notes: string;
}

export const CONTEXT_STORAGE_TABLE_AUTHORITY: readonly StorageTableAuthority[] = [
	{
		table: "context_items",
		authorityClass: "derived_rebuildable",
		rebuildableFrom: ["transcript", "artifacts"],
		notes: "Working-memory context item metadata; rebuildable from transcript/artifacts if the index is lost.",
	},
	{
		table: "artifact_metadata",
		authorityClass: "canonical_local_state",
		notes:
			"Artifact id/path/byte-length/reproducibility metadata. The artifact payload file is canonical raw " +
			"evidence, but this row is the only index to it; loss here can strand a payload as unreachable, so " +
			"treat as canonical_local_state and mirror writes into a durable journal before treating a ref as live.",
	},
	{
		table: "policy_score_cache",
		authorityClass: "runtime_cache_disposable",
		notes:
			"Cached break-even score computations for context-retention candidates; safe to drop and " +
			"recompute on demand, and never consulted for a safety/retention decision by itself.",
	},
	{
		table: "policy_decisions",
		authorityClass: "append_only_telemetry",
		notes: "Policy decision shadow/enforcement log for calibration and review; loss affects calibration, not current task truth.",
	},
	{
		table: "retrieval_records",
		authorityClass: "append_only_telemetry",
		notes: "Retrieval/rehydration audit trail; loss affects observability, not current task truth.",
	},
	{
		table: "memory_index",
		authorityClass: "derived_rebuildable",
		rebuildableFrom: ["okf_bundle", "external_provider"],
		notes:
			"Index over durable memory sources; rebuildable by re-indexing the OKF bundle/provider content. " +
			"Rebuild from an external_provider source is conditional on that provider being enabled, reachable, " +
			"and permitted by egress/redaction policy at rebuild time; it is not unconditionally rebuildable " +
			"the way the OKF-bundle-backed portion is.",
	},
];
