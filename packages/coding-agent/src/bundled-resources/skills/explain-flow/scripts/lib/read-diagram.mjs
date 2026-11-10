/**
 * Reads a diagram written in another notation into one plain graph: Mermaid (flowchart, sequence and state diagrams) and
 * Graphviz DOT. The graph keeps what a living diagram can show: the nodes with their words and role, the edges with
 * their words and order, and the groups. Everything else in the source (colours, click handlers, notes, styling) is
 * listed in `ignored`, never dropped in silence, so the author knows what the picture does not carry.
 *
 * A graph: `{ kind, nodes: [{ id, text, role }], edges: [{ from, to, text, back }], groups: [{ title, ids }], ignored }`
 * with `kind` "flow" (items follow the edges) or "sequence" (one item visits the edges in their written order) and
 * `role` one of "step", "choice", "store", "join", "start", "end".
 *
 * A harness plan (the object given to the plan tool: a title and steps with `id`, `do`, `uses` and `join`) is read the
 * same way, so a plan can be shown as its execution flow before it runs.
 */

const MERMAID_SHAPES = [
	{ open: "([", close: "])", role: "start" },
	{ open: "[[", close: "]]", role: "step" },
	{ open: "[(", close: ")]", role: "store" },
	{ open: "((", close: "))", role: "start" },
	{ open: "{{", close: "}}", role: "choice" },
	{ open: "[/", close: "/]", role: "step" },
	{ open: "[\\", close: "\\]", role: "step" },
	{ open: "[", close: "]", role: "step" },
	{ open: "(", close: ")", role: "step" },
	{ open: "{", close: "}", role: "choice" },
	{ open: ">", close: "]", role: "step" },
];
/** A Mermaid link: its shaft, an optional label inside it, and its head. Group 1 or 2 is the label. */
const MERMAID_LINK = /^\s*(?:(?:--|==|-\.)\s*([^-=.|>][^|>]*?)\s*(?:-->|==>|\.->|---|===|-\.-)|(?:-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|-\.+-|--[ox]|<-{2,}>)(?:\|([^|]*)\|)?)/;
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/;

function cleanText(text) {
	return text
		.replace(/^["'`]|["'`]$/g, "")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/#quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\\n/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function graphOf(kind) {
	const nodes = new Map();
	const graph = { kind, nodes: [], edges: [], groups: [], ignored: [] };
	return {
		graph,
		node(id, text, role) {
			let node = nodes.get(id);
			if (!node) {
				node = { id, text: id, role: "step" };
				nodes.set(id, node);
				graph.nodes.push(node);
			}
			if (text !== undefined && text !== "") node.text = text;
			if (role !== undefined) node.role = role;
			return node;
		},
		edge(from, to, text) {
			graph.edges.push({ from, to, text: text ? cleanText(text) : "" });
		},
		ignore(what) {
			if (!graph.ignored.includes(what)) graph.ignored.push(what);
		},
	};
}

/** One node reference at the start of `rest`: its id, an optional shape with words, and what follows. */
function readMermaidNode(rest, build) {
	const id = ID.exec(rest.trimStart());
	if (!id) return undefined;
	let after = rest.trimStart().slice(id[0].length);
	for (const shape of MERMAID_SHAPES) {
		if (!after.startsWith(shape.open)) continue;
		const end = after.indexOf(shape.close, shape.open.length);
		if (end < 0) continue;
		build.node(id[0], cleanText(after.slice(shape.open.length, end)), shape.role);
		after = after.slice(end + shape.close.length);
		return { id: id[0], rest: after.replace(/^:::[A-Za-z0-9_-]+/, "") };
	}
	build.node(id[0]);
	return { id: id[0], rest: after.replace(/^:::[A-Za-z0-9_-]+/, "") };
}

function readMermaidFlow(lines, build) {
	const open = [];
	for (const line of lines) {
		const head = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b\s*(.*)$/.exec(line);
		if (head) {
			if (head[1] === "subgraph") {
				const named = /^([A-Za-z0-9_.-]+)?\s*(?:\[(.*)\])?$/.exec(head[2].trim());
				const title = cleanText(named?.[2] ?? named?.[1] ?? head[2]);
				const group = { title, ids: [] };
				build.graph.groups.push(group);
				open.push(group);
			} else if (head[1] === "end") open.pop();
			else if (head[1] !== "direction") build.ignore(`${head[1]} (styling and links are not carried)`);
			continue;
		}
		let rest = line;
		let sources;
		for (;;) {
			const group = [];
			for (;;) {
				const node = readMermaidNode(rest, build);
				if (!node) break;
				group.push(node.id);
				for (const scope of open) if (!scope.ids.includes(node.id)) scope.ids.push(node.id);
				rest = node.rest;
				const more = /^\s*&\s*/.exec(rest);
				if (!more) break;
				rest = rest.slice(more[0].length);
			}
			if (group.length === 0) break;
			if (sources) for (const from of sources.ids) for (const to of group) build.edge(from, to, sources.text);
			const link = MERMAID_LINK.exec(rest);
			if (!link) break;
			sources = { ids: group, text: link[1] ?? link[2] ?? "" };
			rest = rest.slice(link[0].length);
		}
		if (rest.trim() !== "" && rest.trim() !== ";") build.ignore(`a line the reader could not follow: ${line.slice(0, 60)}`);
	}
}

function readMermaidSequence(lines, build) {
	for (const line of lines) {
		const who = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
		if (who) {
			build.node(who[1], cleanText(who[2] ?? who[1]), "step");
			continue;
		}
		const message = /^([A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*([A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*)\s*:\s*(.*)$/.exec(line);
		if (message) {
			build.node(message[1]);
			build.node(message[3]);
			build.graph.edges.push({ from: message[1], to: message[3], text: cleanText(message[4]), back: message[2].startsWith("--") });
			continue;
		}
		const block = /^(loop|alt|else|opt|par|and|critical|break|rect|end|activate|deactivate|autonumber|note|title)\b/i.exec(line);
		if (!block) build.ignore(`a line the reader could not follow: ${line.slice(0, 60)}`);
		else if (/^(loop|alt|else|opt|par|and|critical|break)$/i.test(block[1])) build.ignore(`${block[1].toLowerCase()} blocks (their messages are shown once, in written order)`);
		else if (/^note$/i.test(block[1])) build.ignore("notes");
	}
}

function readMermaidState(lines, build) {
	let ends = 0;
	for (const line of lines) {
		const named = /^state\s+"([^"]+)"\s+as\s+(\S+)$/.exec(line);
		if (named) {
			build.node(named[2], cleanText(named[1]));
			continue;
		}
		const move = /^(\[\*\]|[A-Za-z0-9_.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/.exec(line);
		if (move) {
			const from = move[1] === "[*]" ? "start" : move[1];
			const to = move[2] === "[*]" ? `end-${++ends}` : move[2];
			if (move[1] === "[*]") build.node(from, "start", "start");
			else build.node(from);
			if (move[2] === "[*]") build.node(to, "end", "end");
			else build.node(to);
			build.edge(from, to, move[3] ?? "");
			continue;
		}
		const described = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
		if (described) build.node(described[1], cleanText(described[2]));
		else if (/^(state\b.*\{|\}|note\b|end note|direction\b|--)/.test(line)) build.ignore("composite states, notes and regions (their states are shown flat)");
		else build.ignore(`a line the reader could not follow: ${line.slice(0, 60)}`);
	}
}

/** A Mermaid diagram, alone or inside a Markdown fence. */
export function readMermaid(source) {
	const fenced = /```mermaid\s*\n([\s\S]*?)```/.exec(source);
	const lines = (fenced ? fenced[1] : source)
		.split(/\r?\n/)
		.map((line) => line.replace(/%%.*$/, "").trim())
		.filter((line) => line !== "" && !/^---$/.test(line));
	const header = lines.shift() ?? "";
	if (/^(flowchart|graph)\b/i.test(header)) {
		const build = graphOf("flow");
		readMermaidFlow(lines.flatMap((line) => line.split(";").map((part) => part.trim()).filter(Boolean)), build);
		return build.graph;
	}
	if (/^sequenceDiagram\b/i.test(header)) {
		const build = graphOf("sequence");
		readMermaidSequence(lines, build);
		return build.graph;
	}
	if (/^stateDiagram(-v2)?\b/i.test(header)) {
		const build = graphOf("flow");
		readMermaidState(lines, build);
		return build.graph;
	}
	throw new Error(`this Mermaid diagram type is not read yet: "${header.split(/\s/)[0]}" (read: flowchart, graph, sequenceDiagram, stateDiagram)`);
}

const DOT_ROLES = { diamond: "choice", Mdiamond: "start", Msquare: "end", cylinder: "store", doublecircle: "end", point: "start" };

/** The attributes of one `[a=b, c="d"]` list. */
function dotAttributes(text) {
	const attributes = {};
	for (const match of (text ?? "").matchAll(/([A-Za-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,;\s\]]+)/g))
		attributes[match[1]] = match[2].replace(/^"|"$/g, "").replace(/\\"/g, '"');
	return attributes;
}

/** A Graphviz DOT graph: nodes, edges (also chains), labels, shapes and clusters. */
export function readDot(source) {
	const build = graphOf("flow");
	const body = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|\s)(\/\/|#).*$/gm, "$1");
	const open = [];
	const statements = body.split(/;|\n|(?=\{)|(?<=\{)|(?=\})|(?<=\})/).map((part) => part.trim()).filter(Boolean);
	const name = '("(?:[^"\\\\]|\\\\.)*"|[A-Za-z0-9_.]+)';
	const chain = new RegExp(`^${name}((?:\\s*-[->]\\s*${name})+)\\s*(\\[[^\\]]*\\])?$`);
	const single = new RegExp(`^${name}\\s*(\\[[^\\]]*\\])?$`);
	const unquote = (id) => id.replace(/^"|"$/g, "");
	for (const statement of statements) {
		if (/^(strict\s+)?(di)?graph\b/i.test(statement) || statement === "{") continue;
		if (/^subgraph\b/i.test(statement)) {
			open.push({ title: "", ids: [] });
			build.graph.groups.push(open[open.length - 1]);
			continue;
		}
		if (statement === "}") {
			open.pop();
			continue;
		}
		const setting = /^(label|rankdir|[A-Za-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|\S+)$/.exec(statement);
		if (setting) {
			if (setting[1] === "label" && open.length > 0) open[open.length - 1].title = cleanText(setting[2]);
			else if (setting[1] !== "rankdir" && setting[1] !== "label") build.ignore(`graph setting ${setting[1]}`);
			continue;
		}
		if (/^(node|edge|graph)\s*\[/.test(statement)) {
			build.ignore("default node and edge styling");
			continue;
		}
		const linked = chain.exec(statement);
		if (linked) {
			const ids = statement.replace(/\[[^\]]*\]\s*$/, "").split(/\s*-[->]\s*/).map((id) => unquote(id.trim()));
			const attributes = dotAttributes(linked[linked.length - 1]);
			for (const id of ids) {
				build.node(id);
				for (const scope of open) if (!scope.ids.includes(id)) scope.ids.push(id);
			}
			for (let index = 1; index < ids.length; index++) build.edge(ids[index - 1], ids[index], attributes.label ?? "");
			continue;
		}
		const alone = single.exec(statement);
		if (alone) {
			const attributes = dotAttributes(alone[2]);
			const id = unquote(alone[1]);
			build.node(id, attributes.label === undefined ? undefined : cleanText(attributes.label), DOT_ROLES[attributes.shape]);
			for (const scope of open) if (!scope.ids.includes(id)) scope.ids.push(id);
			continue;
		}
		build.ignore(`a statement the reader could not follow: ${statement.slice(0, 60)}`);
	}
	return build.graph;
}

/** A plan: each step is a node, each `uses` an edge into the step, and the steps nothing uses feed the goal. */
export function readPlan(plan) {
	const build = graphOf("flow");
	const steps = Array.isArray(plan.steps) ? plan.steps.filter((step) => typeof step?.id === "string") : [];
	for (const step of steps) {
		const node = build.node(step.id, step.id, step.join === "verify" ? "choice" : step.join ? "join" : "step");
		node.detail = typeof step.do === "string" ? cleanText(step.do) : undefined;
		if (step.join) node.lane = step.join;
	}
	const used = new Set();
	for (const step of steps)
		for (const dependency of Array.isArray(step.uses) ? step.uses : []) {
			if (!steps.some((other) => other.id === dependency)) continue;
			build.edge(dependency, step.id, "");
			used.add(dependency);
		}
	build.node("goal", "goal", "end");
	for (const step of steps) if (!used.has(step.id)) build.edge(step.id, "goal", "");
	return build.graph;
}

/** The graph of a diagram file, by its extension or its first words. */
export function readDiagram(source, fileName) {
	const name = fileName.toLowerCase();
	if (/\.json$/.test(name)) {
		const plan = JSON.parse(source);
		if (Array.isArray(plan?.steps)) return readPlan(plan);
		throw new Error("this JSON is not a plan (a plan has a steps list)");
	}
	if (/\.(dot|gv)$/.test(name) || /^\s*(strict\s+)?(di)?graph\s+\S*\s*\{/i.test(source)) return readDot(source);
	if (/\.(mmd|mermaid|md|markdown)$/.test(name) || /^\s*(flowchart|graph|sequenceDiagram|stateDiagram)/m.test(source))
		return readMermaid(source);
	throw new Error("the diagram's notation is not recognized (read: Mermaid .mmd or a ```mermaid fence, Graphviz .dot)");
}
