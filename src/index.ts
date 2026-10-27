// pi-zip: keeps long Pi sessions cheap without losing anything. Wiring only; the logic lives in the sibling modules.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Any } from "./util.ts";
import { type NoticeData, registerZipCommand, renderNotice } from "./notice.ts";
import { RECALL_TOOL } from "./placeholder.ts";
import { registerRecallTool } from "./recall.ts";
import { parseRecallPath } from "./recallfile.ts";
import { NOTICE_CUSTOM, Zip } from "./run.ts";
import { markFirstLine, measure, recallCallLine, renderCard, renderState, setMeasure } from "./ui.ts";

export default function piZip(pi: ExtensionAPI) {
	if (process.env.PI_ZIP_OFF === "1") return; // test only: behave exactly as if not installed (registers nothing)
	const zip = new Zip(pi);
	import("@earendil-works/pi-coding-agent").then((m: Any) => { zip.version.pi = String(m?.VERSION ?? ""); }, () => {}); // Pi's version, for the version entry
	registerRecallTool(pi, zip); // stays registered even when off: earlier folds must stay recallable, and a tool-list change would bust the cache
	registerZipCommand(pi, zip);
	try {
		// Everything pi-zip shows lives in the transcript as custom entries (never part of the model's context): fold/summary
		// notices, state lines and the /zip card. Widths are measured with Pi's own pi-tui once it has loaded.
		import("@earendil-works/pi-tui").then((m: Any) => {
			if (typeof m?.visibleWidth === "function" && typeof m?.truncateToWidth === "function")
				setMeasure({ vw: m.visibleWidth, cut: (s: string, w: number) => (m.visibleWidth(s) <= w ? s : w <= 0 ? "" : m.truncateToWidth(s, w, "…")) });
		}, () => {});
		// A click on a notice toggles its detail, like Pi's own compaction row; ctrl+o (Pi's global expand) still wins: a click
		// only overrides the global state it was made under. Keyed by entry id because Pi rebuilds the component on every toggle.
		const clicked = new Map<string, { open: boolean; under: boolean }>();
		pi.registerEntryRenderer?.(NOTICE_CUSTOM, (entry: Any, o: Any, theme: Any) => {
			const d = entry?.data;
			if (!d?.text) return undefined;
			const global = !!o?.expanded;
			const key = typeof entry?.id === "string" ? entry.id : "";
			const open = () => {
				const c = key ? clicked.get(key) : undefined;
				return c && c.under === global ? c.open : global;
			};
			const expandable = d.v === 2 && d.kind !== "state" && d.kind !== "card" && !!(d.why || d.items?.length);
			return {
				render: (width: number) => {
					try {
						if (d.v !== 2) return [theme.fg("dim", measure.cut(d.text, width))];
						if (d.kind === "state") return renderState(d.word, d.reason ?? "", width, theme, measure);
						if (d.kind === "card" && d.card) return renderCard(d.card, width, theme, measure);
						// once the request that carried the plan is answered, "after" is its real size; a folds-only "before" (an estimate) is rescaled with it, a summary's (Pi's "Compacted from N tokens") kept
						const real = typeof d.reqTs === "number" ? zip.realSizeAfter(d.reqTs) : undefined;
						return renderNotice((real ? { ...d, after: real, before: d.after > 0 && !/summarized /.test(d.desc ?? "") ? Math.round((d.before * real) / d.after) : d.before } : d) as NoticeData, open(), width, theme, measure.vw);
					} catch {
						return [];
					}
				},
				handleMouse: (ev: Any) => {
					if (!expandable || !key || ev?.type !== "click" || ev?.button !== "left") return undefined;
					clicked.set(key, { open: !open(), under: global });
					return { handled: true, render: true };
				},
				invalidate: () => {},
			};
		});
		zip.entryRenderer = typeof pi.registerEntryRenderer === "function";
		// a folded output keeps its place in the transcript; its call row gets "ƶ zipped" right after its own text
		// Pi passes the component a renderCall returned last time back as context.lastComponent, and its own renderers update that
		// component in place and return it. So base gets the bare component back and each component keeps one wrapper: wrapping
		// the wrapper again on every streamed args update nested one Proxy per update (quadratic render time, a stack overflow).
		const bare = new WeakMap<object, object>(), wrapper = new WeakMap<object, object>(), now = new WeakMap<object, { id: string; theme: Any }>();
		const recallRows = new WeakSet<object>(); // our own rows: never handed to a built-in renderer to update
		pi.registerToolRenderer?.((toolName: string, next: () => Any) => {
			const base = next();
			if (toolName === RECALL_TOOL || typeof base?.renderCall !== "function") return base;
			return {
				...base,
				renderCall: (args: Any, theme: Any, c: Any) => {
					// file recall: a read or grep of a recall file (or of the session's recall directory) reads like zip_recall's row
					const ref = toolName === "read" || toolName === "grep" ? parseRecallPath(args?.path) : null;
					if (ref && (ref.handle || toolName === "grep")) {
						const off = typeof args.offset === "number" ? args.offset : undefined, lim = typeof args.limit === "number" ? args.limit : undefined;
						const range = toolName === "read" && (off !== undefined || lim !== undefined) ? `${off ?? 1}-${lim !== undefined ? (off ?? 1) + lim - 1 : ""}` : undefined;
						const a = { handle: ref.handle, grep: toolName === "grep" && typeof args.pattern === "string" ? args.pattern : undefined, range };
						const row = { render: (width: number) => recallCallLine(a, Math.max(1, width), theme, measure, (h) => zip.labelOf(h)), invalidate: () => {} };
						recallRows.add(row);
						return row;
					}
					const prev = c?.lastComponent && typeof c.lastComponent === "object" ? c.lastComponent : undefined;
					const mine = prev && (bare.has(prev) || recallRows.has(prev));
					const comp = base.renderCall(args, theme, mine ? { ...c, lastComponent: bare.get(prev) } : c);
					const id = c?.toolCallId;
					if (!comp || typeof comp.render !== "function" || typeof id !== "string") return comp;
					if (bare.has(comp)) return comp; // already a wrapper
					now.set(comp, { id, theme }); // what the wrapper marks with: the latest call and theme this component was rendered for
					const known = wrapper.get(comp);
					if (known) return known;
					const wrapped = new Proxy(comp, {
						get(t, p, r) {
							if (p !== "render") return Reflect.get(t, p, r);
							return (width: number) => {
								const lines = t.render(width);
								const cur = now.get(t) ?? { id, theme };
								const h = zip.foldedHandle(cur.id);
								try {
									return h ? markFirstLine(lines, h, width, cur.theme, measure) : lines;
								} catch {
									return lines;
								}
							};
						},
					});
					bare.set(wrapped, comp);
					wrapper.set(comp, wrapped);
					return wrapped;
				},
			};
		});
	} catch {
		/* older Pi: notices fall back to the status line */
	}
	// A tool allowlist (`pi --tools read,bash`, sub-agent launchers) replaces the whole selection and Pi then does not even register
	// zip_recall; folds of outputs the model could not get back would be lost, so only rereadable outputs fold then (plan rereadOnly)...
	// ... unless read, grep or bash is active: then folds are as in full mode and placeholders name a recall file (recallfile.ts) that the
	// tool_call hook below writes from the session when a tool asks for it.
	const checkRecall = (ctx: Any) => {
		try {
			const active = pi.getActiveTools?.();
			if (!Array.isArray(active)) return;
			const tools = { read: active.includes("read"), grep: active.includes("grep"), bash: active.includes("bash") };
			zip.setRecallMode(active.includes(RECALL_TOOL) ? "tool" : tools.read || tools.grep || tools.bash ? "file" : "reread", tools, ctx);
		} catch {
			/* never in the way */
		}
	};
	pi.on("session_start", (_e, ctx) => {
		const r = zip.sessionStart(ctx);
		checkRecall(ctx);
		zip.refreshFolded(ctx);
		zip.welcome(ctx);
		zip.armProducer(ctx);
		return r;
	});
	// a prompt (typed, or an extension's sendUserMessage): Pi is idle here and waits for the handler before it starts the run, so a
	// summary prepared while the user was away may go in through Pi's compaction; a steer or follow-up belongs to the running run
	pi.on("input", async (e, ctx) => {
		if (!e.streamingBehavior) {
			checkRecall(ctx);
			zip.refreshFolded(ctx); // the branch may have changed (/tree, fork)
		}
		await zip.input(e, ctx);
		return undefined;
	});
	// the run begins at agent_start, which always fires; before_agent_start says whose run it is (Pi 1.1.0 fires it for prompts only, 1.2.0
	// also for a run an extension's message starts with sendMessage and triggerTurn, as messageType "custom")
	pi.on("agent_start", (_e, ctx) => zip.agentStart(ctx));
	pi.on("agent_end", () => zip.agentEnd());
	pi.on("before_agent_start", async (e, ctx) => {
		checkRecall(ctx);
		zip.refreshFolded(ctx);
		await zip.beforeAgentStart(ctx, e);
		return undefined;
	});
	// answers only the compaction pi-zip itself just asked for; every other compaction (Pi's, /compact, other extensions') gets undefined
	pi.on("session_before_compact", (e, ctx) => zip.sessionBeforeCompact(e, ctx));
	pi.on("session_compact", (e, ctx) => zip.sessionCompacted(e, ctx));
	pi.on("session_compact_failed", () => zip.sessionCompactFailed());
	pi.on("context_with_system", (e, ctx) => zip.context(e, ctx)); // the complete transcript: system messages stay where Pi put them
	pi.on("turn_end", (e, ctx) => zip.turnEnd(e, ctx));
	pi.on("agent_before_settle", (e, ctx) => zip.settle(e, ctx));
	pi.on("before_provider_request", (e, ctx) => zip.providerRequest(e, ctx));
	pi.on("model_select", (e) => zip.modelSelect(e.model)); // a mid-run /model has no run start
	pi.on("tool_call", (e, ctx) => zip.toolCall(e, ctx)); // a recall file named by a built-in tool: this machine's copy, written on demand
	// Pi's idle cache warming: observed only (the return value is undefined, so Pi's own decision stands); an older Pi never fires it
	pi.on("cache_warming_decision", (e, ctx) => zip.cacheWarmingDecision(e, ctx));
	pi.on("message_end", (e, ctx) => zip.messageEnd(e.message, ctx));
	pi.on("session_shutdown", () => zip.shutdown());
}
