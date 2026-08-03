export type PrismLlamaCppServerProbe =
	| { status: "down"; servedModelIds: [] }
	| { status: "matching" | "conflict"; servedModelIds: string[] };

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const MAX_REPORTED_MODEL_IDS = 8;
const MAX_MODEL_ID_CHARS = 256;

/** Health alone is insufficient on a shared port: readiness requires the exact requested alias. */
export async function probePrismLlamaCppServer(
	serverUrl: string,
	expectedModelId: string,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<PrismLlamaCppServerProbe> {
	try {
		const health = await fetchFn(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!health.ok) return { status: "down", servedModelIds: [] };
	} catch {
		return { status: "down", servedModelIds: [] };
	}

	try {
		const models = await fetchFn(`${serverUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!models.ok) return { status: "conflict", servedModelIds: [] };
		const payload = (await models.json()) as { data?: unknown };
		const servedModelIds = Array.isArray(payload.data)
			? payload.data
					.map((entry) =>
						typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
							? (entry as { id: string }).id.slice(0, MAX_MODEL_ID_CHARS)
							: undefined,
					)
					.filter((id): id is string => id !== undefined)
					.slice(0, MAX_REPORTED_MODEL_IDS)
			: [];
		return {
			status: servedModelIds.includes(expectedModelId) ? "matching" : "conflict",
			servedModelIds,
		};
	} catch {
		return { status: "conflict", servedModelIds: [] };
	}
}
