/** Layered registrations: retiring an owner removes even its hidden generations. */
export class SourceRegistry<T> {
	private readonly entries = new Map<string, Array<{ value: T; sourceId?: string }>>();
	private readonly sourceKeys = new Map<string | undefined, Set<string>>();

	get(key: string): T | undefined {
		return this.entries.get(key)?.at(-1)?.value;
	}

	set(key: string, value: T, sourceId?: string): void {
		const layers = this.entries.get(key) ?? [];
		const previous = layers.findIndex((entry) => entry.sourceId === sourceId);
		if (previous !== -1) layers.splice(previous, 1);
		layers.push({ value, sourceId });
		this.entries.set(key, layers);
		let keys = this.sourceKeys.get(sourceId);
		if (!keys) {
			keys = new Set();
			this.sourceKeys.set(sourceId, keys);
		}
		keys.add(key);
	}

	values(): T[] {
		return [...this.entries.values()].flatMap((layers) => {
			const latest = layers.at(-1);
			return latest ? [latest.value] : [];
		});
	}

	delete(key: string): void {
		for (const entry of this.entries.get(key) ?? []) {
			const keys = this.sourceKeys.get(entry.sourceId);
			keys?.delete(key);
			if (keys?.size === 0) this.sourceKeys.delete(entry.sourceId);
		}
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
		this.sourceKeys.clear();
	}

	removeSource(sourceId: string): void {
		const keys = this.sourceKeys.get(sourceId);
		if (!keys) return;
		for (const key of keys) {
			const layers = this.entries.get(key);
			if (!layers) continue;
			const index = layers.findIndex((entry) => entry.sourceId === sourceId);
			if (index !== -1) layers.splice(index, 1);
			if (layers.length === 0) this.entries.delete(key);
		}
		this.sourceKeys.delete(sourceId);
	}
}
