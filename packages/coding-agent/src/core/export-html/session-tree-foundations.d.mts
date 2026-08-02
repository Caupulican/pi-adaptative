export interface SessionTreeEntry {
	id: string;
	parentId?: string | null;
	timestamp: string;
}

export interface SessionTreeNode<TEntry extends SessionTreeEntry> {
	entry: TEntry;
	children: Array<SessionTreeNode<TEntry>>;
	label?: string;
}

export interface TreeGutter {
	position: number;
	show: boolean;
}

export interface FlatSessionTreeNode<TNode extends { entry: SessionTreeEntry; children: TNode[] }> {
	node: TNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: TreeGutter[];
	isVirtualRootChild: boolean;
	multipleRoots: boolean;
}

export interface VisibleTreeLayout {
	multipleRoots: boolean;
	visibleParent: Map<string, string | null>;
	visibleChildren: Map<string | null, string[]>;
}

export function buildSessionTree<TEntry extends SessionTreeEntry>(
	entries: TEntry[],
	getLabel: (entry: TEntry) => string | undefined,
): Array<SessionTreeNode<TEntry>>;
export function buildActivePathIds<TEntry extends SessionTreeEntry>(
	entryById: Map<string, TEntry>,
	targetId: string,
): Set<string>;
export function getEntryPath<TEntry extends SessionTreeEntry>(
	entryById: Map<string, TEntry>,
	targetId: string,
): TEntry[];
export function indexSessionTree<TNode extends { entry: SessionTreeEntry; children: TNode[] }>(
	roots: TNode[],
): Map<string, TNode>;
export function flattenSessionTree<TNode extends { entry: SessionTreeEntry; children: TNode[] }>(
	roots: TNode[],
	activeEntryIds: ReadonlySet<string>,
): Array<FlatSessionTreeNode<TNode>>;
export function recalculateVisibleTreeLayout<TNode extends { entry: SessionTreeEntry; children: TNode[] }>(
	visibleNodes: Array<FlatSessionTreeNode<TNode>>,
	allNodes: Array<FlatSessionTreeNode<TNode>>,
): VisibleTreeLayout;
export function buildTreePrefix<TNode extends { entry: SessionTreeEntry; children: TNode[] }>(
	flatNode: FlatSessionTreeNode<TNode>,
	branchMiddle?: string,
): string;
export function extractTextContent(content: unknown, maxLength?: number): string;
export function hasTextContent(content: unknown): boolean;
export function formatTreeToolCall(
	name: string,
	args: Record<string, unknown>,
	shortenPath: (path: string) => string,
): string;
