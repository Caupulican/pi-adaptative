/** A key index that never becomes the lifetime owner of its object values. */
export class WeakValueCache<Key, Value extends WeakKey> {
	private readonly references = new Map<Key, WeakRef<Value>>();
	private readonly finalizer = new FinalizationRegistry<{ readonly key: Key; readonly reference: WeakRef<Value> }>(
		({ key, reference }) => {
			if (this.references.get(key) === reference) this.references.delete(key);
		},
	);

	get(key: Key): Value | undefined {
		const reference = this.references.get(key);
		const value = reference?.deref();
		if (reference && !value) this.references.delete(key);
		return value;
	}

	set(key: Key, value: Value): void {
		const reference = new WeakRef(value);
		this.references.set(key, reference);
		this.finalizer.register(value, { key, reference });
	}

	delete(key: Key): boolean {
		return this.references.delete(key);
	}

	*values(): Generator<Value> {
		for (const [key, reference] of this.references) {
			const value = reference.deref();
			if (value) yield value;
			else this.references.delete(key);
		}
	}

	clear(): void {
		this.references.clear();
	}
}
