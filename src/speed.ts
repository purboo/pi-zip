// Speed policy: pure pressure, frozen candidate identity, and conservative cut validation.
import { createHash } from "node:crypto";
import { validateEdits } from "./guard.ts";
import { buildBlocks, countUserTurns, toolCallIndex, sizeOf, type Block, type PlanResult, type Scale } from "./plan.ts";
import { piTokensOf, type Any } from "./util.ts";

export const zipMode = (): "speed" | "early" => process.env.PI_ZIP_MODE === "early" ? "early" : "speed";
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface SpeedStamp { identity: string; prefix: string; target: number }
export interface Pressure { N: number; T: number; P: number; reserve: number; keep: number }
const object = (v: Any) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: Any) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const percentile = (xs: number[], q: number, fallback: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1] : fallback;

/** Pi's ordinary value is validated even when a valid model override shadows it. Fail closed on malformed shapes. */
export function pressure(model: Any, settings: Any, deltas: number[] = [], velocity = 250, durations: number[] = []): Pressure | null {
	if (settings !== undefined && !object(settings)) return null;
	if (!model || model.api === "pi-virtual" || !integer(model.contextWindow) || model.contextWindow === 0) return null;
	const c = settings?.compaction;
	if (c !== undefined && !object(c)) return null;
	if (c?.enabled !== undefined && typeof c.enabled !== "boolean" || c?.enabled === false) return null;
	const overrides = c?.modelOverrides;
	if (overrides !== undefined && !object(overrides)) return null;
	const entry = overrides?.[`${model.provider}/${model.id}`];
	if (entry !== undefined && !object(entry)) return null;
	for (const field of ["reserveTokens", "keepRecentTokens"]) {
		if (c?.[field] !== undefined && !integer(c[field]) || entry?.[field] !== undefined && !integer(entry[field])) return null;
	}
	const reserve = entry?.reserveTokens ?? c?.reserveTokens ?? 16_384, keep = entry?.keepRecentTokens ?? c?.keepRecentTokens ?? 20_000;
	const N = model.contextWindow - reserve;
	if (N <= 0) return null;
	const T = N - Math.min(8192, Math.floor(.05 * N));
	const g = Math.max(2500, percentile(deltas.slice(-20).filter(n => n > 0), .9, 2500));
	const d = Math.min(240, Math.max(60, percentile(durations.slice(-20), .95, 60)) + 5);
	const L = Math.min(T - Math.floor(N / 2), Math.max(16384, Math.ceil(Math.max(250, velocity) * d) + 2 * g));
	return { N, T, P: T - L, reserve, keep };
}

export const prefixDigest = (blocks: Block[], cut: number) => digest(blocks.slice(0, cut).map(b => [b.entryId, b.msg, b.raw, b.edited]));

/** No deeper cut: the existing guard keeps the last two requests as complete messages. */
export function safeCut(blocks: Block[], cut: number, model: Any): boolean {
	if (validateEdits(blocks, { folds: new Map(), cut }, countUserTurns(blocks))) return false;
	// An unfinished tool/reasoning turn must not acquire a changed prefix, even after all tool results arrived.
	const latestAssistant = [...blocks].reverse().find(b => b.kind === "assistant");
	if (latestAssistant?.msg.stopReason === "toolUse" || (latestAssistant?.msg.content ?? []).some((c: Any) => c.type === "toolCall")) return false;
	const last = [...blocks].reverse().find(b => b.msg?.role !== "system");
	if (!last || last.kind === "toolResult" || last.kind === "assistant" && last.msg.stopReason === "toolUse") return false;
	if (blocks.slice(cut).some(b => b.kind === "assistant" && ["error", "aborted"].includes(b.msg.stopReason))) return false;
	const bound = model.api === "anthropic-messages" || model.api === "bedrock-converse-stream";
	return !bound || !blocks.slice(cut).some(b => b.kind === "assistant" && (b.msg.content ?? []).some((c: Any) => c.type === "thinking" && (c.thinkingSignature || c.redacted)));
}

/** Include the whole system/tool overhead and use both Pi's estimate and the existing affine scale. */
export function afterSize(blocks: Block[], cut: number, summary: string, scale: Scale): number {
	const tail = blocks.slice(cut);
	return Math.ceil(Math.max(sizeOf(scale, tail.reduce((n, b) => n + b.tokens, 0) + Math.ceil(summary.length / 4)),
		scale.O + Math.ceil(summary.length / 4) + tail.reduce((n, b) => n + piTokensOf(b.msg), 0)));
}

/** No economic gate and no folds. All cut IDs already exist in the projected conversation. */
export function speedPlan(entries: Any[], model: Any, p: Pressure, scale: Scale, steerIds: Set<string>, identity: string, skip: ReadonlySet<string> = new Set()): PlanResult | null {
	const blocks = buildBlocks(entries, steerIds), users = countUserTurns(blocks);
	for (let cut = 1; cut < blocks.length; cut++) {
		if (blocks[cut].kind !== "user" || skip.has(blocks[cut].entryId!) || !safeCut(blocks, cut, model)) continue;
		const tail = blocks.slice(cut).reduce((n, b) => n + piTokensOf(b.msg), 0);
		if (tail < p.keep || afterSize(blocks, cut, " ".repeat(8000 * 4), scale) > p.P) continue;
		const prefix = blocks.slice(0, cut).reduce((n, b) => n + b.tokens, 0);
		return { blocks, calls: toolCallIndex(blocks), folds: [], cutIdx: cut, firstKeptEntryId: blocks[cut].entryId,
			prefixTokens: prefix, summaryTokensPlanned: 8000, sumTrigger: "valve", scale, userTurns: users,
			ctxTokens: sizeOf(scale, blocks.reduce((n, b) => n + b.tokens, 0)), ctxAfterFolds: sizeOf(scale, blocks.reduce((n, b) => n + b.tokens, 0)),
			speed: { identity, prefix: prefixDigest(blocks, cut), target: p.P } };
	}
	return null;
}
