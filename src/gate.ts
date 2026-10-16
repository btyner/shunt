/**
 * Decides whether a `read` or `bash` call would pull a large file into context whole.
 *
 * Port of shunt's check-file-size / check-bash-read hooks. Anything that is not
 * provably a full-file dump of an existing local text file is allowed through:
 * the gate exists to redirect bulk reads, not to second-guess every tool call.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MIN_LINES = 350;

/** Bytes sniffed for a NUL to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8192;
const COUNT_CHUNK_BYTES = 1 << 16;
/** `head`/`tail` with no count print this many lines. */
const HEAD_TAIL_DEFAULT_LINES = 10;

export interface BulkRead {
	/** Files as written in the call. */
	files: string[];
	lines: number;
}

/** `SHUNT_MIN_LINES`, falling back to the default when unset or non-numeric. */
export function minLines(raw: string | undefined = process.env.SHUNT_MIN_LINES): number {
	return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MIN_LINES;
}

export function resolvePath(file: string, cwd: string): string {
	if (file === "~") return os.homedir();
	if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
	return path.resolve(cwd, file);
}

/**
 * Newline count (`wc -l` semantics) of a regular text file; `undefined` for
 * anything missing, non-regular, unreadable, or binary.
 */
export function countTextLines(file: string): number | undefined {
	let fd: number;
	try {
		if (!fs.statSync(file).isFile()) return undefined;
		fd = fs.openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const buf = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
		let lines = 0;
		let first = true;
		for (;;) {
			const n = fs.readSync(fd, buf, 0, buf.length, null);
			if (n === 0) return lines;
			const chunk = buf.subarray(0, n);
			if (first && chunk.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
			first = false;
			for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
		}
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const RANGE = String.raw`L?\d+(?:(?:-|\.\.|\+)L?\d*)?`;
/** One trailing OMP read selector: `:raw`, `:img`, `:conflicts`, `:-N`, or line ranges. */
const SELECTOR = new RegExp(String.raw`:(raw|img|conflicts|-\d+|${RANGE}(?:,${RANGE})*)$`);

/**
 * OMP `read` takes a single `path` with optional trailing selectors. A line
 * range (or `:img`/`:conflicts`) is a targeted read and always passes; a bare
 * path or bare `:raw` asks for the whole file.
 */
export function checkRead(rawPath: unknown, cwd: string, threshold: number): BulkRead | undefined {
	if (typeof rawPath !== "string" || rawPath === "" || URL_LIKE.test(rawPath)) return undefined;

	// OMP prefers an existing literal filename over selector interpretation.
	let base = rawPath;
	if (!fs.existsSync(resolvePath(rawPath, cwd))) {
		for (let match = SELECTOR.exec(base); match; match = SELECTOR.exec(base)) {
			if (match[1] !== "raw") return undefined;
			base = base.slice(0, match.index);
		}
	}

	const lines = countTextLines(resolvePath(base, cwd));
	return lines !== undefined && lines > threshold ? { files: [base], lines } : undefined;
}

const READ_COMMANDS: Record<string, true> = { cat: true, head: true, tail: true, less: true, more: true };

function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	for (const m of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) tokens.push(m[1] ?? m[2] ?? m[3]);
	return tokens;
}

/** Lines `head`/`tail` will print, or `undefined` when they print bytes or follow. */
function headTailLines(command: string, args: string[], fileLines: number): number | undefined {
	let count = HEAD_TAIL_DEFAULT_LINES;
	let fromStart: number | undefined;
	const setCount = (value: string | undefined) => {
		if (value === undefined) return;
		if (command === "tail" && value.startsWith("+")) fromStart = Number(value.slice(1));
		else count = Number(value);
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (/^(?:-[cfF]|--bytes|--follow)/.test(arg)) return undefined;
		if (arg === "-n" || arg === "--lines") setCount(args[++i]);
		else if (/^-n[+\d]/.test(arg)) setCount(arg.slice(2));
		else if (arg.startsWith("--lines=")) setCount(arg.slice(8));
		else if (/^-\d+$/.test(arg)) setCount(arg.slice(1));
	}
	if (fromStart !== undefined) return Math.max(0, fileLines - Math.max(fromStart, 1) + 1);
	return Number.isNaN(count) ? undefined : Math.min(count, fileLines);
}

/**
 * Catches `cat`/`head`/`tail`/`less`/`more` dumping a large file. Pipes and
 * redirections are allowed (filtered or not entering context); compound
 * commands are checked per `&&`/`;`/newline segment.
 */
export function checkBash(command: unknown, cwd: string, threshold: number): BulkRead | undefined {
	if (typeof command !== "string" || /[|>]/.test(command)) return undefined;

	for (const segment of command.split(/&&|;|\n/)) {
		const [name, ...args] = tokenize(segment.trim());
		if (!name || !Object.hasOwn(READ_COMMANDS, name)) continue;

		// Skip flags, and for head/tail the separate value token of `-n N` / `--lines N`.
		const headTail = name === "head" || name === "tail";
		const files = args.filter(
			(arg, i) => !arg.startsWith("-") && !(headTail && (args[i - 1] === "-n" || args[i - 1] === "--lines")),
		);
		let total = 0;
		const hit: string[] = [];
		for (const file of files) {
			const fileLines = countTextLines(resolvePath(file, cwd));
			if (fileLines === undefined) continue;
			const printed = headTail ? headTailLines(name, args, fileLines) : fileLines;
			if (printed === undefined) continue;
			total += printed;
			hit.push(file);
		}
		if (total > threshold) return { files: hit, lines: total };
	}
	return undefined;
}
