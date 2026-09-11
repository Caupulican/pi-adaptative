import {
	DEFAULT_CLOUD_STREAM_IDLE,
	DEFAULT_STREAM_IDLE,
	type StreamIdleOptions,
} from "@caupulican/pi-agent-core/reliability";
import type { Api, Model } from "@caupulican/pi-ai";
import { isLocalOrManagedRouterModel } from "./model-router/tool-escalation.ts";
import type { StreamStallModelClass, StreamStallSettings } from "./settings-manager.ts";

/** The settings surface the stall resolver needs; the session passes its SettingsManager. */
export interface StreamStallSettingsSource {
	getStreamStallSettings(modelClass: StreamStallModelClass): StreamStallSettings;
}

/**
 * Stall bounds for one model, resolved from the budget its class draws on.
 *
 * A CPU-served local model legitimately sits silent for minutes while it loads and prefills, so
 * its bounds are generous; a hosted stream silent that long is dead, and waiting out the local
 * bound burns the turn. One shared budget could only ever serve one of the two, so the class
 * picks both the configured budget (`retry.stall.local` / `retry.stall.cloud`, with the legacy
 * top-level keys standing in for `local`) and the defaults the unset fields fall back to.
 *
 * Unset fields are left at the class default rather than copied over as `undefined`: the HTTP
 * clamp downstream re-defaults any undefined bound to DEFAULT_STREAM_IDLE, which would silently
 * hand a cloud stream the local quiet bound.
 */
export function resolveStreamStallBudget(
	model: Model<Api>,
	settings: StreamStallSettingsSource,
): { modelClass: StreamStallModelClass; base: StreamIdleOptions } {
	const modelClass: StreamStallModelClass = isLocalOrManagedRouterModel(model) ? "local" : "cloud";
	const configured = settings.getStreamStallSettings(modelClass);
	const base: StreamIdleOptions = { ...(modelClass === "local" ? DEFAULT_STREAM_IDLE : DEFAULT_CLOUD_STREAM_IDLE) };
	if (configured.connectMs !== undefined) base.connectMs = configured.connectMs;
	if (configured.activeIdleMs !== undefined) base.activeIdleMs = configured.activeIdleMs;
	if (configured.quietIdleMs !== undefined) base.quietIdleMs = configured.quietIdleMs;
	return { modelClass, base };
}
