/** Bounded ownership for live root-chat components; canonical transcript history remains elsewhere. */

import { type Component, type Container, Spacer, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { theme } from "../../presentation/theme-model.ts";

export const TUI_LIVE_HISTORY_MAX_COMPONENTS = 260;
export const TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS = 220;

/** Keeps only the component handles an owner message still needs if delivery is withdrawn. */
export class WithdrawableUserEchoRetention {
	private readonly components = new WeakMap<AgentMessage, readonly Component[]>();
	private readonly references = new Set<WeakRef<AgentMessage>>();
	private readonly referenceByMessage = new WeakMap<AgentMessage, WeakRef<AgentMessage>>();
	private readonly finalizer = new FinalizationRegistry<WeakRef<AgentMessage>>((reference) => {
		this.references.delete(reference);
	});

	remember(message: AgentMessage, components: readonly Component[]): void {
		this.components.set(message, components);
		if (this.referenceByMessage.has(message)) return;
		const reference = new WeakRef(message);
		this.referenceByMessage.set(message, reference);
		this.references.add(reference);
		this.finalizer.register(message, reference, reference);
	}

	withdraw(message: AgentMessage, root: Container): void {
		const components = this.components.get(message) ?? [];
		this.forget(message);
		for (const component of components) root.removeChild(component);
	}

	reconcile(isDurable: (message: AgentMessage) => boolean): void {
		for (const reference of this.references) {
			const message = reference.deref();
			if (!message) this.references.delete(reference);
			else if (isDurable(message)) this.forget(message);
		}
	}

	*retainedComponents(): Generator<Component> {
		for (const reference of this.references) {
			const message = reference.deref();
			if (!message) this.references.delete(reference);
			else yield* this.components.get(message) ?? [];
		}
	}

	clear(): void {
		for (const reference of this.references) {
			const message = reference.deref();
			if (message) {
				this.components.delete(message);
				this.referenceByMessage.delete(message);
			}
			this.finalizer.unregister(reference);
		}
		this.references.clear();
	}

	private forget(message: AgentMessage): void {
		this.components.delete(message);
		const reference = this.referenceByMessage.get(message);
		this.referenceByMessage.delete(message);
		if (!reference) return;
		this.references.delete(reference);
		this.finalizer.unregister(reference);
	}
}

interface LiveTranscriptRetentionOptions {
	root: Container;
	streaming(): Component | undefined;
	withdrawableEchoes(): Iterable<Component>;
	readingComponents?(): Iterable<Component> | undefined;
	historyBoundary?(entryId: string, evicted: readonly Component[]): boolean;
	pagesHistory?(): boolean;
	messageEntryId?(message: AgentMessage): string | undefined;
	previousEntryId?(entryId: string): string | null | undefined;
	requestRender(): void;
}

export class LiveTranscriptRetention {
	private readonly options: LiveTranscriptRetentionOptions;
	private hiddenNotice: Text | undefined;
	private hiddenComponents = 0;
	private lastStatusSpacer: Spacer | undefined;
	private lastStatusText: Text | undefined;
	private sources = new WeakMap<Component, string | WeakRef<AgentMessage>>();

	constructor(options: LiveTranscriptRetentionOptions) {
		this.options = options;
	}

	reset(): void {
		this.hiddenNotice = undefined;
		this.hiddenComponents = 0;
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.sources = new WeakMap();
	}

	rememberTurnStart(component: Component | undefined, source: AgentMessage | string): void {
		if (component) this.sources.set(component, typeof source === "string" ? source : new WeakRef(source));
	}

	private entryId(component: Component): string | undefined {
		const source = this.sources.get(component);
		if (typeof source === "string") return source;
		const message = source?.deref();
		return message && this.options.messageEntryId?.(message);
	}

	private replaceChildren(children: Component[]): void {
		this.options.root.clear();
		this.options.root.children = children;
	}

	appendStatus(target: Container, message: string, requestRender = true): void {
		if (target !== this.options.root) {
			target.addChild(new Spacer(1));
			target.addChild(new Text(theme.fg("dim", message), 1, 0));
			if (requestRender) this.options.requestRender();
			return;
		}
		const children = target.children;
		const last = children.at(-1);
		const secondLast = children.at(-2);
		if (
			this.lastStatusText !== undefined &&
			this.lastStatusSpacer !== undefined &&
			last === this.lastStatusText &&
			secondLast === this.lastStatusSpacer
		) {
			this.lastStatusText?.setText(theme.fg("dim", message));
			if (requestRender) this.options.requestRender();
			return;
		}
		this.lastStatusSpacer = new Spacer(1);
		this.lastStatusText = new Text(theme.fg("dim", message), 1, 0);
		target.addChild(this.lastStatusSpacer);
		target.addChild(this.lastStatusText);
		this.trim();
		if (requestRender) this.options.requestRender();
	}

	trim(): boolean {
		const children = this.options.root.children;
		if (this.hiddenNotice && !children.includes(this.hiddenNotice)) {
			this.hiddenNotice = undefined;
			this.hiddenComponents = 0;
		}
		if (children.length <= TUI_LIVE_HISTORY_MAX_COMPONENTS) return false;

		const protectedComponents = new Set<Component>();
		const paged = this.options.pagesHistory?.() ?? false;
		const protect = (component: Component | undefined): void => {
			if (component && children.includes(component)) protectedComponents.add(component);
		};
		protect(this.options.streaming());
		for (const component of this.options.withdrawableEchoes()) protect(component);
		if (!paged) {
			protect(this.lastStatusSpacer);
			protect(this.lastStatusText);
			for (const component of this.options.readingComponents?.() ?? []) protect(component);
		}

		const trimStart = children[0] === this.hiddenNotice ? 1 : 0;
		const removalTarget = children.length - TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS;
		if (this.options.historyBoundary && paged) {
			let end = trimStart;
			let boundary: string | undefined;
			// Checkpoints are recorded at owner turns and at assistant exchanges with their own action groups.
			for (let index = trimStart + 1; index < children.length; index++) {
				if (protectedComponents.has(children[index - 1]!)) break;
				const id = this.entryId(children[index]!);
				const previous = id && this.options.previousEntryId?.(id);
				if (!previous) continue;
				end = index;
				boundary = previous;
				if (end - trimStart >= removalTarget) break;
			}
			if (boundary !== undefined) {
				if (!this.options.historyBoundary(boundary, children.slice(trimStart, end))) return false;
				this.replaceChildren(children.slice(end));
				return true;
			}
			return false;
		}
		const removed: Component[] = [];
		const retained = children.filter((component, index) => {
			if (index < trimStart || removed.length >= removalTarget || protectedComponents.has(component)) return true;
			removed.push(component);
			return false;
		});
		if (removed.length === 0) return false;
		this.hiddenComponents += removed.length;

		const text = theme.fg("dim", interfaceText().interactive.olderHistoryHidden(this.hiddenComponents));
		if (retained[0] === this.hiddenNotice) this.hiddenNotice?.setText(text);
		else {
			this.hiddenNotice = new Text(text, 1, 0);
			retained.unshift(this.hiddenNotice);
		}
		this.replaceChildren(retained);
		return true;
	}
}
