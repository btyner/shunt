/**
 * One-shot delegation to a cheaper worker model.
 *
 * Replaces shunt's Portal CLI / AiKA transport: a "mode" is a named system
 * prompt (plus optional model and temperature), and each delegation is a
 * single stateless completion through OMP's own model registry and credentials.
 * Nothing is replayed between calls — re-sending files costs the worker, not
 * the caller's context.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_WORKER_MODEL = "@smol";
const DEFAULT_TIMEOUT_SECONDS = 180;
const MODE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export interface Mode {
	name: string;
	instructions: string;
	/** Model selector or role alias; falls back to `SHUNT_MODEL`, then `@smol`. */
	model?: string;
	temperature?: number;
	/** Where the mode came from: a file path or `builtin`. */
	source: string;
}

// Instructions match the upstream shunt README's AiKA mode definitions.
const BUILTIN_MODES: Record<string, Mode> = {
	"bulk-reader": {
		name: "bulk-reader",
		instructions:
			"You are a precise code analyst. Read the provided files and answer the question concisely. Output structured bullets only. No greetings, no prose, no preambles, no summaries. Lead every bullet with the exact name, type, or line number. Use nested bullets for details. Skip anything the caller did not ask for.",
		temperature: 0.2,
		source: "builtin",
	},
	"code-writer": {
		name: "code-writer",
		instructions:
			"You generate code files based on a spec and reference files. Match the existing patterns, conventions, naming, and style exactly. Output only the code — no explanations, no markdown fences unless asked. If the spec is ambiguous, make reasonable choices that match the patterns in the reference code.",
		temperature: 0.2,
		source: "builtin",
	},
};

function parseModeFile(name: string, file: string): Mode {
	const text = fs.readFileSync(file, "utf8");
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	const meta: unknown = fm ? Bun.YAML.parse(fm[1]) : {};
	const instructions = (fm ? text.slice(fm[0].length) : text).trim();
	if (!instructions) throw new Error(`shunt mode ${file} has no instructions body`);

	const mode: Mode = { name, instructions, source: file };
	if (meta && typeof meta === "object") {
		if ("model" in meta && meta.model !== undefined) {
			if (typeof meta.model !== "string") throw new Error(`shunt mode ${file}: model must be a string`);
			mode.model = meta.model;
		}
		if ("temperature" in meta && meta.temperature !== undefined) {
			if (typeof meta.temperature !== "number") throw new Error(`shunt mode ${file}: temperature must be a number`);
			mode.temperature = meta.temperature;
		}
	}
	return mode;
}

export function loadMode(rawName: string, cwd: string, agentDir: string): Mode {
	const name = rawName.trim().toLowerCase();
	// Project modes shadow user modes, which shadow built-ins.
	const dirs = [path.join(cwd, ".omp", "shunt", "modes"), path.join(agentDir, "shunt", "modes")];
	if (MODE_NAME.test(name)) {
		for (const dir of dirs) {
			const file = path.join(dir, `${name}.md`);
			if (fs.existsSync(file)) return parseModeFile(name, file);
		}
		if (Object.hasOwn(BUILTIN_MODES, name)) return BUILTIN_MODES[name];
	}

	const available = new Set(Object.keys(BUILTIN_MODES));
	for (const dir of dirs) {
		const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
		for (const entry of entries) if (entry.endsWith(".md")) available.add(entry.slice(0, -3));
	}
	throw new Error(`Unknown shunt mode "${rawName}". Available: ${[...available].sort().join(", ")}`);
}

export interface WorkerResult {
	text: string;
	model: Model;
	usage: Usage;
	/** The worker hit its output-token limit. */
	truncated: boolean;
}

export async function runWorker(
	ctx: ExtensionContext,
	mode: Mode,
	message: string,
	signal: AbortSignal | undefined,
): Promise<WorkerResult> {
	const spec = mode.model ?? process.env.SHUNT_MODEL ?? DEFAULT_WORKER_MODEL;
	const model = ctx.models.resolve(spec);
	if (!model) throw new Error(`shunt: no available model matches "${spec}" (set SHUNT_MODEL or the mode's model)`);
	const rawTimeout = process.env.SHUNT_TIMEOUT_SECONDS;
	const timeoutSeconds = rawTimeout && /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : DEFAULT_TIMEOUT_SECONDS;
	const timeout = AbortSignal.timeout(timeoutSeconds * 1000);

	const response = await completeSimple(
		model,
		{ systemPrompt: mode.instructions, messages: [{ role: "user", content: message, timestamp: Date.now() }] },
		{
			apiKey: await ctx.modelRegistry.getApiKey(model),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			temperature: mode.temperature,
			maxTokens: model.maxTokens,
			// The breakpoint lands after the question, so a follow-up with a new question never
			// reads the entry: cache writes would only add their premium to every one-shot call.
			cacheRetention: "none",
		},
	);

	const label = `${model.provider}/${model.id}`;
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		if (timeout.aborted) {
			throw new Error(
				`shunt: ${mode.name} on ${label} exceeded ${timeoutSeconds}s. Raise SHUNT_TIMEOUT_SECONDS or split the work into smaller calls.`,
			);
		}
		throw new Error(`shunt: ${mode.name} on ${label} failed: ${response.errorMessage ?? response.stopReason}`);
	}

	const text = response.content
		.flatMap(block => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
	if (!text) throw new Error(`shunt: ${mode.name} on ${label} returned no text`);

	return { text, model, usage: response.usage, truncated: response.stopReason === "length" };
}

export function formatFooter(mode: Mode, result: WorkerResult): string {
	const { usage, model } = result;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const cached = usage.cacheRead > 0 ? ` (${usage.cacheRead} cached)` : "";
	const cost = usage.cost.total > 0 ? ` · $${usage.cost.total.toFixed(4)}` : "";
	return `[shunt: ${mode.name} via ${model.provider}/${model.id} · ${input} in${cached} / ${usage.output} out tokens${cost}]`;
}
