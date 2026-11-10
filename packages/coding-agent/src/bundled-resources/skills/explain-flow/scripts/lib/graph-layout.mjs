/**
 * Turns a plain graph (see `read-diagram.mjs`) into a flow spec: every node becomes a station on the grid, every edge a
 * wire, and the paths through the graph become journeys shown one after another, so the picture is alive from the first
 * render. The result is a starting point an author refines (station kinds, words, timing), and it already passes the
 * layout check.
 *
 * Layout: a node's column is its distance from the start (the longest way there), its row its place among the nodes of
 * that column. An edge to the next column is a direct wire; an edge that skips columns or goes back runs along a lane
 * under the rows.
 */

const TEXT_ADVANCE = 1.05;
const LABEL_CHARS = 26;
const MARGIN_COLUMNS = 4;
const HEADER_ROWS = 5;
const FOOT_ROWS = 6;
const COLUMN_GAP = 7;
const BODY_WIDTH = { source: 8, worker: 11, rail: 20, queue: 7 };
/** Rows from a row's top to the top of a station's body, so every kind's port sits on one line. */
const BODY_DROP = { source: 5, worker: 3, rail: 5.5, queue: 3 };
const MAX_JOURNEYS = 6;
const FAIL_WORDS = /\b(fail|failed|failure|error|reject|rejected|denied|invalid|timeout|abort|aborted)\b/i;

function wrapWords(text, width) {
	const lines = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line !== "" && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else line = line === "" ? word : `${line} ${word}`;
	}
	if (line !== "") lines.push(line);
	return lines;
}

/** A station's name and the lines under it: long words go under the name, never away. */
function wordsOf(text, notes) {
	if (text.length <= LABEL_CHARS) return { label: text, sub: [] };
	const lines = wrapWords(text, LABEL_CHARS);
	if (lines.length > 3) notes.push(`"${text.slice(0, 40)}..." is cut after three lines; shorten it in the spec`);
	return { label: lines[0], sub: lines.slice(1, 3) };
}

/** Marks the edges that close a cycle, walking from the nodes nothing points at. */
function markBackEdges(graph) {
	const out = new Map(graph.nodes.map((node) => [node.id, []]));
	for (const edge of graph.edges) out.get(edge.from)?.push(edge);
	const state = new Map();
	const visit = (id) => {
		state.set(id, "open");
		for (const edge of out.get(id) ?? []) {
			if (edge.back === true) continue;
			if (state.get(edge.to) === "open") edge.back = true;
			else if (!state.has(edge.to)) visit(edge.to);
		}
		state.set(id, "done");
	};
	const pointedAt = new Set(graph.edges.map((edge) => edge.to));
	for (const node of graph.nodes) if (!pointedAt.has(node.id) && !state.has(node.id)) visit(node.id);
	for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
	return out;
}

function stationKind(node, isRoot, isSink) {
	if (isSink || node.role === "end") return "rail";
	if (isRoot) return "source";
	return "worker";
}

function mechanismOf(node) {
	if (node.role === "choice") return "focus";
	if (node.role === "join") return "braid";
	if (node.role === "store") return "stamp";
	return "scan";
}

/** The spec of a graph whose items follow its edges. */
function flowSpec(graph, notes) {
	const out = markBackEdges(graph);
	const forward = graph.edges.filter((edge) => !edge.back && edge.from !== edge.to);
	const rank = new Map(graph.nodes.map((node) => [node.id, 0]));
	// The longest way to a node decides its column; the edges are few, so a pass per node settles it.
	for (let pass = 0; pass < graph.nodes.length; pass++)
		for (const edge of forward) if (rank.get(edge.to) < rank.get(edge.from) + 1) rank.set(edge.to, rank.get(edge.from) + 1);
	const hasIn = new Set(forward.map((edge) => edge.to));
	const hasOut = new Set(forward.map((edge) => edge.from));
	const columns = [];
	for (const node of graph.nodes) {
		const column = rank.get(node.id);
		columns[column] ??= [];
		columns[column].push(node);
	}
	const stations = new Map();
	for (const node of graph.nodes) {
		// An end is a node nothing leaves; one whose only way out goes back is a step like any other.
		const kind = stationKind(node, !hasIn.has(node.id), (out.get(node.id) ?? []).length === 0 && hasIn.has(node.id));
		const group = graph.groups.filter((entry) => entry.ids.includes(node.id) && entry.title);
		const words = wordsOf(node.text, notes);
		// A plan step says what it does under its name: the first two lines of its words.
		if (node.detail) words.sub = wrapWords(node.detail, LABEL_CHARS).slice(0, 2);
		stations.set(node.id, { node, kind, ...words, note: group.length === 1 ? group[0].title : undefined });
	}
	const charsOf = (station) => Math.max([station.label, station.note].filter(Boolean).join(" · ").length, ...station.sub.map((line) => line.length));
	const edgeWords = (column) => Math.max(0, ...forward.filter((edge) => rank.get(edge.from) === column && rank.get(edge.to) === column + 1).map((edge) => edge.text.length));
	const lefts = [];
	let cursor = 2;
	for (const [index, members] of columns.entries()) {
		lefts[index] = cursor;
		const width = Math.max(...members.map((node) => Math.max(BODY_WIDTH[stations.get(node.id).kind], charsOf(stations.get(node.id)) * TEXT_ADVANCE + 1)));
		const captions = Math.max(0, ...members.flatMap((node) => (out.get(node.id) ?? []).map((edge) => edge.text.length))) * TEXT_ADVANCE;
		cursor += Math.max(width, captions + 5) + Math.max(COLUMN_GAP, edgeWords(index) * TEXT_ADVANCE + 6);
	}
	const subRows = Math.max(0, ...[...stations.values()].map((station) => station.sub.length));
	const pitch = 17 + subRows * 2.25;
	const rows = Math.max(...columns.map((members) => members.length));
	const nodes = [];
	for (const [column, members] of columns.entries())
		for (const [row, node] of members.entries()) {
			const station = stations.get(node.id);
			station.column = column;
			station.row = row;
			nodes.push({
				id: station.id = `n${nodes.length + 1}`,
				kind: station.kind,
				band: "flow",
				at: [Math.round(lefts[column] * 2) / 2, row * pitch + BODY_DROP[station.kind]],
				label: station.label,
				...(station.note ? { note: station.note } : {}),
				...(station.sub.length > 0 ? { sub: station.sub } : {}),
				...(station.kind === "source" ? { count: 1 } : {}),
				...(station.kind === "rail" ? { dots: 3 } : {}),
				...(station.kind === "worker" ? { mechanism: mechanismOf(node) } : {}),
			});
		}
	const endOf = (id, role) => {
		const station = stations.get(id);
		return station.kind === "source" ? `${station.id}:1` : role === "back" && station.kind === "worker" ? `${station.id}.bottom` : station.id;
	};
	const wires = [];
	const wireOf = new Map();
	let lanes = 0;
	for (const edge of graph.edges) {
		if (edge.from === edge.to) {
			notes.push(`the edge from "${edge.from}" to itself is not drawn`);
			continue;
		}
		const key = `${edge.from}>${edge.to}`;
		if (wireOf.has(key)) {
			notes.push(`a second edge from "${edge.from}" to "${edge.to}" is not drawn`);
			continue;
		}
		if (stations.get(edge.from).kind === "rail") {
			notes.push(`the edge out of "${edge.from}" is not drawn: nothing leaves an end`);
			continue;
		}
		const direct = !edge.back && rank.get(edge.to) === rank.get(edge.from) + 1;
		const wire = { id: `w${wires.length + 1}`, from: endOf(edge.from, direct ? "direct" : "back"), to: endOf(edge.to, "to") };
		if (!direct) {
			wire.route = "loop";
			wire.lane = rows * pitch + 1 + lanes++ * 2.5;
		} else if (stations.get(edge.from).row !== stations.get(edge.to).row) {
			// A wire to another row turns in the clear strip between the two columns, past every station's words.
			const from = stations.get(edge.from);
			const start = lefts[from.column] + BODY_WIDTH[from.kind];
			const end = lefts[from.column + 1];
			wire.route = "elbow";
			wire.bend = Math.min(0.95, Math.max(0.05, Math.round(((end - COLUMN_GAP / 2 - start) / (end - start)) * 100) / 100));
		}
		if (edge.text) wire.label = edge.text;
		wires.push(wire);
		wireOf.set(key, { wire, edge });
	}
	// Journeys: every way from a start to an end, and one more for every edge that goes back.
	const paths = [];
	const walk = (id, trail) => {
		if (paths.length >= 64) return;
		const next = (out.get(id) ?? []).filter((edge) => wireOf.has(`${edge.from}>${edge.to}`));
		if (next.length === 0) paths.push(trail);
		for (const edge of next) {
			if (edge.back || trail.some((step) => step.to === edge.to)) paths.push([...trail, edge]);
			else walk(edge.to, [...trail, edge]);
		}
	};
	for (const node of graph.nodes) if (!hasIn.has(node.id) && hasOut.has(node.id)) walk(node.id, []);
	const chosen = [];
	const covered = new Set();
	while (chosen.length < MAX_JOURNEYS) {
		const best = paths
			.filter((path) => !chosen.includes(path) && path.length > 0)
			.map((path) => ({ path, gain: path.filter((edge) => !covered.has(edge)).length }))
			.sort((a, b) => b.gain - a.gain)[0];
		if (!best || best.gain === 0) break;
		chosen.push(best.path);
		for (const edge of best.path) covered.add(edge);
	}
	if (paths.length > chosen.length && covered.size < wireOf.size) notes.push(`${wireOf.size - covered.size} edge(s) are on no journey shown; add journeys for them`);
	const runs = [];
	let clock = 0.4;
	for (const [index, path] of chosen.entries()) {
		const steps = path.map((edge, at) => {
			const target = stations.get(edge.to);
			const wire = wireOf.get(`${edge.from}>${edge.to}`).wire.id;
			if (target.kind === "rail") return { to: target.id, wire, result: FAIL_WORDS.test(target.node.text) ? "fail" : "ok" };
			if (target.kind === "source") return { to: `${target.id}:1`, wire, ...(edge.text ? { carry: edge.text } : {}) };
			const taken = path[at + 1];
			const failed = taken !== undefined && FAIL_WORDS.test(taken.text);
			return {
				to: target.id,
				wire,
				work: 1.2,
				...(target.node.lane ? { lane: target.node.lane, laneTone: "info" } : {}),
				...(taken?.text ? (failed ? { result: "fail", text: taken.text } : { phases: [taken.text] }) : {}),
			};
		});
		runs.push({ id: `path ${index + 1}`, from: endOf(path[0].from, "direct"), start: Math.round(clock * 10) / 10, steps });
		clock += path.length * 1.9 + 0.6;
	}
	return { nodes, wires, runs, columns: cursor, rows: rows * pitch + (lanes > 0 ? lanes * 2.5 + 4 : 0), loop: clock + 0.6 };
}

/** The spec of a sequence: one item visits the stations in the order the messages are written. */
function sequenceSpec(graph, notes) {
	const lefts = [];
	let cursor = 2;
	const stations = graph.nodes.map((node, index) => {
		const words = wordsOf(node.text, notes);
		const said = Math.max(0, ...graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.text.length));
		lefts[index] = cursor;
		cursor += Math.max(BODY_WIDTH.worker, words.label.length * TEXT_ADVANCE + 1, said * TEXT_ADVANCE + 1) + COLUMN_GAP;
		return { id: `n${index + 1}`, node, ...words };
	});
	const place = new Map(stations.map((station, index) => [station.node.id, index]));
	const nodes = stations.map((station, index) => ({
		id: station.id,
		kind: "worker",
		band: "flow",
		at: [Math.round(lefts[index] * 2) / 2, BODY_DROP.worker],
		label: station.label,
		...(station.sub.length > 0 ? { sub: station.sub } : {}),
	}));
	const wireOf = new Map();
	const pairs = [];
	for (const edge of graph.edges) {
		const key = `${edge.from}>${edge.to}`;
		if (edge.from === edge.to || wireOf.has(key)) continue;
		const span = place.get(edge.to) - place.get(edge.from);
		const pair = { key, from: stations[place.get(edge.from)].id, to: stations[place.get(edge.to)].id, span };
		wireOf.set(key, pair);
		pairs.push(pair);
	}
	// A message to the next station is a direct wire; any other runs under the row, the shortest reach innermost.
	const under = pairs.filter((pair) => pair.span !== 1).sort((a, b) => Math.abs(a.span) - Math.abs(b.span));
	const wires = pairs.map((pair, index) => {
		pair.id = `w${index + 1}`;
		const lane = under.indexOf(pair);
		return { id: pair.id, from: pair.from, to: pair.to, ...(lane >= 0 ? { route: "loop", lane: 17 + lane * 2.5 } : {}) };
	});
	const steps = graph.edges
		.filter((edge) => edge.from !== edge.to)
		.map((edge) => ({ to: stations[place.get(edge.to)].id, wire: wireOf.get(`${edge.from}>${edge.to}`).id, work: 1.0, ...(edge.text ? { phases: [edge.text] } : {}) }));
	const first = graph.edges.find((edge) => edge.from !== edge.to);
	const runs = first ? [{ id: "messages", from: stations[place.get(first.from)].id, start: 0.4, steps }] : [];
	return { nodes, wires, runs, columns: cursor, rows: 17 + (under.length > 0 ? under.length * 2.5 + 4 : 0), loop: steps.length * 1.7 + 1.4 };
}

/**
 * The flow spec of a graph, and notes on what the author should look at. The canvas is as wide as the columns need; a
 * graph too wide for one picture is named so, not squeezed.
 */
export function specFromGraph(graph, options = {}) {
	const notes = graph.ignored.map((what) => `not carried: ${what}`);
	if (graph.nodes.length === 0) throw new Error("the diagram has no nodes");
	const laid = graph.kind === "sequence" ? sequenceSpec(graph, notes) : flowSpec(graph, notes);
	const unit = 10;
	const widthUnits = Math.ceil(laid.columns) + 2 * MARGIN_COLUMNS;
	const bandRows = Math.ceil(laid.rows) + HEADER_ROWS + 2;
	const even = (value) => Math.ceil(value / 2) * 2;
	if (widthUnits * unit > 3840) notes.push("the diagram is wider than one picture can carry; split it into parts");
	const loop = Math.min(120, Math.max(4, Math.ceil(laid.loop)));
	const spec = {
		title: options.title ?? "Flow",
		size: [even(Math.max(960, Math.min(3840, widthUnits * unit))), even(Math.max(360, (bandRows + FOOT_ROWS) * unit))],
		unit,
		loop,
		theme: options.theme ?? "matrix",
		footer: graph.kind === "sequence" ? "one item carries the messages in order" : "one item follows one path at a time",
		bands: [{ id: "flow", tier: "live", title: options.title ?? "Flow", height: bandRows }],
		nodes: laid.nodes,
		wires: laid.wires,
		runs: laid.runs,
	};
	return { spec, notes };
}
