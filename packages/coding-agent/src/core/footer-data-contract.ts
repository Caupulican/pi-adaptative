/** Read-only footer data for extensions: the provider's mutators (statuses, provider count, dispose) stay host-side. */
export interface ReadonlyFooterDataProvider {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
	getAutonomyStatus(): string | undefined;
}
