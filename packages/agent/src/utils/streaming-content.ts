/** Append-only text storage that materializes immutable chunks only when a consumer requests a string. */
export class StreamingTextBuffer {
	private chunks: string[] = [];
	private cached = "";
	private dirty = false;
	private totalLength = 0;

	get length(): number {
		return this.totalLength;
	}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.totalLength += chunk.length;
		this.dirty = true;
	}

	materialize(): string {
		if (!this.dirty) return this.cached;
		this.cached = this.chunks.join("");
		this.chunks = [this.cached];
		this.dirty = false;
		return this.cached;
	}
}

/**
 * Projects growing structured text at geometrically spaced lengths and once at completion.
 * Prefix work therefore remains bounded by a geometric series instead of running for every delta.
 */
export class GeometricStreamingProjector<T> {
	private readonly buffer = new StreamingTextBuffer();
	private readonly project: (text: string) => T;
	private nextProjectionLength = 1;

	constructor(project: (text: string) => T) {
		this.project = project;
	}

	append(chunk: string): T | undefined {
		this.buffer.append(chunk);
		if (this.buffer.length < this.nextProjectionLength) return undefined;
		const projected = this.project(this.buffer.materialize());
		do {
			this.nextProjectionLength *= 2;
		} while (this.nextProjectionLength <= this.buffer.length);
		return projected;
	}

	finish(): T {
		return this.project(this.buffer.materialize());
	}
}
