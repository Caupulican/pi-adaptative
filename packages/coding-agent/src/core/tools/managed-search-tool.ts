import {
	ensureToolWithDiagnostics,
	formatManagedToolProvisioningFailure,
	getToolPath,
	type ManagedToolName,
	type ManagedToolResolver,
} from "../../utils/tools-manager.ts";

export interface ManagedSearchToolOptions {
	/** Managed-tool provisioning adapter. Defaults to Pi's diagnostic-preserving resolver. */
	managedToolResolver?: ManagedToolResolver;
}

export function resolveInstalledSearchTool(tool: ManagedToolName): string {
	const path = getToolPath(tool, { installedOnly: true });
	if (!path) throw new Error(`Installed ${tool} is unavailable; investigation does not install tools`);
	return path;
}

/** One provisioning boundary shared by local search tools; unavailable results always retain their cause. */
export async function resolveManagedSearchTool(
	tool: ManagedToolName,
	resolver: ManagedToolResolver = ensureToolWithDiagnostics,
): Promise<string> {
	const resolution = await resolver(tool, true);
	if (resolution.status === "unavailable") {
		throw new Error(formatManagedToolProvisioningFailure(tool, resolution));
	}
	return resolution.path;
}
