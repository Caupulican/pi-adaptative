import type { ExtensionUIContext } from "../extensions/types.ts";
import { type CredentialManager, CredentialManagerError, CredentialStorageError } from "./credential-manager.ts";

export type CredentialSessionConnectionResult = "cancelled" | "connected";

type CredentialSessionUI = Pick<ExtensionUIContext, "input" | "notify">;

export function isCredentialSessionKeyRequired(error: unknown): boolean {
	return (
		(error instanceof CredentialManagerError &&
			["invalid_session_key", "owner_setup_required"].includes(error.code)) ||
		(error instanceof CredentialStorageError && ["not_connected", "provider_command_failed"].includes(error.code))
	);
}

function safeConnectionError(error: unknown): string {
	return error instanceof CredentialManagerError || error instanceof CredentialStorageError
		? error.message
		: "Bitwarden connection failed safely without exposing private data.";
}

/** Own the only Pi-side vault setup input: one masked BW_SESSION key prompt. */
export async function connectCredentialSessionWithMaskedPrompt(
	manager: CredentialManager,
	ui: CredentialSessionUI,
	signal?: AbortSignal,
): Promise<CredentialSessionConnectionResult> {
	while (!signal?.aborted) {
		let sessionKey = await ui.input("Connect Bitwarden", "Paste BW_SESSION session key", {
			sensitive: true,
			...(signal ? { signal } : {}),
		});
		if (sessionKey === undefined) return "cancelled";
		try {
			await manager.connect(sessionKey, signal);
			ui.notify("Bitwarden connected. Pi keeps the session key in memory only.", "info");
			return "connected";
		} catch (error) {
			if (signal?.aborted) return "cancelled";
			if (!isCredentialSessionKeyRequired(error)) throw error;
			ui.notify(safeConnectionError(error), "error");
		} finally {
			sessionKey = "";
		}
	}
	return "cancelled";
}
