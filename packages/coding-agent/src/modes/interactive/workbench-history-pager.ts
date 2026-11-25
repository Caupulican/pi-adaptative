/** Keeps a two-segment reading window over the live tail and the saved branch. */
import { type Component, Container } from "@caupulican/pi-tui";
import type { SessionManager } from "../../kernel/node.ts";
import type { SessionHistoryPage, SessionHistoryPageOptions } from "../../kernel/session/session-history-page.ts";
import type { ConversationWindow } from "./components/conversation-window.ts";

interface Position {
	start: string;
	stopBefore?: string;
}

interface Page {
	position: Position;
	older: string | null;
	container: Container;
}

interface PageRequest {
	direction: -1 | 1;
	controller: AbortController;
	residual: number;
}

type HistorySession = Pick<SessionManager, "captureBranchContext" | "readHistoryPage">;

interface WorkbenchHistoryPort {
	root: Container;
	isRootActive(): boolean;
	session(): HistorySession;
	render(page: SessionHistoryPage): Container;
	conversation(): ConversationWindow | undefined;
	repaint(): void;
	report(error: unknown): void;
}

export class WorkbenchHistoryPager {
	private readonly port: WorkbenchHistoryPort;
	private pages: readonly Page[] = [];
	private readonly newer = new Map<string, Position>();
	private bound?: { session: HistorySession; assertCurrent(): void };
	private liveOlder: string | null = null;
	private liveVisible = true;
	private request?: PageRequest;
	private prefetched?: { start: string; controller: AbortController; page: Promise<SessionHistoryPage | undefined> };
	private mounted: readonly Container[];

	constructor(port: WorkbenchHistoryPort) {
		this.port = port;
		this.mounted = [port.root];
	}

	reset(older: string | null = null): void {
		const session = this.port.session();
		this.bound = { session, assertCurrent: session.captureBranchContext() };
		this.liveOlder = older;
		this.close();
	}

	private close(): void {
		this.cancel();
		this.newer.clear();
		this.mount([], true);
	}

	/** Prefix eviction changes the seam between the saved pages and the live transcript. */
	setLiveBoundary(older: string, evicted: readonly Component[]): boolean {
		if (!this.hasCurrentBranch()) return false;
		if (this.liveOlder === older) return true;
		const previous = this.liveOlder;
		this.liveOlder = older;
		if (!this.liveVisible) return true;
		this.cancel();
		const reading = new Set(this.port.conversation()?.retainedComponents(this.port.root));
		const newest = this.pages.at(-1);
		if (evicted.some((component) => reading.has(component))) {
			const container = new Container();
			for (const component of evicted) container.addChild(component);
			const position = { start: older, stopBefore: previous ?? undefined };
			if (newest?.position.start === previous) this.newer.set(newest.position.start, position);
			const page = { position, older: previous, container };
			this.mount(newest ? [newest, page] : [page], true);
		} else if (newest) {
			const inLive = this.port.root.children.some((component) => reading.has(component));
			this.mount(inLive ? [] : this.pages, inLive);
		}
		return true;
	}

	segments(): readonly Container[] {
		return this.mounted;
	}

	showHeader(): boolean {
		return this.liveOlder === null && this.pages.length === 0;
	}

	*visibleArchive(): Iterable<Container> {
		for (const page of this.pages) yield page.container;
	}

	overlaySource(active: Container): Container {
		if (active !== this.port.root || this.pages.length === 0) return active;
		const overlay = new Container();
		for (const segment of this.mounted) overlay.addChild(segment);
		return overlay;
	}

	follow(): void {
		if (this.port.isRootActive()) this.close();
	}

	private hasCurrentBranch(): boolean {
		if (this.bound?.session !== this.port.session()) return false;
		try {
			this.bound.assertCurrent();
			return true;
		} catch {
			return false;
		}
	}

	private read(start: string, options: SessionHistoryPageOptions): Promise<SessionHistoryPage> {
		return this.bound!.session.readHistoryPage(start, options);
	}

	cancel(): void {
		this.request?.controller.abort();
		this.request = undefined;
		this.prefetched?.controller.abort();
		this.prefetched = undefined;
	}

	scrolling(delta: number): void {
		if (this.request && Math.sign(delta) !== this.request.direction) this.cancel();
	}

	prepareOlder(): void {
		if (this.request || !this.port.isRootActive() || !this.hasCurrentBranch()) return;
		const boundary = this.pages[0];
		const start = boundary ? boundary.older : this.liveOlder;
		if (start === null || this.prefetched?.start === start) return;
		this.prefetched?.controller.abort();
		const controller = new AbortController();
		const page = this.read(start, { signal: controller.signal }).catch(() => undefined);
		this.prefetched = { start, controller, page };
	}

	move(direction: -1 | 1, residual: number): boolean {
		if (!this.port.isRootActive() || !this.hasCurrentBranch()) return false;
		const boundary = direction < 0 ? this.pages[0] : this.pages.at(-1);
		const older = boundary ? boundary.older : this.liveOlder;
		if (direction < 0 ? older === null : this.liveVisible || !boundary) return false;
		if (this.request) {
			this.request.residual = direction * Math.min(2048, Math.abs(this.request.residual + residual));
			return true;
		}

		const request = { direction, residual, controller: new AbortController() };
		this.request = request;
		void this.load(request, boundary, older);
		return true;
	}

	private async load(request: PageRequest, boundary: Page | undefined, older: string | null): Promise<void> {
		const signal = request.controller.signal;
		try {
			const position = request.direction < 0 ? { start: older! } : await this.nextNewer(boundary!.position, signal);
			signal.throwIfAborted();
			if (!this.port.isRootActive() || !this.hasCurrentBranch()) return;
			if (!position) {
				this.mount([boundary!], true);
			} else {
				const prefetched = this.prefetched;
				const match = !position.stopBefore && prefetched?.start === position.start;
				if (!match) prefetched?.controller.abort();
				const prepared = match ? await prefetched?.page : undefined;
				signal.throwIfAborted();
				this.prefetched = undefined;
				const result = prepared ?? (await this.read(position.start, { signal, stopBefore: position.stopBefore }));
				signal.throwIfAborted();
				if (!this.port.isRootActive() || !this.hasCurrentBranch()) return;
				const next = { position, older: result.older, container: this.port.render(result) };
				if (request.direction < 0 && boundary) this.newer.set(position.start, boundary.position);
				const pages = !boundary ? [next] : request.direction < 0 ? [next, boundary] : [boundary, next];
				this.mount(pages, !boundary);
			}
			this.request = undefined;
			this.port.conversation()?.scroll(request.residual);
			this.port.repaint();
		} catch (error) {
			if (!signal.aborted && this.port.isRootActive() && this.hasCurrentBranch()) this.port.report(error);
		} finally {
			if (this.request === request) this.request = undefined;
		}
	}

	/** Find the new seam if the live tail evicted more entries while the operator was in older pages. */
	private async nextNewer(position: Position, signal: AbortSignal): Promise<Position | undefined> {
		const known = this.newer.get(position.start);
		if (known) return known;
		let start = this.liveOlder;
		if (start === position.start || start === null) return undefined;
		const bridge: Position[] = [];
		while (start !== position.start && start !== null) {
			const page = await this.read(start, { signal, stopBefore: position.start, positionsOnly: true });
			signal.throwIfAborted();
			bridge.push({ start, stopBefore: page.older ?? undefined });
			start = page.older;
		}
		if (start !== position.start) throw new Error("The saved history no longer meets the live transcript.");
		let previous = position;
		for (let index = bridge.length - 1; index >= 0; index--) {
			const next = bridge[index]!;
			this.newer.set(previous.start, next);
			previous = next;
		}
		return this.newer.get(position.start);
	}

	private mount(pages: readonly Page[], liveVisible: boolean): void {
		this.pages = pages;
		this.liveVisible = liveVisible;
		const segments = pages.map((page) => page.container);
		if (liveVisible) segments.push(this.port.root);
		this.mounted = segments;
	}
}
