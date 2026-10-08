// Cache temperature (F7): "cold" is a fact about real time, never a guess.
import { type Any, PRODUCT, envInt } from "./util.ts";

export const DEFAULT_TTL_MS = 300_000;

export type CacheRetention = "none" | "short" | "long";

/**
 * Lifetime of the prompt cache entry a request writes, mirroring Pi's getPromptCacheTtlMs (core/cache-warmer.js): the tier is the
 * request's cacheRetention, else "long" when PI_CACHE_RETENTION=long, else "short"; the model's promptCache holds SECONDS for
 * that tier only. Pi sends no explicit cacheRetention, so in practice the environment decides. "none" = no cache at all = 0.
 * A model that declares no lifetime for the tier gets fallbackMs. An explicit PI_ZIP_TTL_SECS (tests) wins in ttlFor.
 */
export function cacheTtlMs(
	pc: { short?: number; long?: number } | undefined,
	fallbackMs: number = DEFAULT_TTL_MS,
	opts: { cacheRetention?: CacheRetention; env?: Record<string, string | undefined> } = {},
): number {
	const env = opts.env ?? process.env;
	const retention: CacheRetention = opts.cacheRetention ?? (env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	if (retention === "none") return 0;
	const secs = pc?.[retention];
	return typeof secs === "number" && secs > 0 ? secs * 1000 : fallbackMs;
}

/**
 * TTL tier the provider really wrote, from the newest <=3 usable assistant messages of this model (real run, cacheWrite >= MIN_WRITE):
 * `usage.cacheWrite1h` (Anthropic, Bedrock) is the 1h share of `cacheWrite`. >= 50% -> "1h", ~0 -> "5m". The field absent (the API
 * does not report it) or a split in between = no evidence (undefined): the declared TTL stands. Relays may rewrite cache_control.
 */
const MIN_WRITE = 1024;
export function observedTier(branch: Any[], key: string): "1h" | "5m" | undefined {
	let w = 0, w1h = 0, seen = 0;
	for (let i = branch.length - 1; i >= 0 && seen < 3; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (m?.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted" || `${m.provider}/${m.model ?? ""}` !== key) continue;
		const u = m.usage;
		if (!(u?.cacheWrite >= MIN_WRITE)) continue;
		seen++;
		if (typeof u.cacheWrite1h === "number") (w += u.cacheWrite), (w1h += u.cacheWrite1h);
	}
	return !w ? undefined : w1h >= w / 2 ? "1h" : w1h < w * 0.05 ? "5m" : undefined;
}

export interface TtlInfo { ms: number; source: "declared" | "observed"; note?: string }

/** Declared TTL, corrected by what the provider was seen to write. PI_ZIP_TTL_SECS wins. `note` = the one-time mismatch notice text. */
export function resolveTtl(model: Any, branch: Any[] = []): TtlInfo {
	if (process.env.PI_ZIP_TTL_SECS) return { ms: envInt("TTL_SECS", 300) * 1000, source: "declared" };
	const pc = model?.promptCache;
	const declared = cacheTtlMs(pc);
	const long = process.env.PI_CACHE_RETENTION === "long";
	const seen = declared > 0 ? observedTier(branch, modelKey(model)) : undefined;
	const mismatch = (req: string, got: string, ms: number): TtlInfo => ({ ms, source: "observed", note: `${PRODUCT} · requested ${req} prompt cache, provider wrote ${got} · using ${got}` });
	if (long && seen === "5m") return mismatch("1h", "5m", cacheTtlMs(pc, DEFAULT_TTL_MS, { cacheRetention: "short" }));
	if (!long && seen === "1h" && pc?.long > 0) return mismatch("5m", "1h", pc.long * 1000);
	return { ms: declared, source: "declared" };
}

export const ttlFor = (model: Any, branch: Any[] = []): number => resolveTtl(model, branch).ms;

/** Cold = a prior request exists and nothing touched the cache for longer than the TTL. No prior request counts as warm. */
export const isColdByTtl = (lastActivityMs: number, nowMs: number, ttlMs: number): boolean => lastActivityMs > 0 && nowMs - lastActivityMs > ttlMs;

export const modelKey = (m: Any): string => (m ? `${m.provider ?? ""}/${m.id ?? m.model ?? ""}` : "");

const tsOf = (en: Any, inner?: Any): number => {
	const t = typeof inner?.timestamp === "number" ? inner.timestamp : Date.parse(en?.timestamp ?? "");
	return Number.isFinite(t) ? t : 0;
};

/**
 * Last time anything touched the cache, according to the branch: the newest message, or the newest cache-warm usage entry
 * (Pi's own idle refresh persists `{ type: "usage", kind: "cache_warm" }`, and a refresh keeps the entry alive for another TTL).
 * Fresh process: err on the warm side (0 = unknown).
 */
export function lastMessageMs(branch: Any[]): number {
	let last = 0;
	for (const en of branch) {
		if (en?.type === "message" && en.message) last = Math.max(last, tsOf(en, en.message));
		else if (en?.type === "usage" && en.kind === "cache_warm") last = Math.max(last, tsOf(en));
	}
	return last;
}

/** The newest assistant message that really ran (errors and aborts may never have reached a cache): its provider/model and prompt size. */
export function lastPrompt(branch: Any[]): { key: string; total: number } {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.provider) {
			const u = m.usage;
			return { key: `${m.provider}/${m.model ?? ""}`, total: u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0 };
		}
	}
	return { key: "", total: 0 };
}
export const lastModelInBranch = (branch: Any[]): string => lastPrompt(branch).key;

export type Survival = (gapS: number, priorS: number) => { p: number; src: string };
export interface ColdInfo { cold: boolean; reason: string; ttl: TtlInfo; pWarm: number; src: string; gapS: number | null }

/** Cold by time, or because the model changed: a cache entry belongs to one provider and model. `learned` = P(warm) after a gap from the
 *  survival the provider was seen to have (learn.ts); without it, or under PI_ZIP_TTL_SECS (tests), the TTL decides. cold = P(warm) < 0.5. */
export function detectCold(model: Any, lastReqMs: number, branch: Any[], nowMs = Date.now(), lastModel = "", learned?: Survival): ColdInfo {
	const ttl = resolveTtl(model, branch);
	const last = Math.max(lastReqMs, lastMessageMs(branch));
	const prev = lastModel || lastModelInBranch(branch);
	if (last && prev && modelKey(model) && prev !== modelKey(model)) return { cold: true, reason: `model switch ${prev} -> ${modelKey(model)}`, ttl, pWarm: 0, src: "model switch", gapS: null };
	if (!last) return { cold: false, reason: "no prior request", ttl, pWarm: 1, src: "no prior request", gapS: null };
	const gapS = (nowMs - last) / 1000;
	const byTtl = isColdByTtl(last, nowMs, ttl.ms);
	const s = learned && !process.env.PI_ZIP_TTL_SECS ? learned(gapS, ttl.ms / 1000) : { p: byTtl ? 0 : 1, src: "prior" };
	const reason = `ttl gap ${Math.round(gapS)}s ${byTtl ? ">" : "<="} ${Math.round(ttl.ms / 1000)}s${s.src === "prior" ? "" : `, learned P(warm) ${s.p.toFixed(2)}`}`;
	return { cold: s.p < 0.5, reason, ttl, pWarm: s.p, src: s.src, gapS };
}
