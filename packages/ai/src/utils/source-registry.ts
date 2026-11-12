/** Custom registration layers above explicit base values; retiring an owner removes even its hidden generations. */
export class SourceRegistry<T> {
	private readonly bases = new Map<string, T>();
	private readonly entries = new Map<string, Array<{ value: T; sourceId?: string }>>();
	private readonly sourceKeys = new Map<string | undefined, Set<string>>();

	get(key: string): T | undefined {
		const layer = this.entries.get(key)?.at(-1);
		return layer ? layer.value : this.bases.get(key);
	}

	/** Refresh a built-in without changing the precedence or lifetime of any custom registration. */
	setBase(key: string, value: T): void {
		this.bases.set(key, value);
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
		return [...new Set([...this.bases.keys(), ...this.entries.keys()])].map((key) => this.get(key)!);
	}

	delete(key: string): void {
		this.bases.delete(key);
		for (const entry of this.entries.get(key) ?? []) {
			const keys = this.sourceKeys.get(entry.sourceId);
			keys?.delete(key);
			if (keys?.size === 0) this.sourceKeys.delete(entry.sourceId);
		}
		this.entries.delete(key);
	}

	clear(): void {
		this.bases.clear();
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
