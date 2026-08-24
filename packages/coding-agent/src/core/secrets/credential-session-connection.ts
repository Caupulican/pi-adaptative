import { CredentialManagerError, CredentialStorageError } from "./credential-manager.ts";

export function isCredentialSessionKeyRequired(error: unknown): boolean {
	return (
		(error instanceof CredentialManagerError &&
			["invalid_session_key", "owner_setup_required"].includes(error.code)) ||
		(error instanceof CredentialStorageError &&
			["not_connected", "provider_command_failed", "provider_unavailable"].includes(error.code))
	);
}
