/**
 * Core lifecycle logic for pi-managed prism llama.cpp models (Bonsai-27B first), shared between the
 * `/models add` install pipeline (modes/interactive/local-model-commands.ts) and the router's
 * readiness gate (local-runtime-controller.ts). ONE place owns "ensure both GGUF files exist, then
 * serve" so a turn routed to a cold Bonsai-27B and a fresh `/models add` both go through the
 * identical self-healing path instead of two parallel, potentially-diverging implementations.
 *
 * Lives in core/models/ (not modes/) so the headless readiness gate — used by print/RPC/interactive
 * sessions and isolated/background lanes alike — never depends on the interactive-only UI layer;
 * mirrors the existing local-runtime.ts (mechanics) / local-runtime-controller.ts (gate) split.
 */

import { BONSAI_27B, type PrismLlamaCppRuntime, type PrismModelDescriptor } from "./llamacpp-runtime.ts";
import { PRISM_LLAMACPP_PROVIDER } from "./local-registration.ts";

/**
 * Curated prism llama.cpp descriptors, keyed by repo id — matches the modelId model-ref.ts's
 * curated `PRISM_LLAMACPP_MODEL_IDS` route returns, and the id `registerPrismLlamaCppModel` writes
 * as the model's id in models.json. Add future curated prism-ml models to both places together.
 *
 * Also the pi-managed-vs-user-owned discriminator (see {@link isPiManagedPrismLlamaCppModel}): a
 * `llama-cpp` provider model is gated/self-healed by pi ONLY when its id is a key here — a user's
 * own hand-configured entry (e.g. the built-in `llama-cpp/local` catalog model on port 8080,
 * pointing at a server the user runs themselves) is never touched.
 */
export const PRISM_LLAMACPP_DESCRIPTORS: Record<string, PrismModelDescriptor> = {
	[BONSAI_27B.repo]: BONSAI_27B,
};

/**
 * True only for a `llama-cpp` provider model pi itself registered (id present in
 * {@link PRISM_LLAMACPP_DESCRIPTORS}) — never true for a user's own hand-configured llama-cpp
 * model, including the built-in `llama-cpp/local` catalog entry. This is the gate that must run
 * before ANY self-heal/serve action so pi never touches a server it doesn't own.
 */
export function isPiManagedPrismLlamaCppModel(model: { provider: string; id: string }): boolean {
	return model.provider === PRISM_LLAMACPP_PROVIDER && Object.hasOwn(PRISM_LLAMACPP_DESCRIPTORS, model.id);
}

/**
 * Fixed local port for pi's own managed prism llama.cpp server. Deliberately NOT the generic
 * built-in `llama-cpp/local` catalog model's conventional port 8080 (models.generated.ts) — that
 * port is the convention for a user's OWN manually started llama-server pi merely points at; pi's
 * managed instance must never collide with it.
 */
export const PRISM_LLAMACPP_SERVE_PORT = 8090;

/**
 * Conservative RAM-only context cap for the pi-managed prism llama.cpp server, used at FIRST
 * install time only (`/models add`) — a later self-heal re-serve reuses the model's already
 * registered `contextWindow` instead (see the readiness gate in local-runtime-controller.ts), never
 * re-deriving from current RAM, so a served context size can't drift from what pi already told the
 * rest of the session (compaction, etc.) to expect. PrismLlamaCppRuntime has no `/api/show`-
 * equivalent GGUF metadata endpoint (unlike Ollama, which context-sizing.ts's
 * deriveLocalContextSizing depends on), so this is a coarse rung table mirroring
 * context-sizing.ts's CONTEXT_RUNGS, hard-capped at 32768 regardless of headroom: Bonsai-27B
 * advertises a 262K-class context, but that is not a realistic KV budget for a CPU-served model on
 * consumer hardware, and there is no larger validated rung to grow into yet.
 */
export function derivePrismLlamaCppNumCtx(totalMemBytes: number): number {
	const totalGb = totalMemBytes / 1e9;
	if (totalGb >= 64) return 32_768;
	if (totalGb >= 32) return 16_384;
	if (totalGb >= 16) return 8_192;
	return 4_096;
}

export type EnsurePrismModelServedResult =
	| { ok: true; baseUrl: string }
	| { ok: false; stage: "model-download" | "mmproj-download" | "serve"; error: string };

/**
 * The SOLE path allowed to call `runtime.serve()` for a prism llama.cpp model — no caller may spawn
 * llama-server without first passing through here (both `addPrismLlamaCppModel`'s install pipeline
 * and the readiness gate's self-heal path call this, never `runtime.serve()` directly).
 * Unconditionally re-verifies BOTH GGUF files via `runtime.downloadModel()` immediately before every
 * serve — that call is idempotent (skips a re-download when the local file already matches the
 * remote size, so the happy path costs one stat) and self-heals a file that went missing from disk
 * (deleted, a partial download from a prior crash, host cleanup, etc.) by re-fetching it instead of
 * ever starting llama-server without it. The vision projector is mandatory whenever the descriptor
 * declares one (Bonsai-27B always does — see BONSAI_27B.mmprojFile): a download failure on EITHER
 * file means llama-server is never spawned. There is no text-only fallback — Bonsai-27B never
 * silently degrades to a vision-less serve because the projector went missing.
 */
export async function ensurePrismModelFilesThenServe(
	runtime: PrismLlamaCppRuntime,
	descriptor: PrismModelDescriptor,
	args: { port: number; numCtx: number },
	onProgress: (message: string) => void,
): Promise<EnsurePrismModelServedResult> {
	const downloadedModel = await runtime.downloadModel({ repo: descriptor.repo, file: descriptor.file }, (progress) =>
		onProgress(`  ${descriptor.file}: ${progress}`),
	);
	if (!downloadedModel.ok || !downloadedModel.path) {
		return { ok: false, stage: "model-download", error: downloadedModel.error ?? "unknown error" };
	}

	let mmprojPath: string | undefined;
	if (descriptor.mmprojFile) {
		const downloadedMmproj = await runtime.downloadModel(
			{ repo: descriptor.repo, file: descriptor.mmprojFile },
			(progress) => onProgress(`  ${descriptor.mmprojFile}: ${progress}`),
		);
		if (!downloadedMmproj.ok || !downloadedMmproj.path) {
			return { ok: false, stage: "mmproj-download", error: downloadedMmproj.error ?? "unknown error" };
		}
		mmprojPath = downloadedMmproj.path;
	}

	onProgress(`Starting ${descriptor.displayName} on 127.0.0.1:${args.port} (context ${args.numCtx})…`);
	const served = await runtime.serve({
		modelPath: downloadedModel.path,
		mmprojPath,
		port: args.port,
		numCtx: args.numCtx,
	});
	if (!served.ok) return { ok: false, stage: "serve", error: served.error };
	return { ok: true, baseUrl: served.baseUrl };
}

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Direct HTTP reachability probe against a prism llama.cpp server root (NOT the `/v1` OpenAI-compat
 * suffix models.json registers — same root/health split as llama-server's own health endpoint used
 * internally by PrismLlamaCppRuntime#serve). PrismLlamaCppRuntime has no public method for this (its
 * own equivalent, `_healthUp`, is private and scoped to a `serve()` call in progress), so the
 * readiness gate needs its own — this is deliberately independent of any single runtime instance:
 * it answers "is a server already alive at this URL", true even for a server this session never
 * spawned (started earlier, or by a different process).
 */
export async function isPrismLlamaCppServerHealthy(
	serverUrl: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const response = await fetchFn(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}
