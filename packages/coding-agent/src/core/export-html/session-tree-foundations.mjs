function orderActiveFirst(items, containsActive) {
	let activeCount = 0;
	for (const item of items) {
		if (containsActive.get(item)) activeCount++;
	}

	const ordered = new Array(items.length);
	let activeIndex = 0;
	let inactiveIndex = activeCount;
	for (const item of items) {
		if (containsActive.get(item)) {
			ordered[activeIndex++] = item;
		} else {
			ordered[inactiveIndex++] = item;
		}
	}
	return ordered;
}

function containsActiveNodes(roots, activeEntryIds) {
	const allNodes = [];
	const pending = roots.slice();
	while (pending.length > 0) {
		const node = pending.pop();
		allNodes.push(node);
		for (let index = node.children.length - 1; index >= 0; index--) {
			pending.push(node.children[index]);
		}
	}

	const containsActive = new Map();
	for (let index = allNodes.length - 1; index >= 0; index--) {
		const node = allNodes[index];
		let contains = activeEntryIds.has(node.entry.id);
		if (!contains) {
			for (const child of node.children) {
				if (containsActive.get(child)) {
					contains = true;
					break;
				}
			}
		}
		containsActive.set(node, contains);
	}
	return containsActive;
}

function pushLayoutChildren(stack, children, parent, multipleRoots) {
	const multipleChildren = children.length > 1;
	const childIndent = multipleChildren || (parent.justBranched && parent.indent > 0)
		? parent.indent + 1
		: parent.indent;
	const connectorDisplayed = parent.showConnector && !parent.isVirtualRootChild;
	const displayIndent = multipleRoots ? Math.max(0, parent.indent - 1) : parent.indent;
	const connectorPosition = Math.max(0, displayIndent - 1);
	const childGutters = connectorDisplayed
		? [...parent.gutters, { position: connectorPosition, show: !parent.isLast }]
		: parent.gutters;

	for (let index = children.length - 1; index >= 0; index--) {
		stack.push([
			children[index],
			childIndent,
			multipleChildren,
			multipleChildren,
			index === children.length - 1,
			childGutters,
			false,
		]);
	}
}

function ancestorEntries(entryById, targetId) {
	const ancestors = [];
	const visited = new Set();
	let current = entryById.get(targetId);
	while (current && !visited.has(current.id)) {
		ancestors.push(current);
		visited.add(current.id);
		if (current.parentId == null || current.parentId === current.id) break;
		current = entryById.get(current.parentId);
	}
	return ancestors;
}

export function buildSessionTree(entries, getLabel) {
	const nodeById = new Map();
	for (const entry of entries) {
		nodeById.set(entry.id, { entry, children: [], label: getLabel(entry) });
	}

	const roots = [];
	for (const node of nodeById.values()) {
		const parentId = node.entry.parentId;
		const parent = parentId == null || parentId === node.entry.id ? undefined : nodeById.get(parentId);
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const pending = roots.slice();
	while (pending.length > 0) {
		const node = pending.pop();
		node.children.sort(
			(left, right) => new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
		);
		for (let index = node.children.length - 1; index >= 0; index--) {
			pending.push(node.children[index]);
		}
	}
	return roots;
}

export function buildActivePathIds(entryById, targetId) {
	const ids = new Set();
	for (const entry of ancestorEntries(entryById, targetId)) ids.add(entry.id);
	return ids;
}

export function getEntryPath(entryById, targetId) {
	return ancestorEntries(entryById, targetId).reverse();
}

export function indexSessionTree(roots) {
	const nodeById = new Map();
	const pending = roots.slice();
	while (pending.length > 0) {
		const node = pending.pop();
		nodeById.set(node.entry.id, node);
		for (let index = node.children.length - 1; index >= 0; index--) {
			pending.push(node.children[index]);
		}
	}
	return nodeById;
}

export function flattenSessionTree(roots, activeEntryIds) {
	const result = [];
	const multipleRoots = roots.length > 1;
	const containsActive = containsActiveNodes(roots, activeEntryIds);
	const stack = [];
	const orderedRoots = orderActiveFirst(roots, containsActive);
	for (let index = orderedRoots.length - 1; index >= 0; index--) {
		stack.push([
			orderedRoots[index],
			multipleRoots ? 1 : 0,
			multipleRoots,
			multipleRoots,
			index === orderedRoots.length - 1,
			[],
			multipleRoots,
		]);
	}

	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();
		result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });
		pushLayoutChildren(
			stack,
			orderActiveFirst(node.children, containsActive),
			{ indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild },
			multipleRoots,
		);
	}
	return result;
}

export function recalculateVisibleTreeLayout(visibleNodes, allNodes) {
	const visibleIds = new Set(visibleNodes.map((item) => item.node.entry.id));
	const entryMap = new Map();
	for (const item of allNodes) entryMap.set(item.node.entry.id, item);

	const visibleParent = new Map();
	const visibleChildren = new Map([[null, []]]);
	for (const item of visibleNodes) {
		const nodeId = item.node.entry.id;
		let ancestorId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
		let remainingHops = entryMap.size;
		while (ancestorId !== null && ancestorId !== nodeId && remainingHops-- > 0 && !visibleIds.has(ancestorId)) {
			ancestorId = entryMap.get(ancestorId)?.node.entry.parentId ?? null;
		}
		if (ancestorId === nodeId || remainingHops < 0) ancestorId = null;
		visibleParent.set(nodeId, ancestorId);
		const siblings = visibleChildren.get(ancestorId);
		if (siblings) {
			siblings.push(nodeId);
		} else {
			visibleChildren.set(ancestorId, [nodeId]);
		}
	}

	const visibleRoots = visibleChildren.get(null);
	const multipleRoots = visibleRoots.length > 1;
	const nodeById = new Map();
	for (const item of visibleNodes) nodeById.set(item.node.entry.id, item);

	const stack = [];
	for (let index = visibleRoots.length - 1; index >= 0; index--) {
		stack.push([
			visibleRoots[index],
			multipleRoots ? 1 : 0,
			multipleRoots,
			multipleRoots,
			index === visibleRoots.length - 1,
			[],
			multipleRoots,
		]);
	}

	while (stack.length > 0) {
		const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();
		const item = nodeById.get(nodeId);
		if (!item) continue;
		Object.assign(item, { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });
		pushLayoutChildren(
			stack,
			visibleChildren.get(nodeId) ?? [],
			{ indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild },
			multipleRoots,
		);
	}

	return { multipleRoots, visibleParent, visibleChildren };
}

export function buildTreePrefix(flatNode, branchMiddle = "─") {
	const displayIndent = flatNode.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
	const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
	const connectorPosition = hasConnector ? displayIndent - 1 : -1;
	const parts = new Array(displayIndent);
	let gutterIndex = 0;
	for (let level = 0; level < displayIndent; level++) {
		while (gutterIndex < flatNode.gutters.length && flatNode.gutters[gutterIndex].position < level) gutterIndex++;
		const gutter = flatNode.gutters[gutterIndex];
		if (gutter?.position === level) {
			parts[level] = gutter.show ? "│  " : "   ";
		} else if (level === connectorPosition) {
			parts[level] = `${flatNode.isLast ? "└" : "├"}${branchMiddle} `;
		} else {
			parts[level] = "   ";
		}
	}
	return parts.join("");
}

export function extractTextContent(content, maxLength = Number.POSITIVE_INFINITY) {
	if (typeof content === "string") return content.slice(0, maxLength);
	if (!Array.isArray(content) || maxLength <= 0) return "";

	const parts = [];
	let remaining = maxLength;
	for (const block of content) {
		if (typeof block !== "object" || block === null || block.type !== "text" || typeof block.text !== "string") continue;
		if (remaining === Number.POSITIVE_INFINITY) {
			parts.push(block.text);
			continue;
		}
		if (remaining === 0) break;
		const part = block.text.slice(0, remaining);
		parts.push(part);
		remaining -= part.length;
	}
	return parts.join("");
}

export function hasTextContent(content) {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
			if (block.text.trim().length > 0) return true;
		}
	}
	return false;
}

export function formatTreeToolCall(name, args, shortenPath) {
	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = args.offset;
			const limit = args.limit;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display = `${display}:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
			return `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "edit":
			return `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "bash": {
			const command = String(args.command || "");
			const preview = command.replace(/[\n\t]/g, " ").trim().slice(0, 50);
			return `[bash: ${preview}${command.length > 50 ? "..." : ""}]`;
		}
		case "grep":
			return `[grep: /${args.pattern || ""}/ in ${shortenPath(String(args.path || "."))}]`;
		case "find":
			return `[find: ${args.pattern || ""} in ${shortenPath(String(args.path || "."))}]`;
		case "ls":
			return `[ls: ${shortenPath(String(args.path || "."))}]`;
		default: {
			const serialized = JSON.stringify(args) ?? "";
			return `[${name}: ${serialized.slice(0, 40)}${serialized.length > 40 ? "..." : ""}]`;
		}
	}
}
