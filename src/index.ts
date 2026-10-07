// pi-zip: keeps long Pi sessions cheap without losing anything. Wiring only; the logic lives in the sibling modules.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerZipCommand } from "./notice.ts";
import { registerRecallTool } from "./recall.ts";
import { Zip } from "./run.ts";

export default function piZip(pi: ExtensionAPI) {
	if (process.env.PI_ZIP_OFF === "1") return; // test only: behave exactly as if not installed (registers nothing)
	const zip = new Zip(pi);
	registerRecallTool(pi, zip); // stays registered even when off: earlier folds must stay recallable, and a tool-list change would bust the cache
	registerZipCommand(pi, zip);
	pi.on("session_start", (_e, ctx) => zip.sessionStart(ctx));
	pi.on("before_agent_start", (_e, ctx) => zip.beforeAgentStart(ctx));
	pi.on("context_with_system", (e, ctx) => zip.context(e, ctx)); // the complete transcript: system messages stay where Pi put them
	pi.on("turn_end", (e, ctx) => zip.turnEnd(e, ctx));
	pi.on("agent_before_settle", (e, ctx) => zip.settle(e, ctx));
	pi.on("before_provider_request", (e) => zip.providerRequest(e));
	pi.on("message_end", (e) => zip.messageEnd(e.message));
	pi.on("session_shutdown", () => zip.shutdown());
}
