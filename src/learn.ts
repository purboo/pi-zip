// What the prompt cache costs and how long it lives, learned from the provider's own usage reports. Counts only, never content.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Any, clamp } from "./util.ts";

/** explicit: the provider reports cacheWrite (a write premium, Anthropic style); automatic: it never does (prefix cache, writes cost input). */
export type CacheClass = "explicit" | "automatic";

/** Prices of one prefix token ($/M): r = cache read, w = rewrite, out = output. */
export interface Prices { r: number; w: number; input: number; out: number; cls: CacheClass; src: "model.cost" | "class default" }

/** Price ratios to input when the model declares none (Anthropic list prices; GLM-like automatic caches). */
export const CLASS_RATIOS: Record<CacheClass, { r: number; w: number }> = { explicit: { r: 0.1, w: 1.25 }, automatic: { r: 0.2, w: 1 } };

/** model.cost when sane (input > 0, cacheRead <= input), else the class ratios. w: explicit = cacheWrite of the live tier (1h tier: 2 x input),
 *  automatic = input. Before the first response the class is guessed from model.cost; nothing known at all = null (the legacy rule). */
export function lawPrices(model: Any, cls: CacheClass | undefined, longTier: boolean): Prices | null {
	const c = model?.cost;
	const sane = c?.input > 0 && !(c.cacheRead > c.input);
	const k: CacheClass | undefined = cls ?? (sane ? (c.cacheWrite > 0 ? "explicit" : "automatic") : undefined);
	if (!k) return null;
	const input = sane ? c.input : 1;
	const d = CLASS_RATIOS[k];
	const r = sane && c.cacheRead > 0 ? c.cacheRead : d.r * input;
	const w = k === "automatic" ? input : longTier ? 2 * input : sane && c.cacheWrite > 0 ? c.cacheWrite : d.w * input;
	return { r, w, input, out: sane && c.output > 0 ? c.output : 4 * w, cls: k, src: sane ? "model.cost" : "class default" };
}

// ---- cache survival ------------------------------------------------------------------------------------------------
/** Gap bins (s): [GAP_EDGES[i], GAP_EDGES[i+1]). Edges sit on the known TTL tiers (300 s, 3600 s): a deterministic TTL never splits a bin. */
export const GAP_EDGES = [30, 60, 120, 180, 240, 300, 330, 360, 420, 480, 600, 900, 1200, 1800, 2700, 3600, 5400];
export const HALF_LIFE = 16; // observations per bin: old evidence counts half after 16 newer ones in the same bin (a provider may change its TTL)
// The declared TTL as pseudo-observations. Asymmetric because the signal is: a read of the re-sent prefix cannot happen on a dead cache,
// but warm misses do (GLM 4-9%, glm-flash ~22%, research round 5). Beyond the TTL one clean read overrides it (weight 1/4: one hit -> 0.8);
// inside it a lone miss does not (weight 2: one miss -> 0.67, two -> 0.5, three -> 0.4). Otherwise one random miss flips a warm bin to
// dead, the next returns there fold, and a miss right after a fold is censored: nothing would ever correct it (live smoke, glm-5.3-flash).
const PRIOR_WEIGHT = { alive: 2, dead: 0.25 };
export const MIN_EXPECT = 8192; // prefix tokens a sample needs: far above the shared system prefix (~2.4K) other sessions keep warm

export interface Entry { cls?: CacheClass; bins: Record<string, [number, number]>; n: number } // bin index -> [alive, dead] (decayed counts)
interface File { v: 1; models: Record<string, Entry> }

export const statsPath = (): string =>
	process.env.PI_ZIP_CACHE_STATS || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-zip", "cache-survival.json");

export const binOf = (gapS: number): number => GAP_EDGES.findLastIndex((e) => gapS >= e); // -1 = below 30 s: not recorded
const fin = (x: Any) => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** The persisted stats; a missing, unreadable or malformed file is ignored (empty). */
export function loadStats(path = statsPath()): File {
	try {
		const j = JSON.parse(readFileSync(path, "utf8"));
		const out: File = { v: 1, models: {} };
		if (j?.v !== 1 || typeof j.models !== "object" || !j.models) return out;
		for (const [k, e] of Object.entries<Any>(j.models)) {
			const bins: Entry["bins"] = {};
			for (const [b, c] of Object.entries<Any>(e?.bins ?? {})) if (GAP_EDGES[Number(b)] !== undefined && Array.isArray(c) && fin(c[0]) && fin(c[1])) bins[b] = [c[0], c[1]];
			out.models[k] = { bins, n: fin(e?.n) ? e.n : 0, ...(e?.cls === "explicit" || e?.cls === "automatic" ? { cls: e.cls } : {}) };
		}
		return out;
	} catch {
		return { v: 1, models: {} };
	}
}

/** Was the cache alive after the gap? `expect` = prefix tokens this request re-sent unchanged (the previous prompt, or the untouched prefix
 *  before our first edit), `total` = this prompt. null = censored: too small to tell, the prompt shrank under someone else's edit, or a miss
 *  right after our own edit (a breakpoint cache does not look that far back; an automatic one may hold only the shared system prefix). */
export function sample(expect: number, cacheRead: number, total = Infinity, edited = false): boolean | null {
	const e = Math.min(expect, total);
	if (!(e >= MIN_EXPECT)) return null;
	if (cacheRead >= 0.5 * e) return true;
	return total >= expect && !edited ? false : null;
}

/** Fold one response into the stats (re-read, update, atomic write: concurrent sessions share the file). Returns the model's entry. */
export function record(key: string, u: { explicit: boolean; total: number; gapS?: number; alive?: boolean | null }, path = statsPath()): Entry {
	const f = loadStats(path);
	const e = (f.models[key] ??= { bins: {}, n: 0 });
	let dirty = false;
	if (u.explicit && e.cls !== "explicit") (e.cls = "explicit"), (dirty = true); // sticky: a write premium once reported stays
	else if (!e.cls && u.total >= 2048) (e.cls = "automatic"), (dirty = true);
	const b = u.gapS !== undefined && typeof u.alive === "boolean" ? binOf(u.gapS) : -1;
	if (b >= 0) {
		const decay = 2 ** (-1 / HALF_LIFE);
		const [a, d] = e.bins[b] ?? [0, 0];
		e.bins[b] = [+(a * decay + (u.alive ? 1 : 0)).toFixed(3), +(d * decay + (u.alive ? 0 : 1)).toFixed(3)];
		e.n++;
		dirty = true;
	}
	if (dirty) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(f));
			renameSync(tmp, path);
		} catch {}
	}
	return e;
}

/** Monotone (non-increasing in the gap) survival per observed bin: (alive + m x prior) / (n + m), pooled adjacent violators. */
export function curve(e: Entry | undefined, priorS: number): { bin: number; p: number; n: number }[] {
	const pts = Object.entries(e?.bins ?? {}).map(([b, [a, d]]) => {
		const i = Number(b), mid = Math.sqrt(GAP_EDGES[i] * (GAP_EDGES[i + 1] ?? 2 * GAP_EDGES[i])), pi = mid <= priorS ? 1 : 0;
		const m = pi ? PRIOR_WEIGHT.alive : PRIOR_WEIGHT.dead;
		return { bins: [i], p: (a + m * pi) / (a + d + m), w: a + d + m };
	}).sort((x, y) => x.bins[0] - y.bins[0]);
	const st: typeof pts = [];
	for (const q of pts) {
		st.push(q);
		while (st.length > 1 && st[st.length - 2].p < st[st.length - 1].p) {
			const y = st.pop()!, x = st.pop()!;
			st.push({ bins: [...x.bins, ...y.bins], p: (x.p * x.w + y.p * y.w) / (x.w + y.w), w: x.w + y.w });
		}
	}
	return st.flatMap((q) => q.bins.map((bin) => ({ bin, p: q.p, n: (e!.bins[bin][0] + e!.bins[bin][1]) })));
}

/** P(the cache survived a gap of gapS). Observed bin: its monotone estimate. Otherwise the declared TTL (cold start = today's rule), clamped
 *  between the nearest observed bins below and above (an alive read at 365 s makes every shorter gap warm; a miss makes longer ones dead). */
export function pWarm(e: Entry | undefined, gapS: number, priorS: number): { p: number; src: "prior" | "learned" } {
	const prior = gapS <= priorS ? 1 : 0;
	const c = curve(e, priorS), b = binOf(gapS);
	const at = c.find((x) => x.bin === b);
	if (at) return { p: at.p, src: "learned" };
	const hi = c.filter((x) => x.bin < b).at(-1)?.p ?? 1, lo = c.find((x) => x.bin > b)?.p ?? 0;
	const p = clamp(prior, lo, hi);
	return { p, src: p === prior ? "prior" : "learned" };
}

/** /zip status text: class and the learned curve ("360-420s 0.80 n1"). */
export function describe(e: Entry | undefined, priorS: number): string {
	const c = curve(e, priorS);
	const bins = c.map((x) => `${GAP_EDGES[x.bin]}-${GAP_EDGES[x.bin + 1] ?? "∞"}s ${x.p.toFixed(2)} n${Math.round(x.n * 10) / 10}`).join(", ");
	return `survival ${bins || `none learned yet (declared TTL ${Math.round(priorS)} s)`} · ${e?.n ?? 0} sample${e?.n === 1 ? "" : "s"}`;
}
