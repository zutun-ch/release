// A small parser for the YAML this repo's workflow and action files use, so the tests can check
// their structure without an npm dependency: block mappings and sequences, plain and quoted
// scalars, single-line flow sequences and mappings, block scalars (`|`, `>`), comments.
// Everything stays a string (no numbers or booleans), which is all the checks need. Anything
// outside this subset throws; it is test tooling, not a general YAML parser.

export class YamlError extends Error {}

export function parseYaml(text) {
	const lines = text.split(/\r?\n/).map((raw, i) => ({ n: i + 1, raw }));
	const p = { lines, i: 0 };
	skipBlank(p);
	if (p.i >= lines.length) return null;
	const value = parseBlock(p, indentOf(lines[p.i].raw));
	skipBlank(p);
	if (p.i < lines.length) throw new YamlError(`line ${lines[p.i].n}: unexpected content`);
	return value;
}

const indentOf = (raw) => raw.length - raw.trimStart().length;

function stripComment(line) {
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(line[i - 1]))) {
			quote = c;
		} else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
			return line.slice(0, i).trimEnd();
		}
	}
	return line.trimEnd();
}

function skipBlank(p) {
	while (p.i < p.lines.length && stripComment(p.lines[p.i].raw).trim() === '') p.i++;
}

function parseBlock(p, indent) {
	skipBlank(p);
	const first = stripComment(p.lines[p.i].raw).trimStart();
	return first.startsWith('- ') || first === '-' ? parseSeq(p, indent) : parseMap(p, indent);
}

function parseMap(p, indent) {
	const map = {};
	while (true) {
		skipBlank(p);
		if (p.i >= p.lines.length) return map;
		const line = p.lines[p.i];
		const ind = indentOf(line.raw);
		if (ind < indent) return map;
		if (ind > indent) throw new YamlError(`line ${line.n}: unexpected indentation`);
		const text = stripComment(line.raw).trimStart();
		const m = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?):(?:\s+(.*))?$/.exec(text);
		if (!m) throw new YamlError(`line ${line.n}: expected "key: value"`);
		const key = unquote(m[1]);
		if (Object.hasOwn(map, key)) throw new YamlError(`line ${line.n}: duplicate key ${key}`);
		p.i++;
		map[key] = valueAfter(p, m[2], ind, line);
	}
}

function parseSeq(p, indent) {
	const seq = [];
	while (true) {
		skipBlank(p);
		if (p.i >= p.lines.length) return seq;
		const line = p.lines[p.i];
		const ind = indentOf(line.raw);
		const text = stripComment(line.raw).trimStart();
		if (ind < indent || !(text.startsWith('- ') || text === '-')) return seq;
		if (ind > indent) throw new YamlError(`line ${line.n}: unexpected indentation`);
		const rest = text.slice(1).trimStart();
		if (rest === '') {
			p.i++;
			seq.push(parseBlock(p, indentOf(p.lines[p.i].raw)));
		} else if (/^[^\s:'"[{][^:]*?:(\s|$)/.test(rest) || /^("[^"]*"|'[^']*'):(\s|$)/.test(rest)) {
			// "- key: value" starts a mapping whose keys align with "key".
			const inner = ind + (text.length - rest.length);
			p.lines[p.i] = { n: line.n, raw: ' '.repeat(inner) + rest };
			seq.push(parseMap(p, inner));
		} else {
			p.i++;
			seq.push(scalar(rest, line));
		}
	}
}

function valueAfter(p, rest, indent, line) {
	if (rest === undefined || rest === '') {
		skipBlank(p);
		if (p.i >= p.lines.length) return null;
		const next = indentOf(p.lines[p.i].raw);
		const nextText = stripComment(p.lines[p.i].raw).trimStart();
		if (next > indent || (next === indent && nextText.startsWith('- '))) return parseBlock(p, next);
		return null;
	}
	if (/^[|>][-+]?$/.test(rest)) return blockScalar(p, indent, rest[0]);
	return scalar(rest, line);
}

function blockScalar(p, indent, style) {
	const out = [];
	let blockIndent = null;
	while (p.i < p.lines.length) {
		const raw = p.lines[p.i].raw;
		if (raw.trim() === '') {
			out.push('');
			p.i++;
			continue;
		}
		const ind = indentOf(raw);
		if (ind <= indent) break;
		blockIndent ??= ind;
		out.push(raw.slice(blockIndent));
		p.i++;
	}
	while (out.length && out[out.length - 1] === '') out.pop();
	return style === '|' ? `${out.join('\n')}\n` : `${out.join(' ')}\n`;
}

function unquote(s) {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}

/** Splits a flow collection's content at top-level commas. */
function splitFlow(s) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === ',' && depth === 0) {
			parts.push(s.slice(start, i).trim());
			start = i + 1;
		}
	}
	const last = s.slice(start).trim();
	if (last) parts.push(last);
	return parts;
}

function scalar(text, line) {
	const s = text.trim();
	if (s.startsWith('[')) {
		if (!s.endsWith(']')) throw new YamlError(`line ${line.n}: multi-line flow sequence`);
		return splitFlow(s.slice(1, -1)).map((x) => scalar(x, line));
	}
	if (s.startsWith('{')) {
		if (!s.endsWith('}')) throw new YamlError(`line ${line.n}: multi-line flow mapping`);
		const map = {};
		for (const part of splitFlow(s.slice(1, -1))) {
			const m = /^("[^"]*"|'[^']*'|[^:]+?):\s*(.*)$/.exec(part);
			if (!m) throw new YamlError(`line ${line.n}: bad flow mapping entry ${part}`);
			map[unquote(m[1].trim())] = scalar(m[2], line);
		}
		return map;
	}
	return unquote(s);
}
