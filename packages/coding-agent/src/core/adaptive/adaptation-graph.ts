/**
 * Durable Adaptation Graph.
 * Implements S1A-178, S1A-179, and S1A-238.
 * Rejects adaptation cycles mechanically.
 */

import type { AdaptationNode, AdaptationNodeStatus } from "./types.ts";

export class AdaptationCycleError extends Error {
	readonly fromNodeId: string;
	readonly toNodeId: string;

	constructor(fromNodeId: string, toNodeId: string) {
		super(`Adaptation cycle detected: cannot add dependency from ${fromNodeId} to ${toNodeId}`);
		this.name = "AdaptationCycleError";
		this.fromNodeId = fromNodeId;
		this.toNodeId = toNodeId;
	}
}

export class AdaptationGraph {
	private readonly nodes = new Map<string, AdaptationNode>();
	private readonly dependencies = new Map<string, Set<string>>(); // child -> Set of parents

	addNode(node: AdaptationNode): AdaptationNode {
		this.nodes.set(node.node_id, node);
		if (!this.dependencies.has(node.node_id)) {
			this.dependencies.set(node.node_id, new Set());
		}
		if (node.parent_ids) {
			for (const parentId of node.parent_ids) {
				this.addDependency(node.node_id, parentId);
			}
		}
		return node;
	}

	getNode(nodeId: string): AdaptationNode | undefined {
		return this.nodes.get(nodeId);
	}

	/**
	 * Adds a dependency edge: childId depends on parentId.
	 * Mechanically rejects cycles.
	 */
	addDependency(childId: string, parentId: string): void {
		if (childId === parentId) {
			throw new AdaptationCycleError(childId, parentId);
		}

		// Check if parentId already transitively depends on childId
		if (this.canReach(parentId, childId)) {
			throw new AdaptationCycleError(childId, parentId);
		}

		if (!this.dependencies.has(childId)) {
			this.dependencies.set(childId, new Set());
		}
		this.dependencies.get(childId)!.add(parentId);
	}

	/**
	 * Returns true if fromId can reach targetId via directed dependency edges (child -> parent).
	 */
	canReach(fromId: string, targetId: string, visited: Set<string> = new Set()): boolean {
		if (fromId === targetId) return true;
		if (visited.has(fromId)) return false;
		visited.add(fromId);

		const parents = this.dependencies.get(fromId);
		if (!parents) return false;

		for (const parentId of parents) {
			if (this.canReach(parentId, targetId, visited)) {
				return true;
			}
		}
		return false;
	}

	updateStatus(nodeId: string, status: AdaptationNodeStatus): void {
		const existing = this.nodes.get(nodeId);
		if (existing) {
			this.nodes.set(nodeId, {
				...existing,
				status,
			});
		}
	}

	listNodes(): readonly AdaptationNode[] {
		return Array.from(this.nodes.values());
	}

	summary(objectiveId?: string): Record<string, unknown> {
		const nodes = Array.from(this.nodes.values()).map((n) => ({
			id: n.node_id,
			kind: n.kind,
			status: n.status,
			parents: Array.from(this.dependencies.get(n.node_id) ?? []),
		}));
		return {
			objectiveId,
			totalNodes: nodes.length,
			nodes,
		};
	}

	serialize(): string {
		const nodes = Array.from(this.nodes.values());
		const deps = Array.from(this.dependencies.entries()).map(([k, v]) => [k, Array.from(v)]);
		return JSON.stringify({ nodes, deps }, null, 2);
	}

	deserialize(jsonString: string): void {
		this.nodes.clear();
		this.dependencies.clear();
		try {
			const parsed = JSON.parse(jsonString);
			if (Array.isArray(parsed.nodes)) {
				for (const node of parsed.nodes) {
					this.nodes.set(node.node_id, node);
				}
			}
			if (Array.isArray(parsed.deps)) {
				for (const [child, parents] of parsed.deps) {
					this.dependencies.set(child, new Set(parents));
				}
			}
		} catch {
			// Fail-safe
		}
	}
}
