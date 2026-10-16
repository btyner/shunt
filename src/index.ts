/**
 * shunt for OMP: keep I/O-heavy work out of the main context.
 *
 * Two layers, ported from spotify/portal-ai-plugins `shunt`:
 * 1. A `tool_call` gate blocks full-file `read`s and `cat`/`head`/`tail`/`less`/`more`
 *    dumps of large files and redirects to `bulk_read` (or a ranged read).
 * 2. `bulk_read` / `code_write` tools delegate to a cheaper one-shot worker model;
 *    their descriptions carry the when/when-not guidance upstream kept in skills.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type BulkRead, checkBash, checkRead, countTextLines, minLines, resolvePath } from "./gate";
import { DEFAULT_WORKER_MODEL, formatFooter, loadMode, runWorker } from "./worker";

const MODE_HELP =
	"Worker mode (system prompt + model) by name. Custom modes live in .omp/shunt/modes/<name>.md (project) or ~/.omp/agent/shunt/modes/<name>.md (user) and shadow built-ins.";

/** Reads each path as text, failing loudly: a typo'd path must not yield a confident answer about nothing. */
function wrapFiles(paths: string[], cwd: string): string {
	let out = "";
	for (const file of paths) {
		const abs = resolvePath(file, cwd);
		if (countTextLines(abs) === undefined) throw new Error(`file not found, unreadable, or binary: ${file}`);
		out += `<file path="${file}">\n${fs.readFileSync(abs, "utf8")}\n</file>\n\n`;
	}
	return out;
}

function blockReason(hit: BulkRead, threshold: number, hint: string): string {
	const what = hit.files.length === 1 ? `${hit.files[0]} is ${hit.lines} lines` : `${hit.files.join(", ")} total ${hit.lines} lines`;
	return `shunt: ${what} (threshold ${threshold}). Don't pull it into context whole. To understand or summarize it, call bulk_read with your question and the paths — only the answer comes back. If you need exact text to edit, ${hint}`;
}

export default function shunt(pi: ExtensionAPI) {
	const z = pi.zod;
	const agentDir = pi.pi.getAgentDir();

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || process.env.SHUNT_MODEL || !ctx.model) return;
		const worker = ctx.models.resolve(DEFAULT_WORKER_MODEL);
		if (worker && worker.provider === ctx.model.provider && worker.id === ctx.model.id) {
			ctx.ui.notify(
				`shunt: worker model ${DEFAULT_WORKER_MODEL} resolves to the session model (${worker.provider}/${worker.id}). Set modelRoles.smol or SHUNT_MODEL to a cheaper model; context savings still apply.`,
				"warning",
			);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read" && event.toolName !== "bash") return;
		// Restricted sessions may not carry bulk_read; don't block toward a tool that isn't there.
		if (!pi.getActiveTools().includes("bulk_read")) return;

		const threshold = minLines();
		if (event.toolName === "read") {
			const hit = checkRead(event.input.path, ctx.cwd, threshold);
			if (hit) {
				return {
					block: true,
					reason: blockReason(hit, threshold, `read only the range you need, e.g. ${hit.files[0]}:1-200.`),
				};
			}
			return;
		}

		const cwd = typeof event.input.cwd === "string" ? path.resolve(ctx.cwd, event.input.cwd) : ctx.cwd;
		const hit = checkBash(event.input.command, cwd, threshold);
		if (hit) {
			return {
				block: true,
				reason: blockReason(hit, threshold, `use read with a line range (e.g. ${hit.files[0]}:1-200) instead of a shell dump.`),
			};
		}
	});

	pi.registerTool({
		name: "bulk_read",
		label: "Bulk Read",
		description: [
			"Delegate reading to a cheaper one-shot worker model; only its answer enters your context, never the file contents.",
			"Use for: understanding files over ~350 lines, questions spanning 3+ files, summarizing large diffs or logs.",
			"Each call is independent: to follow up, call again with the same paths — re-sending files costs the worker, not you.",
			"Do NOT use for debugging, editing (you need exact text: read the needed line range instead), small files, or architectural judgment.",
			"Verify specific line numbers or exact values with a ranged read before using them in edits.",
		].join("\n"),
		parameters: z.object({
			question: z.string().describe("What you need to know. Be specific; the worker answers only this."),
			paths: z.array(z.string()).describe("Text files to send to the worker (relative to cwd or absolute)."),
			mode: z.string().optional().describe(`${MODE_HELP} Default: bulk-reader.`),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.question.trim()) throw new Error("question is required");
			if (params.paths.length === 0) throw new Error("paths is required");
			const mode = loadMode(params.mode ?? "bulk-reader", ctx.cwd, agentDir);
			const message = `${wrapFiles(params.paths, ctx.cwd)}Question: ${params.question}\n`;

			const result = await runWorker(ctx, mode, message, signal);
			const truncation = result.truncated ? "\n[shunt: answer hit the worker's output limit; ask a narrower question]" : "";
			return {
				content: [{ type: "text", text: `${result.text}${truncation}\n\n${formatFooter(mode, result)}` }],
				details: {
					mode: mode.name,
					modeSource: mode.source,
					model: `${result.model.provider}/${result.model.id}`,
					usage: result.usage,
					paths: params.paths,
					inputBytes: Buffer.byteLength(message),
				},
			};
		},
	});

	pi.registerTool({
		name: "code_write",
		label: "Code Write",
		description: [
			"Delegate boilerplate generation (tests, config, docstrings, type stubs, fixtures — anything >80% predictable from existing files) to a cheaper one-shot worker model.",
			"With target, the output is written straight to disk and only a line count comes back, so the generated code never enters your context.",
			"references is required: files whose patterns the output must match plus any input it depends on (e.g. an existing test and the source under test). Without them the worker writes context-free code that fits nothing.",
			"Each call is independent: to build on a previous result, pass that file as a reference.",
			"Afterwards, review the result with ranged reads and make surgical edits for the parts that need judgment.",
		].join("\n"),
		parameters: z.object({
			spec: z.string().describe("What to generate."),
			references: z.array(z.string()).describe("Files to match patterns against and that the output depends on."),
			target: z.string().optional().describe("Write the output to this path (created or overwritten). Omit to return the code."),
			mode: z.string().optional().describe(`${MODE_HELP} Default: code-writer.`),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.spec.trim()) throw new Error("spec is required");
			if (params.references.length === 0) {
				throw new Error(
					"references is required — pass a file whose patterns the output should match. For a follow-up, reference the file the previous call generated.",
				);
			}
			const mode = loadMode(params.mode ?? "code-writer", ctx.cwd, agentDir);
			const message = `Spec: ${params.spec}\n\nReference files:\n${wrapFiles(params.references, ctx.cwd)}`;

			const result = await runWorker(ctx, mode, message, signal);
			// Truncated code written to disk is worse than none.
			if (result.truncated) {
				throw new Error(
					`shunt: ${mode.name} output hit the worker's output limit; nothing was written. Split the spec into smaller calls.`,
				);
			}
			// Models sometimes wrap the whole file in a fence despite instructions; unwrap only that outer fence.
			const code = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(result.text)?.[1] ?? result.text;
			const footer = formatFooter(mode, result);
			const details = {
				mode: mode.name,
				modeSource: mode.source,
				model: `${result.model.provider}/${result.model.id}`,
				usage: result.usage,
				references: params.references,
				target: params.target,
			};

			if (params.target === undefined) return { content: [{ type: "text", text: `${code}\n\n${footer}` }], details };

			const abs = resolvePath(params.target, ctx.cwd);
			const existed = fs.existsSync(abs);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, code.endsWith("\n") ? code : `${code}\n`);
			const lines = code.split("\n").length;
			return {
				content: [
					{ type: "text", text: `${existed ? "Overwrote" : "Wrote"} ${params.target} (${lines} lines). Review it with ranged reads.\n${footer}` },
				],
				details,
			};
		},
	});
}
