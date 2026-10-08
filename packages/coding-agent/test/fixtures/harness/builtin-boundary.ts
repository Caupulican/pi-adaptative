/**
 * Stable module-export functions delegate at call time. Vitest's native module loader can retain
 * copied named exports, so rebinding the original Node object alone is not an isolation boundary.
 */
export type BuiltinKind = "fs" | "fsPromises" | "process" | "hostProcess" | "sqlite" | "workerThreads";

const BOOTSTRAP_READS = new Set([
	"access",
	"accessSync",
	"existsSync",
	"lstat",
	"lstatSync",
	"readFile",
	"readFileSync",
	"readdir",
	"readdirSync",
	"realpath",
	"realpathSync",
	"stat",
	"statSync",
]);

const MEMORY_MARKERS = new Set(["markAsUncloneable", "markAsUntransferable", "isMarkedAsUntransferable"]);
const BOOTSTRAP_READER_OPERATIONS = new Set(["openSync", "readSync", "fstatSync", "closeSync"]);
const BOOTSTRAP_READONLY_FLAGS: ReadonlySet<unknown> = new Set([undefined, "r", "rs", 0]);

export class BuiltinBoundary {
	readonly rejected: string[] = [];
	private readonly active = new Map<BuiltinKind, Record<string, unknown>>();
	private readonly originals = new Map<string, unknown>();
	/** Only the native synchronous file reader owns these nested descriptor operations. */
	private bootstrapReaderDepth = 0;

	get hasActiveWorld(): boolean {
		return this.active.size > 0;
	}

	original(kind: BuiltinKind, name: string): unknown {
		return this.originals.get(`${kind}.${name}`);
	}

	set(kind: BuiltinKind, exports: Record<string, unknown>): void {
		this.active.set(kind, exports);
	}

	clear(): void {
		this.active.clear();
	}

	resetEvidence(): void {
		this.rejected.length = 0;
	}

	assertClean(): void {
		if (this.rejected.length) throw new Error(`Builtin boundary rejected: ${this.rejected.join(", ")}`);
	}

	module(original: Record<string, unknown>, kind: BuiltinKind): Record<string, unknown> {
		const source =
			typeof original.default === "object" && original.default !== null
				? (original.default as Record<string, unknown>)
				: original;
		const named: Record<string, unknown> = {};
		for (const name of new Set([...Object.keys(source), ...Object.keys(original)])) {
			if (name === "default") continue;
			const value = original[name] ?? source[name];
			const originalKey = `${kind}.${name}`;
			if (!this.originals.has(originalKey)) this.originals.set(originalKey, value);
			const initial = this.originals.get(originalKey);
			if (name === "promises" && kind === "fs") {
				named[name] = this.module(value as Record<string, unknown>, "fsPromises").default;
			} else if (typeof value === "function" && !["Stats", "Dirent"].includes(name)) {
				const boundary = this;
				const wrapper = function (...arguments_: unknown[]) {
					if (kind === "workerThreads" && MEMORY_MARKERS.has(name) && typeof initial === "function") {
						return Reflect.apply(initial, source, arguments_);
					}
					const current = boundary.active.get(kind);
					const implementation = current?.[name];
					if (typeof implementation === "function") {
						return new.target
							? Reflect.construct(implementation, arguments_)
							: Reflect.apply(implementation, current, arguments_);
					}
					if (
						!boundary.hasActiveWorld &&
						kind === "fs" &&
						boundary.bootstrapReaderDepth > 0 &&
						BOOTSTRAP_READER_OPERATIONS.has(name) &&
						typeof initial === "function" &&
						(name !== "openSync" || BOOTSTRAP_READONLY_FLAGS.has(arguments_[1]))
					) {
						return Reflect.apply(initial, source, arguments_);
					}
					if (
						!boundary.hasActiveWorld &&
						(kind === "fs" || kind === "fsPromises") &&
						BOOTSTRAP_READS.has(name) &&
						typeof initial === "function"
					) {
						if (kind === "fs" && name === "readFileSync") {
							const options = arguments_[1];
							const flag: unknown =
								typeof options === "object" && options !== null ? Reflect.get(options, "flag") : undefined;
							if (typeof arguments_[0] === "number" || !BOOTSTRAP_READONLY_FLAGS.has(flag)) {
								const label = "fs.readFileSync.bootstrap_readonly";
								boundary.rejected.push(label);
								throw new Error(`Unmapped builtin effect: ${label}`);
							}
							boundary.bootstrapReaderDepth++;
							try {
								return Reflect.apply(initial, source, arguments_);
							} finally {
								boundary.bootstrapReaderDepth--;
							}
						}
						return Reflect.apply(initial, source, arguments_);
					}
					const label = `${kind}.${name}`;
					boundary.rejected.push(label);
					throw new Error(`Unmapped builtin effect: ${label}`);
				};
				if (name === "realpath" || name === "realpathSync") Object.assign(wrapper, { native: wrapper });
				if (typeof initial === "function" && Reflect.get(initial, "prototype")) {
					Object.defineProperty(wrapper, "prototype", { value: Reflect.get(initial, "prototype") });
				}
				named[name] = wrapper;
			} else named[name] = value;
		}
		// CJS libraries may clone fs methods while production modules load. Give them the same stable
		// dispatcher now, not a concrete per-world implementation that becomes stale in the next test.
		for (const [name, value] of Object.entries(named)) {
			const descriptor = Object.getOwnPropertyDescriptor(source, name);
			if (descriptor?.writable || descriptor?.configurable) {
				Object.defineProperty(source, name, {
					configurable: true,
					writable: true,
					enumerable: descriptor.enumerable,
					value,
				});
			}
		}
		return { ...named, default: { ...named } };
	}
}

export const builtinBoundary = new BuiltinBoundary();

export function wrapBuiltinModule(original: Record<string, unknown>, kind: BuiltinKind): Record<string, unknown> {
	return builtinBoundary.module(original, kind);
}
