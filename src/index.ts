// pi-zip: keeps long Pi sessions cheap without losing anything. Wiring only; the logic lives in the sibling modules.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Any } from "./util.ts";
import { type NoticeData, registerZipCommand, renderNotice } from "./notice.ts";
import { RECALL_TOOL } from "./placeholder.ts";
import { registerRecallTool } from "./recall.ts";
import { NOTICE_CUSTOM, Zip } from "./run.ts";
import { markFirstLine, measure, renderCard, renderState, setMeasure } from "./ui.ts";

export default function piZip(pi: ExtensionAPI) {
	if (process.env.PI_ZIP_OFF === "1") return; // test only: behave exactly as if not installed (registers nothing)
	const zip = new Zip(pi);
	registerRecallTool(pi, zip); // stays registered even when off: earlier folds must stay recallable, and a tool-list change would bust the cache
	registerZipCommand(pi, zip);
	try {
		// Everything pi-zip shows lives in the transcript as custom entries (never part of the model's context): fold/summary
		// notices, state lines and the /zip status card. Widths are measured with Pi's own pi-tui once it has loaded.
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
						return renderNotice(d as NoticeData, open(), width, theme, measure.vw);
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
		// a folded output keeps its place in the transcript; its call row gets a dim "▸ folded · <handle>" on the right
		pi.registerToolRenderer?.((toolName: string, next: () => Any) => {
			const base = next();
			if (toolName === RECALL_TOOL || typeof base?.renderCall !== "function") return base;
			return {
				...base,
				renderCall: (args: Any, theme: Any, c: Any) => {
					const comp = base.renderCall(args, theme, c);
					const id = c?.toolCallId;
					if (!comp || typeof comp.render !== "function" || typeof id !== "string") return comp;
					return new Proxy(comp, {
						get(t, p, r) {
							if (p !== "render") return Reflect.get(t, p, r);
							return (width: number) => {
								const lines = t.render(width);
								const h = zip.foldedHandle(id);
								try {
									return h ? markFirstLine(lines, h, width, theme, measure) : lines;
								} catch {
									return lines;
								}
							};
						},
					});
				},
			};
		});
	} catch {
		/* older Pi: notices fall back to the status line */
	}
	// A tool allowlist (`pi --tools read,bash`, sub-agent launchers) replaces the whole selection and Pi then does not even register
	// zip_recall; folds of outputs the model could not get back would be lost, so only rereadable outputs fold then (plan rereadOnly).
	const checkRecall = (ctx: Any) => {
		try {
			const active = pi.getActiveTools?.();
			if (Array.isArray(active)) zip.setRecallOk(active.includes(RECALL_TOOL), ctx);
		} catch {
			/* never in the way */
		}
	};
	pi.on("session_start", (_e, ctx) => {
		const r = zip.sessionStart(ctx);
		checkRecall(ctx);
		zip.refreshFolded(ctx);
		zip.welcome(ctx);
		return r;
	});
	pi.on("before_agent_start", (_e, ctx) => {
		checkRecall(ctx);
		zip.refreshFolded(ctx); // the branch may have changed (/tree, fork)
		return zip.beforeAgentStart(ctx);
	});
	pi.on("context_with_system", (e, ctx) => zip.context(e, ctx)); // the complete transcript: system messages stay where Pi put them
	pi.on("turn_end", (e, ctx) => zip.turnEnd(e, ctx));
	pi.on("agent_before_settle", (e, ctx) => zip.settle(e, ctx));
	pi.on("before_provider_request", (e) => zip.providerRequest(e));
	pi.on("message_end", (e) => zip.messageEnd(e.message));
	pi.on("session_shutdown", () => zip.shutdown());
}
