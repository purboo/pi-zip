// pi-zip: keeps long Pi sessions cheap without losing anything. Wiring only; the logic lives in the sibling modules.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Any } from "./util.ts";
import { type NoticeData, registerZipCommand, renderNotice } from "./notice.ts";
import { RECALL_TOOL } from "./placeholder.ts";
import { registerRecallTool } from "./recall.ts";
import { NOTICE_CUSTOM, Zip } from "./run.ts";

export default function piZip(pi: ExtensionAPI) {
	if (process.env.PI_ZIP_OFF === "1") return; // test only: behave exactly as if not installed (registers nothing)
	const zip = new Zip(pi);
	registerRecallTool(pi, zip); // stays registered even when off: earlier folds must stay recallable, and a tool-list change would bust the cache
	registerZipCommand(pi, zip);
	try {
		// fold/summary notices stay in the transcript as one dim line (a custom entry: never part of the model's context)
		let vw: (s: string) => number = (s) => s.length;
		import("@earendil-works/pi-tui").then((m: Any) => {
			if (typeof m?.visibleWidth === "function") vw = m.visibleWidth;
		}, () => {});
		pi.registerEntryRenderer?.(NOTICE_CUSTOM, (entry: Any, o: Any, theme: Any) => {
			const d = entry?.data;
			if (!d?.text) return undefined;
			const data: NoticeData = d.v === 2 ? d : { v: 2, text: d.text, before: 0, after: 0, desc: "" };
			return {
				render: (width: number) => {
					if (d.v !== 2) return [theme.fg("dim", vw(d.text) > width ? d.text.slice(0, Math.max(0, width - 1)) + "…" : d.text)];
					try {
						return renderNotice(data, !!o?.expanded, width, theme, vw);
					} catch {
						return [];
					}
				},
				invalidate: () => {},
			};
		});
		zip.entryRenderer = typeof pi.registerEntryRenderer === "function";
	} catch {
		/* older Pi: notices fall back to the status line */
	}
	// A tool allowlist (`pi --tools read,bash`, sub-agent launchers) replaces the whole selection and Pi then does not even register
	// zip_recall; folds of outputs the model could not get back would be lost, so only rereadable outputs fold then (plan rereadOnly).
	const checkRecall = () => {
		try {
			const active = pi.getActiveTools?.();
			if (Array.isArray(active)) zip.setRecallOk(active.includes(RECALL_TOOL));
		} catch {
			/* never in the way */
		}
	};
	pi.on("session_start", (_e, ctx) => {
		checkRecall();
		return zip.sessionStart(ctx);
	});
	pi.on("before_agent_start", (_e, ctx) => {
		checkRecall();
		return zip.beforeAgentStart(ctx);
	});
	pi.on("context_with_system", (e, ctx) => zip.context(e, ctx)); // the complete transcript: system messages stay where Pi put them
	pi.on("turn_end", (e, ctx) => zip.turnEnd(e, ctx));
	pi.on("agent_before_settle", (e, ctx) => zip.settle(e, ctx));
	pi.on("before_provider_request", (e) => zip.providerRequest(e));
	pi.on("message_end", (e) => zip.messageEnd(e.message));
	pi.on("session_shutdown", () => zip.shutdown());
}
