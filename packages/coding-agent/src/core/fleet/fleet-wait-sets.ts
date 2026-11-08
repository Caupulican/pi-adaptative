/**
 * Waiting nodes indexed by the resource that blocks them (`account:<key>`, `machine:memory`, `ceiling:running`,
 * `fleet:stop`, `placement:<key>`, ...). A node waits on exactly one key, the binding term of its last room decision. A
 * resource event wakes only the key it names, and only when that key has waiters; an event for a key nobody waits on
 * costs nothing.
 */

export class FleetWaitSets {
	private readonly byKey = new Map<string, Set<string>>();
	private readonly keyOf = new Map<string, string>();

	/** Records that `id` waits on `key`, moving it from any key it waited on before. */
	wait(id: string, key: string): void {
		const previous = this.keyOf.get(id);
		if (previous === key) return;
		if (previous !== undefined) this.unindex(id, previous);
		this.keyOf.set(id, key);
		let members = this.byKey.get(key);
		if (!members) {
			members = new Set();
			this.byKey.set(key, members);
		}
		members.add(id);
	}

	/** The node no longer waits on a fleet resource: it started, left the queue, or waits on something else. */
	release(id: string): void {
		const key = this.keyOf.get(id);
		if (key === undefined) return;
		this.keyOf.delete(id);
		this.unindex(id, key);
	}

	waiting(key: string): boolean {
		return (this.byKey.get(key)?.size ?? 0) > 0;
	}

	/** Whether any key with this prefix (`machine:`, `account:`) has waiters. */
	waitingUnder(prefix: string): boolean {
		for (const [key, members] of this.byKey) if (key.startsWith(prefix) && members.size > 0) return true;
		return false;
	}

	keyFor(id: string): string | undefined {
		return this.keyOf.get(id);
	}

	keys(): string[] {
		return [...this.byKey.keys()];
	}

	countUnder(prefix: string): number {
		let count = 0;
		for (const [key, members] of this.byKey) if (key.startsWith(prefix)) count += members.size;
		return count;
	}

	private unindex(id: string, key: string): void {
		const members = this.byKey.get(key);
		if (!members) return;
		members.delete(id);
		if (members.size === 0) this.byKey.delete(key);
	}
}
