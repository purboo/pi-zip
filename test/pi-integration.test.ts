// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, getCurrentSystemMessage, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { buildBlocks, calibrate, collapseSystem, editAllowed, planContext, UNIT, wireTokensOf } from "../src/plan.ts";
import { decideRun, decideTurnEnd, planOpts, rentOf, unusedOf } from "../src/core.ts";
import { lawPrices, loadStats, record } from "../src/learn.ts";
import type { Any } from "./helpers.ts";
// Pi's own draft application (AgentSession._applyBoundaryDrafts uses no instance state): the order of the drafts and the
// tokensBefore Pi writes for a compaction draft are Pi's, not a re-implementation
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
import { estimateProjectedContextTokens, prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
// another extension, loaded through Pi's own loader from a factory, before or after pi-zip (the runner calls handlers in load order)
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const CWD = "/tmp/pi-zip-integration";
const T0 = Date.now() - 3 * 3_600_000; // every message is hours old: the cache is cold
const MODEL: Any = { provider: "p", id: "m", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 } };

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: Any[], stopReason = "stop", ts = 0): Any => ({ role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage, stopReason, timestamp: T0 + ts });
const call = (id: string, command = "ls -la"): Any => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const result = (id: string, text: string, ts = 0): Any => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text }], timestamp: T0 + ts });
const user = (text: string, ts = 0): Any => ({ role: "user", content: text, timestamp: T0 + ts });
const bulk = (tag: string, lines = 400) => Array.from({ length: lines }, (_, i) => `${tag} line ${i} some filler text to make it big`).join("\n");

/** A session shaped like a real Pi one: the initial system message, a mid-conversation system update, an aborted tool-call turn. */
function populate(sm: SessionManager, prose = 0) {
	sm.appendMessage({ role: "system", content: "You are a coding agent.", toolsAdded: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }], timestamp: T0 } as Any);
	let t = 1;
	const turn = (n: number, withTool = true) => {
		sm.appendMessage(user(`request ${n}`, t++));
		if (withTool) {
			sm.appendMessage(asst([{ type: "text", text: `working ${n}` }, call(`c${n}`)], "toolUse", t++));
			sm.appendMessage(result(`c${n}`, bulk(`out${n}`), t++));
		}
		sm.appendMessage(asst([{ type: "text", text: `done ${n} ${"explanation ".repeat(prose)}` }], "stop", t++));
	};
	turn(1);
	sm.appendMessage({ role: "system", content: "", sections: { env: "the environment changed" }, timestamp: T0 + t++ } as Any); // mid-conversation system update
	turn(2);
	sm.appendMessage(user("request 3", t++));
	sm.appendMessage(asst([{ type: "text", text: "start" }, call("x1")], "aborted", t++)); // saved WITHOUT a result
	turn(4);
	turn(5);
	turn(6);
}

const sendPrompt = (sm: SessionManager, text: string) => sm.appendMessage(user(text, 10_000_000));
// timestamps are bookkeeping: no provider puts them in a request payload
const llm = (messages: Any[], mid: boolean) => JSON.stringify(resolveTranscript(normalizeContext({ messages: convertToLlm(messages) }), mid).messages, (k, v) => (k === "timestamp" ? undefined : v));

/** Pi's event order at the start of a run. "1.1": input, before_agent_start (prompts only) and agent_start, all idle until the run is
 *  active; "1.2": input idle, then busy from before_agent_start on, which also fires (messageType "custom") for a run an extension's
 *  message starts. */
type PiOrder = "1.1" | "1.2";
const PI_ORDER: PiOrder = process.env.PZ_PI_ORDER === "1.2" ? "1.2" : "1.1";
const ORDERS: PiOrder[] = ["1.1", "1.2"];
let rigOrder: PiOrder = PI_ORDER; // the order of rigs built without one (a describe run under both orders sets it)
/** A populated session file whose newest response is `agoMs` old. */
const shiftedFile = (agoMs: number, prose: number, early?: (sm: Any) => void) => {
	const sm = SessionManager.inMemory(CWD);
	early?.(sm); // entries before the populated history (old compactions, say)
	populate(sm, prose);
	const file = [sm.getHeader() as Any, ...sm.getEntries()];
	const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
	const shift = Date.now() - agoMs - newest;
	for (const e of file) {
		if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
		if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
	}
	return file;
};

interface RigOpts {
	file?: Any[]; // start from these session file entries (same entry ids in every rig built from them)
	tui?: boolean; // an interactive session (settle prepares, the away timer runs)
	native?: boolean; // ctx.compact is Pi's compaction path (prepareCompaction, session_before_compact, appendCompaction)
	idle?: boolean; // ctx.isIdle() while no run is active (default true)
	start?: boolean; // start a prompt right away (default true)
	pi?: PiOrder; // the event order of Pi's run start (default PI_ORDER)
	settings?: Any;
	model?: Any;
	// another extension's session_before_compact handler (Pi runs every extension's for pi-zip's compaction too), loaded before or after pi-zip
	boundary?: (e: Any, ctx: Any) => Any; // a preceding extension drafts edits at turn_end
	foreign?: { at: "before" | "after"; on: (e: Any, ctx: Any) => Any };
	input?: (e: Any, ctx: Any) => Any; // another extension's input handler, loaded after pi-zip
	latencyMs?: number; // the summary's model call takes this long
}

async function rig(setup: (sm: SessionManager) => void = populate, opts: RigOpts = {}) {
	const sm = opts.file ? SessionManager.inMemory(CWD, undefined, structuredClone(opts.file)) : SessionManager.inMemory(CWD); // the manager appends to the array it is given
	if (!opts.file) setup(sm);
	// the real loader, from the real entry file: exactly how `pi -e` loads the extension
	const bus = createEventBus();
	const source = process.env.PI_ZIP_TEST_SRC ?? fileURLToPath(new URL("../src", import.meta.url));
	const { Zip } = await import(join(source, "run.ts"));
	const loaded = await discoverAndLoadExtensions([join(source, "index.ts")], CWD, "/tmp/pi-zip-integration-agent", bus);
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	let extensions = loaded.extensions;
	const foreignCalls: string[] = [];
	const abortsInRun = { n: 0 }; // ctx.abort() while a run is starting or running: it would abort that run
	if (opts.foreign) {
		const f = opts.foreign;
		const other = await loadExtensionFromFactory((api: Any) => api.on("session_before_compact", async (e: Any, c: Any) => (foreignCalls.push(e.reason), f.on(e, c))), CWD, bus, runtime, "<other-compactor>");
		extensions = f.at === "before" ? [other, ...extensions] : [...extensions, other];
	}
	if (opts.input) extensions = [...extensions, await loadExtensionFromFactory((api: Any) => api.on("input", opts.input), CWD, bus, runtime, "<other-input>")];
	if (opts.boundary) {
		const other = await loadExtensionFromFactory((api: Any) => api.on("turn_end", opts.boundary), CWD, bus, runtime, "<other-editor>");
		extensions = [other, ...extensions];
	}
	const narrativeCalls: Any[] = [];
	const registry: Any = {
		complete: async (_m: Any, c: Any) => {
			narrativeCalls.push(c);
			if (opts.latencyMs) await new Promise((res) => setTimeout(res, opts.latencyMs));
			return { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0 } } };
		},
	};
	const runner = new ExtensionRunner(extensions, runtime, CWD, sm, registry);
	const noop = () => {};
	const checks = { carry: [] as string[], notices: [] as string[], sizes: [] as string[] };
	const reports: { after: number; scale: { O: number; c: number }; kind: string }[] = [];
	// Count the resulting Pi messages, independently of the selected edit and its savings arithmetic.
	const checkSizes = (messages: Any[]) => {
		for (const report of reports.splice(0)) {
			const actual = report.scale.O + report.scale.c * messages.filter((m) => m.role !== "system").reduce((n, m) => n + wireTokensOf(m), 0);
			if (!Number.isFinite(report.after) || report.after < 0 || Math.abs(report.after - actual) > Math.max(2, actual * 0.1)) checks.sizes.push(`${report.kind}: ${report.after} differs from resulting context ${actual}`);
		}
	};
	integrationChecks.push(checks);
	let zip: Any;
	let actualRequest: Any[] | null = null;
	let turn = 0, ended = false;
	const noticeCounts = new Map<number, number>();
	const appendEntry = (type: string, data: Any) => {
		if (type === "pi-zip/notice" && !data?.kind) {
			const count = (noticeCounts.get(turn) ?? 0) + 1;
			noticeCounts.set(turn, count);
			if (count > 1) checks.notices.push(`turn ${turn}: ${count} notices`);
		}
		sm.appendCustomEntry(type, data);
	};
	const containsCut = (messages: Any[] | null, cut: Any) => !!messages?.some((m) => m.role === "compactionSummary" && m.summary === (cut.text ?? cut.summary));
	const containsFold = (messages: Any[] | null, targetId: string, content: Any) => {
		const target = sm.getBranch().find((e: Any) => e.id === targetId) as Any;
		return !!messages?.some((m) => m.role === target?.message?.role && m.toolCallId === target?.message?.toolCallId && JSON.stringify(m.content) === JSON.stringify(content));
	};
	const compactions: Any[] = [];
	const compactCalls = { n: 0, ended: 0 };
	let compacting: AbortController | null = null; // Pi's _compactionAbortController: ctx.abort() reaches it (abort -> abortCompaction)
	let busy = false; // a run is active (Pi's _isAgentRunActive): from agent_start, on Pi 1.2.0 from before_agent_start, to settle
	const order: PiOrder = opts.pi ?? rigOrder;
	let model = opts.model ?? MODEL; // Pi's current model (an extension may choose another, at before_agent_start say)
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (minus the abort of an idle session and the UI events): Pi's own
	 *  prepareCompaction decides "Already compacted" / "Nothing to compact", session_before_compact supplies the result (every extension's
	 *  handler in load order: the last answer wins, a cancel stops it), the abort signal is checked right before appendCompaction. */
	const piCompact = (options: Any) => {
		void (async () => {
			await Promise.resolve(); // compact() awaits abort() before it sets its controller: Pi is idle until then
			const controller = new AbortController();
			compacting = controller;
			compactCalls.n++;
			try {
				const branch = sm.getBranch();
				const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: opts.settings?.compaction?.keepRecentTokens ?? 20_000 };
				const preparation = prepareCompaction(branch as Any, settings);
				if (!preparation) throw new Error(branch[branch.length - 1]?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)");
				const result: Any = await runner.emit({ type: "session_before_compact", preparation, branchEntries: branch, reason: "manual", willRetry: false, signal: controller.signal } as Any);
				if (result?.cancel) throw new Error("Compaction cancelled");
				if (!result?.compaction) throw new Error("rig: Pi would write its own summary with the model here");
				if (controller.signal.aborted) throw new Error("Compaction cancelled");
				const c = result.compaction;
				sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
				compactions.push(c);
				options?.onComplete?.({ ...c });
			} catch (err) {
				options?.onError?.(err instanceof Error ? err : new Error(String(err)));
			} finally {
				if (compacting === controller) compacting = null;
				compactCalls.ended++;
			}
		})();
	};
	runner.bindCore(
		{ sendMessage: noop, sendUserMessage: noop, appendEntry, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => ["read", "bash", "zip_recall"], getAllTools: () => [], getSettings: () => opts.settings ?? {}, setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop } as Any,
		{ getModel: () => model, getScopedModels: () => [], isIdle: () => opts.idle !== false && !compacting && !busy, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { if (busy) abortsInRun.n++; compacting?.abort(); }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: opts.native ? piCompact : (o: Any) => o?.onError?.(new Error("rig: no compaction")), getSystemPrompt: () => "You are a coding agent." } as Any,
	);
	// Pi's TUI hands raw input to the extensions' listeners in order (TuiBase.handleTerminalInput): one may consume it or replace the data
	const inputListeners = new Set<(data: string) => Any>();
	// Pi's editor after the listeners, reduced to what pi-zip reads (getEditorText): printable text and pastes are typed in, Backspace
	// deletes, Ctrl+C clears, Enter submits (clears); other control keys and escape sequences (Esc, arrows, Ctrl+D) change no text
	const editor = { text: "" };
	const edit = (data: string) => {
		if (data === "\x03" || data === "\r") editor.text = "";
		else if (data === "\x7f") editor.text = editor.text.slice(0, -1);
		else if (data.startsWith("\x1b[200~")) editor.text += data.slice(6).replace(/\x1b\[201~$/, "");
		else if (!data.startsWith("\x1b")) editor.text += [...data].filter((ch) => ch >= " ").join("");
	};
	const typeKey = (data: string): string | null => {
		let cur = data;
		for (const h of [...inputListeners]) {
			const r = h(cur);
			if (r?.consume) return null;
			if (r?.data !== undefined) cur = r.data;
		}
		edit(cur);
		return cur;
	};
	if (opts.tui) runner.setUIContext({ notify: noop, setWorkingMessage: noop, setStatus: noop, setWidget: noop, getEditorText: () => editor.text, onTerminalInput: (h: (data: string) => Any) => (inputListeners.add(h), () => inputListeners.delete(h)) } as Any, "tui");
	const projectionMessages = () => sm.buildSessionContext().messages as Any[];
	/** One request as Pi sends it: the agent state is the session projection; the extension transforms it. */
	const request = async () => {
		if (ended) { turn++; ended = false; }
		const messages = await runner.emitContext(projectionMessages()) as Any[];
		actualRequest = structuredClone(messages);
		const plan = zip.runPlan;
		if (plan && !plan.persisted) {
			let carriesView = !!(plan.cut || plan.native) && containsCut(messages, plan.cut ?? plan.native);
			for (const fold of plan.folds) {
				const carried = containsFold(messages, fold.entryId, [{ type: "text", text: fold.ph }]);
				carriesView ||= carried;
				if (!!plan.applied?.has(fold.entryId) !== carried) checks.carry.push("applied fold flag disagrees with request");
			}
			if (!!plan.sent !== carriesView) checks.carry.push("sent flag disagrees with request");
			if (plan.sent && (plan.cut || plan.native) && !containsCut(messages, plan.cut ?? plan.native)) checks.carry.push("sent summary absent from request");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		checkSizes(messages);
		assertIntegrationChecks();
		return messages;
	};
	const build = (drafts: Any[]) => {
		const preview = SessionManager.inMemory(CWD, undefined, [sm.getHeader() as Any, ...sm.getBranch()]);
		apply(preview, drafts);
		const projection = preview.buildSessionProjection();
		return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: convertToLlm(projection.messages), pendingMessages: [], canContinue: false };
	};
	/** What Pi's agent session does at turn_end: boundary handlers propose entries, the drafts are applied to the real session. */
	const turnEnd = async (assistantEntryId: string, message: Any) => {
		const out = await runner.emitBoundary({ type: "turn_end", turnIndex: 1, message, toolResults: [], messageEntryId: assistantEntryId, toolResultEntryIds: [], outcome: message.stopReason === "aborted" ? "aborted" : "completed" } as Any, build as Any);
		const drafts = out.entries as Any[];
		const marker = drafts.find((d) => d.type === "custom" && d.customType === "pi-zip/commit");
		for (const draft of drafts) {
			if (draft.type === "compaction" && draft.details?.by === "pi-zip" && draft.details.carried !== containsCut(actualRequest, draft)) checks.carry.push("summary carried flag disagrees with request");
			if (draft.type === "context_edit" && JSON.stringify(draft.replacement).includes("[folded by pi-zip") && marker && (marker.data.carried && (!marker.data.carriedIds || marker.data.carriedIds.includes(draft.targetId))) !== containsFold(actualRequest, draft.targetId, draft.replacement.content)) checks.carry.push("fold carried flag disagrees with request");
		}
		apply(sm, drafts);
		await new Promise((resolve) => setTimeout(resolve, 5));
		checkSizes(projectionMessages());
		assertIntegrationChecks();
		ended = true;
		return drafts;
	};
	/** The end of a run: agent_before_settle (pi-zip plans the next cold return and, interactive, arms the away timer). */
	const settle = async () => {
		const out = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" } as Any, build as Any);
		apply(sm, out.entries as Any[]);
		busy = false;
		return out.entries as Any[];
	};
	const apply = (manager: SessionManager, drafts: Any[]) => (AgentSession.prototype as Any)._applyBoundaryDrafts.call({}, manager, drafts) as Any[];
	/** A prompt as Pi runs it (AgentSession.prompt): the input handlers while Pi is idle (it waits for them), then before_agent_start and
	 *  agent_start in the rig's order. `fail`: the prompt throws between before_agent_start and agent_start (Pi's image normalisation).
	 *  `afterInput` runs between the input handlers and before_agent_start (Pi's own threshold compaction, say), `afterStart` between
	 *  before_agent_start and agent_start (a steer typed into the starting run, a handler choosing another model). */
	const prompt = async (text = "next request", o: { fail?: boolean; afterInput?: () => Any; afterStart?: () => Any } = {}) => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		busy = false; // the previous run is over
		turn++; ended = false;
		await runner.emitInput(text, undefined, "interactive", undefined);
		await o.afterInput?.();
		if (order === "1.2") busy = true;
		const r = await runner.emitBeforeAgentStart({ messageType: "user", prompt: text }, { cwd: CWD } as Any);
		await o.afterStart?.();
		busy = !o.fail;
		if (!o.fail) await runner.emit({ type: "agent_start" } as Any);
		return r;
	};
	/** Text typed while the run streams (a steer or a follow-up): Pi hands it to the input handlers with its delivery. */
	const steer = (text: string, behavior: "steer" | "followUp" = "steer") => runner.emitInput(text, undefined, "interactive", behavior);
	/** A run an extension's message starts (sendMessage with triggerTurn on an idle session): Pi 1.1.0 emits agent_start only, 1.2.0
	 *  before_agent_start with messageType "custom" first. The custom message is appended and its message_end fired. */
	const drive = async (text = "drive the owed work") => {
		busy = false;
		const message = { role: "custom", customType: "owed-drive", content: text, display: true, timestamp: Date.now() };
		if (order === "1.2") {
			busy = true;
			await runner.emitBeforeAgentStart({ messageType: "custom", message } as Any, { cwd: CWD } as Any);
		}
		busy = true;
		await runner.emit({ type: "agent_start" } as Any);
		sm.appendCustomMessageEntry(message.customType, message.content, message.display);
		await runner.emit({ type: "message_end", message } as Any);
	};
	const start = (Zip.prototype as Any).sessionStart;
	(Zip.prototype as Any).sessionStart = function (this: Any, ...args: Any[]) { zip = this; return start.apply(this, args); };
	try { await runner.emit({ type: "session_start", reason: "startup" } as Any); }
	finally { (Zip.prototype as Any).sessionStart = start; }
	let noticeScale = UNIT;
	const noticeFor = zip.noticeFor.bind(zip), notify = zip.notify.bind(zip), ledger = zip.ledger.bind(zip);
	zip.noticeFor = (...args: Any[]) => { noticeScale = args[1].scale; return noticeFor(...args); };
	zip.notify = (ctx: Any, text: string, data: Any) => {
		if (data && !data.kind) reports.push({ after: data.after, scale: noticeScale, kind: "notice" });
		return notify(ctx, text, data);
	};
	zip.ledger = (rec: Any) => {
		if (rec.type === "fold") reports.push({ after: rec.ctxAfter, scale: { O: rec.O, c: rec.c }, kind: "fold ledger" });
		return ledger(rec);
	};
	if (opts.start !== false) await prompt();
	const shutdown = () => runner.emit({ type: "session_shutdown" } as Any);
	const setModel = (m: Any) => { model = m; };
	return { sm, runner, request, turnEnd, settle, prompt, steer, drive, order, setModel, narrativeCalls, projectionMessages, compactions, compactCalls, foreignCalls, abortsInRun, inputListeners, typeKey, editor, shutdown, zip, checks, noticeCounts };
}

// These checks observe Pi's actual request messages and emitted transcript entries, independently of plan flags.
const integrationChecks: { carry: string[]; notices: string[]; sizes: string[] }[] = [];
const assertIntegrationChecks = () => {
	for (const check of integrationChecks) {
		expect(check.carry, "request carry metadata must match the actual request view").toEqual([]);
		expect(check.notices, "one turn emits at most one pi-zip notice").toEqual([]);
		expect(check.sizes, "reported after-size must be non-negative and match the resulting Pi context within 10%").toEqual([]);
	}
};
const saved: Record<string, string | undefined> = {};
const ENV = { PI_ZIP_COLD_CAP: "3000", PI_ZIP_TTL_SECS: "300", PI_ZIP_IDLE_DOOR: "" }; // the shipped default: the idle door on
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => {
	try { assertIntegrationChecks(); }
	finally {
		integrationChecks.length = 0;
		for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
	}
});

const isFolded = (m: Any) => m.role === "toolResult" && JSON.stringify(m.content).includes("[folded by pi-zip");
/** Nobody waits for a summary: the first request of a return whose plan wants one goes with its folds alone and starts it in the
 *  background; once it is written, the prompt tried again takes it (a later decision). */
const produced = async (r: Any) => {
	const first = await r.request();
	expect(first.some((m: Any) => m.role === "compactionSummary")).toBe(false);
	await new Promise((res) => setTimeout(res, 50));
	expect(r.narrativeCalls.length).toBe(1);
	await r.prompt();
};

describe("boundary decision regressions", () => {
	for (const pWarm of [1, 0] as const) for (const how of ["applied", "esc", "mismatch"] as const) test(`first-request rent resets on application or a cold request (P=${pWarm}, ${how})`, async () => {
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("older"));
		sm.appendMessage({ ...asst([call("large")], "toolUse"), usage: undefined });
		sm.appendMessage(result("large", bulk("output", 6000)));
		sm.appendMessage(user("previous"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), timestamp: Date.now(), usage: undefined });
		sm.appendCustomEntry("pi-zip/rent", { rent: 10_000 });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		let restored: Awaited<ReturnType<typeof rig>> | undefined;
		try {
			await r.prompt("current");
			r.sm.appendMessage(user("current"));
			r.zip.cold = pWarm < 0.5; r.zip.pWarm = pWarm; // a selected fold with incoming rent, on a warm or cold request
			const signal = { aborted: false }, base = r.runner.createContext();
			const ctx = new Proxy(base, { get: (t, k) => (k === "signal" ? signal : Reflect.get(t, k)) });
			const compute = r.zip.computeRunPlan.bind(r.zip);
			r.zip.computeRunPlan = async (c: Any) => {
				const rentNext = await compute(c);
				expect(r.zip.runPlan?.folds.length).toBeGreaterThan(0); // the edit is selected
				expect(r.zip.rent).toBe(10_000); // and not yet paid for
				if (how === "esc") signal.aborted = true; // Esc between planning and application
				return rentNext;
			};
			const messages = structuredClone(r.projectionMessages());
			if (how === "mismatch") for (const m of messages) if (m.role === "toolResult") m.content = [{ type: "text", text: "annotated by a preceding handler" }];
			if (how === "applied") expect((await r.request()).filter(isFolded).length).toBeGreaterThan(0); // Pi's request carries it
			else expect(await r.zip.context({ messages }, ctx)).toBeUndefined();
			expect(!!r.zip.runPlan?.sent).toBe(how === "applied");
			const balance = how === "esc" || (how === "mismatch" && pWarm >= 0.5) ? 10_000 : 0;
			expect(r.zip.rent).toBe(balance);
			const response = { ...asst([{ type: "text", text: "stopped" }], "aborted"), timestamp: Date.now(), usage: undefined };
			const drafts = await r.turnEnd(r.sm.appendMessage(response), response); // the failed boundary persists only what went out
			expect(drafts.some((d) => d.customType === "pi-zip/rent")).toBe(balance === 0);
			expect(rentOf(r.sm.getBranch())).toBe(balance);
			restored = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restored.zip.rent).toBe(balance);
		} finally { await restored?.shutdown(); await r.shutdown(); }
	});

	for (const pWarm of [0, 1] as const) for (const cancel of [true, false]) test(`no-edit first-request rent changes only after cancellation is checked (P=${pWarm}, cancel=${cancel})`, async () => {
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("older"));
		if (pWarm) {
			sm.appendMessage({ ...asst([call("large")], "toolUse"), usage: undefined });
			sm.appendMessage(result("large", bulk("output", 6000)));
		}
		sm.appendMessage(user("previous"));
		sm.appendMessage({ ...asst([{ type: "text", text: pWarm ? "context ".repeat(45_000) : "done" }]), timestamp: Date.now(), usage: undefined });
		sm.appendCustomEntry("pi-zip/rent", { rent: 10_000 });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		let restored: Awaited<ReturnType<typeof rig>> | undefined;
		try {
			await r.prompt("current");
			r.sm.appendMessage(user("current"));
			r.zip.cold = pWarm < 0.5; r.zip.pWarm = pWarm;
			const controller = new AbortController(), base = r.runner.createContext();
			const ctx = new Proxy(base, { get: (t, k) => k === "signal" ? controller.signal : Reflect.get(t, k) });
			const entries = r.sm.buildSessionProjection().entries;
			const d = decideRun({ cold: r.zip.cold, justEdited: r.zip.justEdited, nat: null, foreign: false, now: entries, ready: [],
				opts: (view, cutAt, foldsOnly, ready) => r.zip.opts(ctx, false, view, pWarm, r.zip.pause, cutAt, foldsOnly, ready) });
			expect(d.p).toBeNull();
			expect(d.o.law.g).toBe(2500);
			if (pWarm) {
				expect(d.rentNext).toBeGreaterThan(10_000); // the guard refuses folds with positive removable rent
				expect(d.o.trace.some((t: Any) => t.where === "guard" && !t.ok && t.phi >= 1)).toBe(true); // the plain law pays, but the rent floor refuses
			} else expect(d.rentNext).toBe(0);
			expect(r.zip.rent).toBe(10_000);
			if (cancel) queueMicrotask(() => controller.abort()); // real Esc at computeRunPlan's await, with unmodified methods
			expect(await r.zip.context({ messages: r.projectionMessages() }, ctx)).toBeUndefined();
			expect(controller.signal.aborted).toBe(cancel);
			expect(r.zip.runChecked).toBe(true); // planning ran before the queued abort
			expect(r.zip.runPlan).toBeNull();
			const balance = cancel ? 10_000 : d.rentNext;
			expect(r.zip.rent).toBe(balance);
			const response = { ...asst([{ type: "text", text: "stopped" }], "aborted"), timestamp: Date.now(), usage: undefined };
			const drafts = await r.turnEnd(r.sm.appendMessage(response), response);
			expect(drafts.filter((d) => d.customType === "pi-zip/rent").map((d) => d.data.rent)).toEqual(cancel ? [] : [balance]);
			expect(drafts.some((d) => d.type === "compaction" || d.type === "context_edit")).toBe(false);
			expect(rentOf(r.sm.getBranch())).toBe(balance);
			restored = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restored.zip.rent).toBe(balance);
		} finally { await restored?.shutdown(); await r.shutdown(); }
	});

	for (const reject of [false, true]) test(`warm boundary rent resets only after a valid edit (reject=${reject})`, async () => {
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("older"));
		sm.appendMessage({ ...asst([call("large")], "toolUse"), usage: undefined });
		sm.appendMessage(result("large", bulk("output", 6000)));
		sm.appendMessage(user("previous"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), usage: undefined });
		sm.appendMessage(user("current"));
		sm.appendMessage({ ...asst([call("recent")], "toolUse"), usage: undefined });
		const recent = sm.appendMessage(result("recent", bulk("recent", 100)));
		sm.appendCustomEntry("pi-zip/rent", { rent: 10_000 });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		let restored: Awaited<ReturnType<typeof rig>> | undefined;
		try {
			const commit = r.zip.commit.bind(r.zip);
			r.zip.commit = (e: Any, ctx: Any, plan: Any, o: Any) => {
				expect(plan.folds.length).toBeGreaterThan(0);
				if (reject) plan.folds[0] = { ...plan.folds[0], entryId: recent }; // the structural guard refuses a protected target
				return commit(e, ctx, plan, o);
			};
			const response = { ...asst([{ type: "text", text: "finished" }]), timestamp: Date.now(), usage: undefined };
			const drafts = await r.turnEnd(r.sm.appendMessage(response), response);
			expect(drafts.some((d) => d.type === "context_edit")).toBe(!reject);
			expect(drafts.some((d) => d.customType === "pi-zip/rent")).toBe(!reject);
			const balance = reject ? 10_000 : 0;
			expect(r.zip.rent).toBe(balance);
			expect(rentOf(r.sm.getBranch())).toBe(balance);
			restored = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restored.zip.rent).toBe(balance);
		} finally { await restored?.shutdown(); await r.shutdown(); }
	});

	test("rent matching a balance before compaction is persisted and restored", async () => {
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("past"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), usage: undefined });
		const kept = sm.appendMessage(user("older"));
		sm.appendMessage({ ...asst([call("large")], "toolUse"), usage: undefined });
		sm.appendMessage(result("large", bulk("output", 6000)));
		sm.appendMessage(user("previous"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), usage: undefined });
		sm.appendMessage(user("current"));
		const p = planContext(sm.buildSessionProjection().entries, { scale: UNIT, law: { pr: lawPrices("explicit", false), g: 2500, pWarm: 1 }, foldsOnly: true })!;
		const balance = p.folds.reduce((n, f) => n + f.entryTokens - f.phTokens, 0);
		expect(balance).toBeGreaterThan(0);
		sm.appendCustomEntry("pi-zip/rent", { rent: balance });
		sm.appendCompaction("earlier history", kept, 100_000, { by: "other" }, true);
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		let restored: Awaited<ReturnType<typeof rig>> | undefined;
		try {
			expect(rentOf(r.sm.getBranch())).toBe(0);
			expect(r.zip.rent).toBe(0);
			const originalOpts = r.zip.opts.bind(r.zip);
			r.zip.opts = (...args: Any[]) => {
				const o = originalOpts(...args).o;
				o.scale = UNIT; o.law = { pr: lawPrices("explicit", false), g: 2500, pWarm: 1 };
				return { o, cal: UNIT };
			};
			r.zip.justEdited = true; // the warm b2b decision accumulates removal without applying it
			const response = { ...asst([{ type: "text", text: "finished" }]), timestamp: Date.now(), usage: undefined };
			const id = r.sm.appendMessage(response);
			const drafts = await r.turnEnd(id, response);
			expect(r.zip.rent).toBe(balance);
			expect(drafts).toEqual([{ type: "custom", customType: "pi-zip/rent", data: { rent: balance } }]);
			expect(rentOf(r.sm.getBranch())).toBe(balance);
			restored = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restored.zip.rent).toBe(balance);
			await restored.prompt();
			expect(restored.zip.rent).toBe(balance);
		} finally { await restored?.shutdown(); await r.shutdown(); }
	});

	test("an output becoming 60 requests old before the first boundary joins the exact priced summary edit", async () => {
		delete process.env.PI_ZIP_COLD_CAP;
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("first"));
		sm.appendMessage({ ...asst([{ type: "text", text: "p".repeat(160_000) }, call("older")], "toolUse"), usage: undefined });
		const older = sm.appendMessage(result("older", bulk("older", 1000)));
		const key = sm.appendMessage(user("previous"));
		sm.appendMessage({ ...asst([{ type: "text", text: "q".repeat(32_000) }]), usage: undefined });
		sm.appendMessage(user("current"));
		sm.appendMessage({ ...asst([call("aged")], "toolUse"), usage: undefined });
		const aged = sm.appendMessage(result("aged", bulk("aged", 10_500)));
		for (let i = 0; i < 59; i++) sm.appendMessage({ ...asst([{ type: "text", text: "working" }]), usage: undefined });
		const text = "## Decisions\nsummary";
		sm.appendCustomEntry("pi-zip/summary", { head: "", key, usd: 0, cut: { firstKeptEntryId: key, text, trigger: "valve", count: 1, prefixTokens: 20_000, summaryTokens: 1000, llmOk: true, llmError: null, costUsd: 0, ms: 0 } });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		await r.prompt();
		const pWarm = 0.4923076923;
		let probability = 0;
		const originalOpts = r.zip.opts.bind(r.zip);
		r.zip.opts = (...args: Any[]) => {
			const o = originalOpts(...args).o;
			o.scale = UNIT; o.law.pWarm = probability;
			return { o, cal: UNIT };
		};
		r.zip.cold = true;
		expect(buildBlocks(r.sm.buildSessionProjection().entries).find((b) => b.entryId === aged)?.age).toBe(59);
		const request = await r.request();
		expect(request.filter(isFolded)).toHaveLength(1);
		expect([...r.zip.runPlan.applied]).toEqual([older]);
		probability = pWarm;
		const response = { ...asst([{ type: "text", text: "working" }], "toolUse"), timestamp: Date.now(), usage: undefined };
		const id = r.sm.appendMessage(response);
		const entries = r.sm.buildSessionProjection().entries;
		expect(buildBlocks(entries).find((b) => b.entryId === aged)?.age).toBe(60);
		const d = decideTurnEnd({ failed: false, justEdited: false, pWarm, ready: [{ key, running: false }], entries, runPlan: r.zip.runPlan,
			opts: (cutAt, foldsOnly, ready) => r.zip.opts({}, false, entries, pWarm, false, cutAt, foldsOnly, ready) });
		if (d.kind !== "plan" || !d.p) throw new Error("expected ready edit");
		expect(d.p.firstKeptEntryId).toBe(key);
		expect(d.p.folds.map((t) => t.entryId)).toEqual([older, aged]);
		const after = d.p.ctxAfterFolds - d.p.prefixTokens + d.p.summaryTokensPlanned;
		expect(editAllowed(d.p.ctxTokens, after, pWarm, null, d.o.law!.pr, d.o.law!.g)).toBe(true);
		expect(editAllowed(d.p.ctxTokens, after + d.p.folds[1].entryTokens - d.p.folds[1].phTokens, pWarm, null, d.o.law!.pr, d.o.law!.g)).toBe(false);
		const drafts = await r.turnEnd(id, response);
		expect(drafts.filter((d) => d.type === "context_edit").map((d) => d.targetId)).toEqual([older, aged]);
		expect(drafts[0].type).toBe("compaction");
		expect(drafts.find((d) => d.customType === "pi-zip/commit").data).toEqual({ carried: true, next: true, carriedIds: [older] });
		await r.shutdown();
	});

	test("a preceding extension boundary edit invalidates usage for Pi's exact compaction number", async () => {
		const r = await rig((sm) => populate(sm, 3500), { start: false, tui: true, boundary: (e) => {
			const target = e.context.contextEntries.find((e: Any) => e.messages.some((m: Any) => m.role === "toolResult"));
			return { entries: [...e.entries, { type: "context_edit", targetId: target.sourceEntry.id, replacement: { content: [{ type: "text", text: "short" }] } }] };
		} });
		await r.prompt();
		const originalOpts = r.zip.opts.bind(r.zip);
		r.zip.opts = (...args: Any[]) => { const o = originalOpts(...args).o; o.scale = UNIT; o.law.pWarm = 0; return { o, cal: UNIT }; };
		await r.request();
		await new Promise((res) => setTimeout(res, 50));
		const response = { ...asst([{ type: "text", text: "done" }]), timestamp: Date.now(), usage: { ...usage, input: 50_000, totalTokens: 50_050 } };
		const id = r.sm.appendMessage(response);
		const stale = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens;
		const drafts = await r.turnEnd(id, response);
		const compaction = r.sm.getBranch().findLast((e: Any) => e.type === "compaction") as Any;
		expect(compaction).toBeDefined();
		expect(drafts[0].type).toBe("context_edit"); // the preceding handler's draft is applied before pi-zip's first draft
		expect(drafts[1].type).toBe("compaction");
		expect(compaction.tokensBefore).not.toBe(stale);
		const notice = r.sm.getBranch().findLast((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind) as Any;
		expect(notice.data.before).toBe(compaction.tokensBefore);
		await r.shutdown();
	});
});

describe("successive warm summaries", () => {
	test("a restarted warm session takes a paying summary below its previous compaction size", async () => {
		const sm = SessionManager.inMemory(CWD);
		sm.appendMessage(user("old request"));
		sm.appendMessage(asst([{ type: "text", text: "old work" }]));
		const kept = sm.appendMessage(user("new work"));
		const head = sm.appendCompaction("S".repeat(32_000), kept, 100_000, { by: "pi-zip" }, true);
		sm.appendMessage({ ...asst([{ type: "text", text: "p".repeat(160_000) }]), timestamp: Date.now(), usage: undefined });
		const key = sm.appendMessage(user("previous request"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), timestamp: Date.now(), usage: undefined });
		sm.appendMessage(user("current request"));
		const text = "## Decisions\n" + "S".repeat(32_000);
		sm.appendCustomEntry("pi-zip/summary", { head, key, usd: 0.01, cut: { firstKeptEntryId: key, text, trigger: "valve", count: 1,
			prefixTokens: 48_000, summaryTokens: text.length / 4, llmOk: true, llmError: null, costUsd: 0.01, ms: 1 } });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], start: false });
		const originalOpts = r.zip.opts.bind(r.zip);
		r.zip.opts = (...args: Any[]) => {
			const o = originalOpts(...args).o;
			o.scale = UNIT; o.law = { pr: lawPrices("explicit", false), g: 500, pWarm: 1 };
			return { o, cal: UNIT };
		};
		const response = { ...asst([{ type: "text", text: "finished" }]), timestamp: Date.now(), usage: undefined };
		const id = r.sm.appendMessage(response);
		const drafts = await r.turnEnd(id, response);
		expect(drafts[0]).toMatchObject({ type: "compaction", firstKeptEntryId: key, summary: text });
		const compactions = r.sm.getBranch().filter((e: Any) => e.type === "compaction") as Any[];
		expect(compactions).toHaveLength(2);
		expect(compactions[1].tokensBefore).toBeLessThan(compactions[0].tokensBefore);
		expect(r.narrativeCalls).toHaveLength(0); // the ready call is reused
		await r.shutdown();
	});
});

describe("mixed room boundary", () => {
	for (const outcome of ["room", "below room", "aborted"] as const) test(`an incoming edit of a carried target preserves the boundary decision (${outcome})`, async () => {
		delete process.env.PI_ZIP_COLD_CAP;
		let target = "", kept = "";
		const r = await rig((sm) => {
			sm.appendMessage(user("first"));
			sm.appendMessage({ ...asst([{ type: "text", text: "p".repeat(300_000) }, call("large"), call("small")], "toolUse"), usage: undefined });
			target = sm.appendMessage(result("large", "a".repeat(200_000)));
			kept = sm.appendMessage(result("small", "b".repeat(20_000)));
			sm.appendMessage(user("previous"));
			sm.appendMessage({ ...asst([{ type: "text", text: "q".repeat(120_000) }]), usage: undefined });
			sm.appendMessage(user("current"));
		}, { start: false, tui: true, model: { ...MODEL, contextWindow: 200_000 }, boundary: (e) => ({ entries: [...e.entries,
			{ type: "context_edit", targetId: target, replacement: { content: [{ type: "text", text: "incoming replacement" }] } },
		] }) });
		await r.prompt();
		let probability = 0;
		const originalOpts = r.zip.opts.bind(r.zip);
		r.zip.opts = (...args: Any[]) => {
			const o = originalOpts(...args).o;
			o.scale = UNIT; o.law = { pr: lawPrices("explicit", false), g: 1000, pWarm: probability };
			return { o, cal: UNIT };
		};
		const request = await r.request();
		expect(request.filter(isFolded)).toHaveLength(2);
		expect([...r.zip.runPlan.applied]).toEqual([target, kept]);
		await r.runner.emitBeforeProviderRequest({});
		const response = { ...asst([call("growth")], outcome === "aborted" ? "aborted" : "toolUse"), timestamp: Date.now(), usage: undefined };
		const id = r.sm.appendMessage(response);
		await r.runner.emitMessageEnd({ type: "message_end", message: response } as Any);
		expect(r.zip.justEdited).toBe(true);
		probability = 1;
		r.sm.appendMessage(result("growth", "g".repeat(outcome === "room" ? 320_000 : 40_000)));
		const records: Any[] = [], ledger = r.zip.ledger.bind(r.zip);
		r.zip.ledger = (note: Any) => { records.push(note); ledger(note); };
		const drafts = await r.turnEnd(id, response);
		expect(records.some((n) => n.type === "b2b_skip" && n.where === "turn_end")).toBe(outcome !== "aborted");
		expect(records.filter((n) => n.type === "room_wait")).toHaveLength(outcome === "room" ? 1 : 0);
		expect(drafts[0]).toMatchObject({ type: "context_edit", targetId: target });
		const compaction = drafts.find((d) => d.type === "compaction");
		if (outcome === "room") {
			expect(compaction).toBeDefined();
			expect(drafts[1]).toBe(compaction); // pi-zip's first draft follows the incoming edit
			expect(compaction.details.carried).toBe(false);
			const projection = r.sm.buildSessionProjection();
			expect(buildBlocks(projection.entries).reduce((n, b) => n + b.tokens, 0)).toBeLessThan(175_424);
			const persisted = r.sm.getBranch().findLast((e: Any) => e.type === "compaction") as Any;
			const notice = r.sm.getBranch().findLast((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind) as Any;
			expect(notice.data.before).toBe(persisted.tokensBefore);
		} else expect(compaction).toBeUndefined();
		expect(drafts.filter((d) => d.type === "context_edit").map((d) => d.targetId)).toEqual([target, kept]);
		expect(r.zip.runPlan.persisted).toBe(true);
		await r.shutdown();
	});
	test("carried views and one notice follow the real Pi requests across the room boundary", async () => {
		const r = await rig((sm) => {
			populate(sm, 5000);
			for (const entry of sm.getBranch() as Any[]) if (entry.message?.role === "assistant") delete entry.message.usage;
		}, { tui: true, model: { ...MODEL, provider: "room", contextWindow: 100_000 }, latencyMs: 20 });
		sendPrompt(r.sm, "next request");
		const request = await r.request();
		expect(request.some(isFolded)).toBe(true);
		expect(request.some((m) => m.role === "compactionSummary")).toBe(false);
		const scale = r.zip.runPlan.scale;
		expect(scale.c).toBe(1.5);
		const real = Math.round(scale.O + scale.c * request.filter((m) => m.role !== "system").reduce((n, m) => n + wireTokensOf(m), 0));
		await r.runner.emitBeforeProviderRequest({});
		expect(r.zip.pending.edited).toBe(true); // this request first carried the folds
		const response = { ...asst([call("room")], "toolUse"), provider: "room", timestamp: Date.now(), usage: { ...usage, input: real, totalTokens: real } };
		const responseId = r.sm.appendMessage(response);
		await r.runner.emitMessageEnd({ type: "message_end", message: response } as Any);
		expect(r.zip.nextEdit).toBeNull();
		r.sm.appendMessage(result("room", "short output"));
		const piBefore = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens;
		const drafts = await r.turnEnd(responseId, response);
		const compaction = drafts.find((d) => d.type === "compaction");
		expect(compaction).toBeDefined();
		expect(compaction.details.carried).toBe(false);
		expect((r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any).tokensBefore).toBe(piBefore);
		expect(drafts.find((d) => d.customType === "pi-zip/commit").data).toEqual({ carried: true, next: true });
		expect(r.zip.nextEdit).toBe(scale.O); // the summary rewrites everything after the system prefix
		const branch = r.sm.getBranch() as Any[];
		const restarted = await rig(undefined, { file: [r.sm.getHeader() as Any, ...branch], tui: true, start: false, model: { ...MODEL, provider: "room", contextWindow: 100_000 } });
		expect(restarted.zip.nextEdit).toBe(scale.O);
		await restarted.request();
		await restarted.runner.emitBeforeProviderRequest({});
		expect(restarted.zip.pending).toMatchObject({ edited: true, expect: scale.O });
		await restarted.shutdown();
		const calibrated = calibrate(r.sm.buildSessionProjection().entries, undefined, branch, "room/m");
		expect(calibrated.source).toBe("usage");
		expect(calibrated.c).toBeCloseTo(1.5, 2);
		expect(calibrated.est).toBeGreaterThan(50_000); // the unsummarized request, including its actual folds
		const notices = branch.filter((e) => e.customType === "pi-zip/notice" && !e.data?.kind);
		expect(notices).toHaveLength(1);
		expect(notices[0].data.desc).toContain("zipped");
		expect(notices[0].data.desc).toContain("summarized");
		expect(notices[0].data.desc).toContain("waited");
		const resulting = scale.O + scale.c * r.projectionMessages().filter((m) => m.role !== "system").reduce((n, m) => n + wireTokensOf(m), 0);
		expect(notices[0].data.after).toBeGreaterThanOrEqual(0);
		expect(notices[0].data.after).toBe(Math.round(resulting));
		const next = await r.request();
		expect(next.some((m) => m.role === "compactionSummary" && m.summary === compaction.summary)).toBe(true);
		await r.runner.emitBeforeProviderRequest({});
		expect(r.zip.pending).toMatchObject({ edited: true, expect: scale.O });
		const nextResponse = { ...asst([{ type: "text", text: "done" }]), provider: "room", timestamp: Date.now(), usage: { ...usage, input: 10_000, totalTokens: 10_000 } };
		const nextId = r.sm.appendMessage(nextResponse);
		await r.runner.emitMessageEnd({ type: "message_end", message: nextResponse } as Any);
		expect(r.zip.justEdited).toBe(true);
		const { carriedEdits, replayGrowth } = await import("../src/state.ts");
		const history = r.sm.getBranch() as Any[];
		expect(carriedEdits(history).has(history.findIndex((e) => e.id === responseId))).toBe(true);
		expect(carriedEdits(history).has(history.findIndex((e) => e.id === nextId))).toBe(true);
		expect(replayGrowth(history, 2500).justEdited).toBe(true);
		await r.shutdown();
	});

	test("an aborted room turn persists only its carried folds and one notice", async () => {
		const r = await rig((sm) => {
			populate(sm, 5000);
			for (const entry of sm.getBranch() as Any[]) if (entry.message?.role === "assistant") delete entry.message.usage;
		}, { tui: true, model: { ...MODEL, provider: "room-abort", contextWindow: 100_000 }, latencyMs: 20 });
		sendPrompt(r.sm, "next request");
		expect((await r.request()).some(isFolded)).toBe(true);
		await r.runner.emitBeforeProviderRequest({});
		const response = { ...asst([{ type: "text", text: "interrupted" }], "aborted"), provider: "room-abort", timestamp: Date.now() };
		const id = r.sm.appendMessage(response);
		await r.runner.emitMessageEnd({ type: "message_end", message: response } as Any);
		const drafts = await r.turnEnd(id, response);
		expect(drafts.some((d) => d.type === "compaction")).toBe(false);
		expect(drafts.filter((d) => d.type === "context_edit").length).toBeGreaterThan(0);
		expect(drafts.find((d) => d.customType === "pi-zip/commit").data).toEqual({ carried: true });
		expect(r.zip.nextEdit).toBeNull();
		expect(r.sm.getBranch().filter((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind)).toHaveLength(1);
		await r.shutdown();
	});
});

describe("real Pi: the request view is identical before and after turn_end persists the edits (I1)", () => {
	test("folds: system update stays in place, aborted turn does not block the save, request N+1 starts with request N's bytes", async () => {
		const r = await rig();
		sendPrompt(r.sm, "next request");
		const raw = r.projectionMessages();
		const req1 = await r.request();
		expect(req1.some(isFolded)).toBe(true);
		expect(req1.length).toBe(raw.length); // folds replace in place: nothing added, nothing removed
		// the mid-conversation system update is exactly where Pi put it (not merged into the leading message)
		const sysAt = (ms: Any[]) => ms.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
		expect(sysAt(req1)).toEqual(sysAt(raw));
		expect(sysAt(req1).length).toBe(2);
		expect(req1[0]).toEqual(raw[0]);

		// request 2 of the same run: the assistant answered with a tool call and its result came back
		const a = r.sm.appendMessage(asst([call("c7")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("c7", "short output", 10_000_002));
		const req2 = await r.request();
		for (const mid of [true, false]) expect(llm(req2.slice(0, req1.length), mid)).toBe(llm(req1, mid));

		// turn_end persists the plan, then request 3 is built from the persisted projection
		const entries = await r.turnEnd(a, asst([call("c7")], "toolUse"));
		expect(entries.filter((e: Any) => e.type === "context_edit").length).toBeGreaterThan(0);
		r.sm.appendMessage(asst([{ type: "text", text: "ok" }], "stop", 10_000_003));
		const req3 = await r.request();
		for (const mid of [true, false]) {
			expect(llm(req3.slice(0, req2.length), mid)).toBe(llm(req2, mid));
			expect(llm(req3.slice(0, req1.length), mid)).toBe(llm(req1, mid));
		}
		expect(req3.filter(isFolded).length).toBe(req1.filter(isFolded).length);
		expect(sysAt(req3)).toEqual(sysAt(req1)); // still in place after persisting
	});

	test("a boundary summary starts in request N+1 and its kept prefix stays byte-identical", async () => {
		const r = await rig((sm) => populate(sm, 6000));
		sendPrompt(r.sm, "next request");
		await produced(r);
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(false);
		const a = r.sm.appendMessage(asst([call("c8")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("c8", "tiny", 10_000_002));
		const req2 = await r.request();
		for (const mid of [true, false]) expect(llm(req2.slice(0, req1.length), mid)).toBe(llm(req1, mid));
		const drafts = await r.turnEnd(a, asst([call("c8")], "toolUse"));
		expect(drafts[0].type).toBe("compaction");
		const req3 = await r.request();
		expect(req3.some((m) => m.role === "compactionSummary")).toBe(true);
		const kept = r.sm.buildSessionProjection().entries.find((e: Any) => e.sourceEntry.id === drafts[0].firstKeptEntryId) as Any;
		const at = req2.findIndex((m) => JSON.stringify(m) === JSON.stringify(kept.messages[0]));
		const after = req3.findIndex((m) => JSON.stringify(m) === JSON.stringify(kept.messages[0]));
		for (const mid of [true, false]) expect(llm(req3.slice(after), mid)).toBe(llm(req2.slice(at), mid));
	});

	test("a summary and a fold persisted together: Pi's 'Compacted from N' is its usage-based size before the edits, not chars/4 of a half-applied batch", async () => {
		const r = await rig((sm) => populate(sm, 6000), { tui: true });
		sendPrompt(r.sm, "next request");
		await produced(r);
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(false);
		// the response that carried the plan reports a real prompt size; the turn's tool result follows it
		const real = { ...usage, input: 40_000, totalTokens: 40_050 };
		const a = r.sm.appendMessage({ ...asst([call("c8")], "toolUse", 10_000_001), usage: real });
		r.sm.appendMessage(result("c8", "y".repeat(4_000), 10_000_002));
		const piBefore = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens; // what Pi reads before any draft
		expect(piBefore).toBe(40_050 + Math.ceil(4_000 / 4)); // usage + the trailing tool result at chars/4
		const all = await r.turnEnd(a, { ...asst([call("c8")], "toolUse"), usage: real });
		expect(all.find((d: Any) => d.customType === "pi-zip/commit")).toMatchObject({ type: "custom", data: { carried: true, next: true } }); // a run plan: the run's requests had carried these edits
		expect(all.filter((d: Any) => d.type === "custom").map((d: Any) => d.customType)).toEqual(["pi-zip/commit", "pi-zip/summary"]); // the record of the call, which ended inside the run
		const drafts = all.filter((d: Any) => d.type !== "custom");
		expect(drafts.map((d: Any) => d.type)).toEqual(["compaction", ...drafts.slice(1).map(() => "context_edit")]);
		expect(drafts.length).toBeGreaterThan(1); // a fold in the kept part rides along
		const comp = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
		expect(comp.tokensBefore).toBe(piBefore);
		const notice = (r.sm.getBranch().find((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind) as Any).data;
		expect(notice.before).toBe(piBefore);
	});

	test("our replayed system message equals pi-ai's getCurrentSystemMessage", async () => {
		const r = await rig();
		const msgs = r.projectionMessages();
		const ours = collapseSystem(msgs);
		const theirs = getCurrentSystemMessage(msgs as Any);
		expect(ours).toEqual(theirs as Any);
		const collapsed = collapseSystemMessages({ messages: convertToLlm(msgs) as Any });
		expect(collapsed.messages[0]).toMatchObject({ role: "system" });
	});

	test("aborted turn: the tool call without a result does not make the guard reject the save", async () => {
		const r = await rig();
		sendPrompt(r.sm, "next request");
		await r.request();
		const a = r.sm.appendMessage(asst([{ type: "text", text: "hm" }], "stop", 10_000_001));
		const entries = await r.turnEnd(a, asst([{ type: "text", text: "hm" }], "stop"));
		expect(entries.some((e: Any) => e.type === "context_edit")).toBe(true);
	});
});

for (const order of ORDERS) describe(`real Pi: a summary prepared while the user was away goes in through Pi's own compaction (pi-tricks §1b, variant 1) (Pi ${order} order)`, () => {
	beforeEach(() => { rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	/** The session as a file whose newest response is `agoMs` old (the rig of every other test is hours old: a cold session). */
	const template = (agoMs = 0) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 9000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		return file;
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; });

	test("a future start deadline is armed on session opening and prepares the return", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: true, idle: true, start: false }); // session_start only: no settle ever ran in this process
		await sleep(2_300); // the unlearned timer uses the first paying gap, TTL plus one second
		expect(r.narrativeCalls.length).toBe(1); // old code: 0 (armAway was reached only from settle)
		await r.prompt("next request");
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(r.narrativeCalls.length).toBe(1); // adopted at the return, not written again while the user waits
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	test("opening an old session starts no summary call: its return is a cold return, the run plan of its next prompt handles it (review P1-1)", async () => {
		for (const agoMs of [5_000, 240 * 60_000, 7_200 * 60_000]) { // all past the 1 s TTL: the cache the session left is dead
			const r = await rig(undefined, { file: template(agoMs), tui: true, native: false, idle: false, start: false });
			await sleep(300);
			expect([agoMs, r.narrativeCalls.length]).toEqual([agoMs, 0]); // old code: 1 within ms of session_start (delay max(0, last + 0.8 TTL - now) = 0)
		}
	});

	test("opening and typing in old history starts no call and installs no terminal listener", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		expect(r.inputListeners.size).toBe(0);
		for (const key of ["h", "i", "\x03", "/", "q"]) r.typeKey(key);
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(0);
		await r.shutdown();
	});

	test("the first prompt starts background production without waiting and a later decision takes it", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false, latencyMs: 2_000 });
		r.typeKey("h");
		await sleep(1_000); // typing the prompt takes 1 s of the 2 s call
		const t0 = performance.now();
		await r.prompt("hello");
		sendPrompt(r.sm, "hello");
		const req1 = await r.request();
		const waited = performance.now() - t0;
		expect(r.narrativeCalls.length).toBe(1); // the call the first decision started, not a second one
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(false);
		expect(req1.some(isFolded)).toBe(true);
		expect(waited).toBeLessThan(500); // 0.3.1: the rest of the call (~1 s)
		// the run's turn_end once the call is done: the summary goes in as its first draft
		await sleep(2_100);
		const a = r.sm.appendMessage(asst([call("k1")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("k1", "tiny", 10_000_002));
		const drafts = await r.turnEnd(a, asst([call("k1")], "toolUse"));
		expect(drafts[0].type).toBe("compaction"); // one decision persists folds and takes the ready summary
		await r.request(); // the next assistant response answers a new Pi request
		const b2 = r.sm.appendMessage(asst([call("k2")], "toolUse", 10_000_003));
		r.sm.appendMessage(result("k2", "tiny", 10_000_004));
		expect((await r.turnEnd(b2, asst([call("k2")], "toolUse"))).filter((d: Any) => d.type === "compaction")).toHaveLength(0); // the summary already entered at the first boundary
		expect(r.narrativeCalls.length).toBe(1);
	});

	// A display-only entry can start a turn; the actual prompt decides production on the resulting projection.
	test("a display-only entry before a prompt leaves one background call for that prompt", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false, latencyMs: 300 });
		r.sm.appendCustomMessageEntry("dsa-note", "1 subagent workflow was paused when pi quit", true);
		r.typeKey("h");
		await sleep(50);
		expect(r.narrativeCalls.length).toBe(0);
		await r.prompt("hello");
		sendPrompt(r.sm, "hello");
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(false); // still being written: nobody waits for it
		await sleep(400);
		const a = r.sm.appendMessage(asst([call("k1")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("k1", "tiny", 10_000_002));
		await r.turnEnd(a, asst([call("k1")], "toolUse"));
		await r.request(); // the next assistant response answers a new Pi request
		const b2 = r.sm.appendMessage(asst([call("k2")], "toolUse", 10_000_003));
		r.sm.appendMessage(result("k2", "tiny", 10_000_004));
		expect((await r.turnEnd(b2, asst([call("k2")], "toolUse"))).filter((d: Any) => d.type === "compaction")).toHaveLength(0); // the produced summary entered at the first boundary
		expect(r.narrativeCalls.length).toBe(1); // old code: 2 (the key's call cut at the note, the run plan one turn earlier)
		expect(r.sm.getEntries().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/summary" && !e.data?.cut)).toEqual([]); // no call ended unused
	});

	test("a restart whose start deadline is past opens quietly", async () => {
		process.env.PI_ZIP_TTL_SECS = "30";
		const r = await rig(undefined, { file: template(27_000), tui: true, native: false, idle: false, start: false });
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(0);
		expect(r.inputListeners.size).toBe(0);
		await r.shutdown();
	});

	test("sessions with and without a UI arm the same future deadline, including after a tool turn", async () => {
		const quiet = await rig(undefined, { file: template(), tui: false, start: false });
		await sleep(1_300);
		expect(quiet.narrativeCalls.length).toBe(1);
		const file = template();
		file.push({ type: "message", id: "tail", parentId: file.at(-1).id, timestamp: new Date().toISOString(), message: asst([call("zz")], "toolUse", 99) });
		const cut = await rig(undefined, { file, tui: true, start: false });
		await sleep(1_300);
		expect(cut.narrativeCalls.length).toBe(1);
	});

	test("a fresh room call teaches the producer latency used after restart", async () => {
		process.env.PI_ZIP_TTL_SECS = "300";
		process.env.PI_ZIP_COLD_CAP = "100000";
		const model = { ...MODEL, provider: "latency", id: `room-${order}`, contextWindow: 100_000 };
		const file = template();
		for (const entry of file) if (entry.message?.role === "assistant") delete entry.message.usage;
		const r = await rig(undefined, { file, tui: true, start: false, model, latencyMs: 80 });
		try {
			await r.runner.emit({ type: "agent_start" } as Any);
			expect(r.zip.bg).toBeNull();
			expect(loadStats().models[`latency/room-${order}`]?.call).toBeUndefined();
			const response = { ...asst([{ type: "text", text: "done" }]), timestamp: Date.now() };
			delete response.usage;
			const id = r.sm.appendMessage(response);
			const drafts = await r.turnEnd(id, response); // no run plan: the room starts its own fresh call
			const artifact = drafts.find((e) => e.customType === "pi-zip/summary").data;
			expect(drafts[0].type).toBe("compaction");
			expect(r.narrativeCalls).toHaveLength(1);
			const learned = loadStats().models[`latency/room-${order}`].call!;
			expect(learned.ms).toBeGreaterThanOrEqual(80);
			expect(learned).toEqual({ ms: artifact.cut.ms, tokens: artifact.cut.prefixTokens * r.zip.scaleOf(r.runner.createContext()).c });
			expect(r.zip.ent.call).toEqual(learned);
			await r.shutdown();
			// Reopen the pre-edit branch: call times are shared by model, even when this branch has no ready artifact.
			const realSet = globalThis.setTimeout, realNow = Date.now;
			const deadlines = new Map<Any, number>();
			const now = realNow();
			(globalThis as Any).setTimeout = (fn: () => void, ms: number) => {
				const handle = realSet(fn, ms);
				deadlines.set(handle, now + ms);
				return handle;
			};
			Date.now = () => now;
			let restarted: Awaited<ReturnType<typeof rig>> | undefined;
			try {
				restarted = await rig(undefined, { file, tui: true, start: false, model });
				const ctx = restarted.runner.createContext();
				const view = restarted.sm.buildSessionProjection().entries;
				const p = planContext(view, restarted.zip.opts(ctx, true, view, 1, true, undefined, false, []).o)!;
				const touch = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
				const expected = touch + 300_000 - 1.5 * learned.ms * p.scale.c * p.prefixTokens / learned.tokens;
				expect(restarted.zip.ent.call).toEqual(learned);
				expect(deadlines.get(restarted.zip.timer)).toBeCloseTo(expected, 5);
				expect(restarted.narrativeCalls).toHaveLength(0);
				expect(loadStats().models[`latency/room-${order}`].call).toEqual(learned);
			} finally {
				globalThis.setTimeout = realSet;
				Date.now = realNow;
				await restarted?.shutdown();
			}
		} finally { await r.shutdown(); }
	});

	for (const outcome of ["aborted reply", "expired signal"] as const) test(`partial ${outcome} retains its charge and still makes the fallback summary, ready at once`, async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, start: false });
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		const timeout = AbortSignal.timeout, expired = new AbortController();
		let calls = 0;
		AbortSignal.timeout = (ms: number) => ms === 240_000 ? expired.signal : timeout(ms);
		ctx.modelRegistry.complete = async (...args: Any[]) => {
			if (++calls > 1) return provider(...args);
			if (outcome === "expired signal") expired.abort();
			return { stopReason: outcome === "aborted reply" ? "aborted" : "stop", content: [{ type: "text", text: "partial narrative" }], usage: { cost: { total: 0.12 } } };
		};
		try {
			const view = r.sm.buildSessionProjection().entries;
			const p = planContext(view, r.zip.opts(ctx, true, view, 0, true).o)!;
			r.zip.want("run", ctx, p);
			expect(r.zip.bg).toBeTruthy();
			expect(await r.zip.bg.promise).toMatchObject({ llmOk: false, llmError: "narrative aborted", firstKeptEntryId: p.firstKeptEntryId });
			expect(calls).toBe(1); // abort is terminal, even if the provider did not abort the signal
			expect(r.zip.bg).toBeNull();
			expect(r.zip.ready(r.sm.getBranch())).toHaveLength(1);
			const arts = r.sm.getEntries().filter((e: Any) => e.customType === "pi-zip/summary") as Any[];
			expect(arts).toHaveLength(1);
			expect(arts[0].data).toMatchObject({ key: p.firstKeptEntryId, usd: 0.12, cut: { llmOk: false, llmError: "narrative aborted" } });
			expect(arts[0].data.lost).toBeUndefined();
			expect(r.zip.stats.summaryUsd).toBe(0.12);
			AbortSignal.timeout = timeout;
			r.zip.want("run", ctx, p); // the cut has its summary: no second call for it
			expect(r.zip.bg).toBeNull();
			expect(calls).toBe(1);
			expect(r.zip.ready(r.sm.getBranch())).toHaveLength(1);
			expect(r.zip.stats.summaryUsd).toBe(0.12);
		} finally {
			AbortSignal.timeout = timeout;
			ctx.modelRegistry.complete = provider;
			await r.shutdown();
		}
	});

	// 0.4.0/0.4.1 capped the narrative call at its 4,000-token budget: on a real CJK session every call hit the cap (5,331 tokens out)
	// and no summary was ever applied while the context grew from 161K to 437K
	for (const fails of [false, true]) test(`a narrative ${fails ? "that fails" : "longer than its budget"} still becomes the summary Pi compacts with`, async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false });
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		const caps: number[] = [];
		// the reply needs 5,400 tokens: a provider cuts it at any cap below that
		ctx.modelRegistry.complete = async (m: Any, req: Any, options: Any) => {
			caps.push(options?.maxTokens);
			const res = await provider(m, req, options);
			return fails || options?.maxTokens < 5400 ? { ...res, stopReason: "length" } : res;
		};
		try {
			const view = r.sm.buildSessionProjection().entries;
			const p = planContext(view, r.zip.opts(ctx, true, view, 0, true).o)!;
			expect(r.zip.startBg(p, ctx)).toBe(true);
			expect((await r.zip.bg.promise)?.llmOk).toBe(!fails);
			expect(caps).toEqual([MODEL.maxTokens]);
			expect(r.zip.ready(r.sm.getBranch())).toHaveLength(1);
			await r.prompt();
			expect(r.compactions).toHaveLength(1);
			expect(r.compactions[0].details.via).toBe("native");
			const compaction = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
			expect(compaction.firstKeptEntryId).toBe(p.firstKeptEntryId);
			expect(compaction.summary.includes("## Narrative (model-written)")).toBe(!fails);
			expect(caps).toHaveLength(1);
			// /zip says so: how many narrative calls failed, and why the newest did
			expect(r.zip.card(ctx).failed).toBe(fails ? 1 : undefined);
			if (fails) {
				expect(r.zip.card(ctx).failedWhy).toMatch(/^\d\d:\d\d narrative hit the token cap/); // today: the time alone
				const e = r.sm.getBranch().filter((x: Any) => x.customType === "pi-zip/summary").at(-1) as Any;
				e.timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
				expect(r.zip.card(ctx).failedWhy, "an old failure carries its date").toMatch(/^\d\d-\d\d \d\d:\d\d narrative hit the token cap/);
			}
		} finally {
			ctx.modelRegistry.complete = provider;
			await r.shutdown();
		}
	});

	// 0.4.1-0.4.4 (P1): sota gpt-6.1-sol refuses a request without reasoning (pi-ai sends effort "none" when none is asked for), so
	// every narrative on it failed (84 calls in 56 minutes on one session with 0.4.1; a skeleton-only summary with 0.4.4)
	test("a narrative on a reasoning model that refuses effort none is asked again with low effort", async () => {
		const model = { ...MODEL, provider: "sota", id: `refuses-none-${order}`, reasoning: true };
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, start: false, model });
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		const efforts: (string | undefined)[] = [];
		ctx.modelRegistry.complete = async (m: Any, req: Any, options: Any) => {
			efforts.push(options?.reasoningEffort);
			if (!options?.reasoningEffort) return { stopReason: "error", content: [], usage: { cost: { total: 0 } },
				errorMessage: "unsupported_value: Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'." };
			return provider(m, req, options);
		};
		try {
			const view = r.sm.buildSessionProjection().entries;
			const p = planContext(view, r.zip.opts(ctx, true, view, 0, true).o)!;
			expect(r.zip.startBg(p, ctx)).toBe(true);
			expect((await r.zip.bg.promise)?.llmOk, "a narrative refused for its reasoning effort is retried with low effort").toBe(true);
			expect(efforts).toEqual([undefined, "low"]); // the refused call does not use up the retry
		} finally {
			ctx.modelRegistry.complete = provider;
			await r.shutdown();
		}
	});

	for (const door of ["native", "draft"] as const) test(`a retried summary retains every attempt's charge before ${door} application, after it and after restart`, async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false });
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		let calls = 0, restarted: Awaited<ReturnType<typeof rig>> | undefined;
		ctx.modelRegistry.complete = async (...args: Any[]) => ++calls === 1
			? { stopReason: "error", errorMessage: "transient error", usage: { cost: { total: 0.02 } } }
			: { ...await provider(...args), usage: { cost: { total: 0.03 } } };
		try {
			const view = r.sm.buildSessionProjection().entries;
			const p = planContext(view, r.zip.opts(ctx, true, view, 0, true).o)!;
			expect(r.zip.startBg(p, ctx)).toBe(true);
			expect((await r.zip.bg.promise)?.llmOk).toBe(true);
			expect(calls).toBe(2);
			const artifact = r.sm.getEntries().find((e: Any) => e.customType === "pi-zip/summary") as Any;
			expect(artifact.data.usd).toBe(0.05);
			expect(r.zip.totals(ctx).usd).toBe(0.05);
			if (door === "native") {
				await r.prompt();
				expect(r.compactions).toHaveLength(1);
				expect(r.compactions[0].details.via).toBe("native");
			} else {
				await r.runner.emit({ type: "agent_start" } as Any);
				r.sm.appendCustomMessageEntry("summary-drive", "continue", true);
				await r.request();
				const response = asst([{ type: "text", text: "finished" }]);
				const drafts = await r.turnEnd(r.sm.appendMessage(response), response);
				expect(drafts[0]).toMatchObject({ type: "compaction", firstKeptEntryId: p.firstKeptEntryId });
				expect(r.compactCalls.n).toBe(0);
			}
			const compaction = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
			expect(compaction.usage.cost.total).toBe(0.05);
			expect(r.zip.totals(ctx)).toMatchObject({ summaries: 1, usd: 0.05 });
			await r.shutdown();
			restarted = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restarted.zip.totals(restarted.runner.createContext())).toMatchObject({ summaries: 1, usd: 0.05 });
		} finally {
			ctx.modelRegistry.complete = provider;
			await restarted?.shutdown();
			await r.shutdown();
		}
	});

	test("one room compaction consumes one identical summary call and preserves every charge after restart", async () => {
		process.env.PI_ZIP_TTL_SECS = "300";
		process.env.PI_ZIP_COLD_CAP = "100000";
		const model = { ...MODEL, contextWindow: 100_000 };
		const r = await rig((sm) => {
			for (let i = 0; i < 6; i++) {
				sm.appendMessage(user(`turn ${i + 1}`));
				sm.appendMessage({ ...asst([{ type: "text", text: "x".repeat(140_000) }]), usage: undefined });
			}
		}, { model, start: false });
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		let calls = 0, restarted: Awaited<ReturnType<typeof rig>> | undefined;
		ctx.modelRegistry.complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "detail ".repeat(5000) }], usage: { cost: { total: ++calls / 10 } } });
		try {
			await r.runner.emit({ type: "agent_start" } as Any);
			const response = { ...asst([{ type: "text", text: "done" }]), timestamp: Date.now(), usage: undefined };
			const id = r.sm.appendMessage(response), view = r.sm.buildSessionProjection().entries;
			const decide = () => decideTurnEnd({ failed: false, justEdited: false, pWarm: 1, ready: r.zip.ready(r.sm.getBranch()), entries: view,
				opts: (cutAt, foldsOnly, ready) => r.zip.opts(ctx, false, view, 1, false, cutAt, foldsOnly, ready) });
			const initial = decide();
			expect(initial.room?.cutIdx).toBeGreaterThan(0);
			expect(r.zip.startBg(initial.room, ctx)).toBe(true);
			const first = await r.zip.bg.promise;
			expect(first.llmOk).toBe(true);
			expect(r.zip.ready(r.sm.getBranch())).toHaveLength(1);
			const selected = decide();
			expect(selected.kind).toBe("plan");
			expect(selected.p?.firstKeptEntryId).toBe(first.firstKeptEntryId);
			expect(selected.p?.summaryTokensPlanned).toBe(first.summaryTokens);
			expect(selected.room?.firstKeptEntryId).toBe(first.firstKeptEntryId); // the finished summary still leaves the view at the room
			const drafts = await r.turnEnd(id, response);
			expect(calls).toBe(2); // R9 requires a fresh call even with this cut already READY
			expect(drafts[0]).toMatchObject({ type: "compaction", firstKeptEntryId: first.firstKeptEntryId, summary: first.text });
			const branch = r.sm.getBranch() as Any[], artifacts = branch.filter((e) => e.customType === "pi-zip/summary");
			expect(artifacts.map((e) => e.data.usd)).toEqual([0.1, 0.2]);
			expect(artifacts.map((e) => e.data.cut.text)).toEqual([first.text, first.text]);
			expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
			expect((branch.find((e) => e.type === "compaction") as Any).usage.cost.total).toBe(0.2);
			expect(unusedOf(branch)).toEqual({ n: 1, usd: 0.1 });
			expect(r.zip.stats.summaryUsd).toBeCloseTo(0.3, 10);
			expect(r.zip.totals(ctx)).toMatchObject({ summaries: 1, usd: expect.closeTo(0.3, 10) });
			await r.shutdown();
			restarted = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], model, start: false });
			expect(unusedOf(restarted.sm.getBranch())).toEqual({ n: 1, usd: 0.1 });
			expect(restarted.zip.totals(restarted.runner.createContext())).toMatchObject({ summaries: 1, usd: expect.closeTo(0.3, 10) });
			expect(restarted.narrativeCalls).toHaveLength(0);
		} finally {
			ctx.modelRegistry.complete = provider;
			await restarted?.shutdown();
			await r.shutdown();
		}
	});

	for (const interrupt of ["none", "Esc", "off", "off/on"] as const) test(`room replacement supersedes a queued ordinary cut until delayed cancellation acknowledgment (${interrupt})`, async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, start: false });
		const ctx = r.runner.createContext();
		const provider = ctx.modelRegistry.complete;
		let active = 0, peak = 0;
		const releases: (() => void)[] = [];
		ctx.modelRegistry.complete = async (...args: Any[]) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await new Promise<void>((resolve) => releases.push(resolve)); // provider acknowledges abort only when released
				return await provider(...args);
			} finally { active--; }
		};
		try {
			const view = r.sm.buildSessionProjection().entries;
			const p = planContext(view, r.zip.opts(ctx, true, view, 0, true).o)!;
			expect(r.zip.startBg(p, ctx)).toBe(true);
			await sleep(0);
			const old = r.zip.bg;
			expect(active).toBe(1);
			const controller = new AbortController();
			const options = r.zip.opts(ctx, true, view, 0, true).o;
			const queued = planContext(view, { ...options, coldCap: 60_000 })!;
			const replacement = planContext(view, { ...options, coldCap: 40_000 })!;
			expect(replacement.cutIdx).toBeGreaterThan(0);
			expect(replacement.firstKeptEntryId).not.toBe(p.firstKeptEntryId);
			r.zip.discardBg("replaced");
			expect(queued.firstKeptEntryId).not.toBe(replacement.firstKeptEntryId);
			expect(r.zip.startBg(queued, ctx)).toBe(false); // an ordinary producer queued its replacement before the room takes ownership
			let finished = false;
			const waiting = r.zip.roomWait(replacement, { ...ctx, signal: controller.signal }).then((got: Any) => { finished = true; return got; });
			await sleep(0);
			expect(old.controller.signal.aborted).toBe(true);
			expect(r.zip.bg).toBe(old);
			expect(active).toBe(1);
			expect(releases).toHaveLength(1);
			if (interrupt === "Esc") {
				controller.abort();
				expect(await waiting).toBeNull(); // Esc does not wait for the provider
				expect(r.zip.bg).toBe(old);
			} else {
				expect(finished).toBe(false);
				if (interrupt !== "none") r.zip.setOff(true);
				if (interrupt === "off/on") r.zip.setOff(false);
			}
			releases[0]();
			expect(await old.promise).toBeNull();
			await sleep(0);
			if (interrupt === "none") {
				expect(releases).toHaveLength(2);
				expect(active).toBe(1);
				releases[1]();
				expect((await waiting)?.cut).toMatchObject({ llmOk: true, firstKeptEntryId: replacement.firstKeptEntryId });
			} else {
				expect(releases).toHaveLength(1);
				expect(await waiting).toBeNull();
				expect(active).toBe(0);
			}
			expect(peak).toBe(1);
			expect(r.zip.bg).toBeNull();
		} finally {
			for (const release of releases) release();
			ctx.modelRegistry.complete = provider;
			await r.shutdown();
		}
	});

	for (const phase of ["cancellation", "completion"] as const) for (const resume of [false, true]) test(`turn_end discards newly selected edits when disabled during room ${phase} (resume=${resume})`, async () => {
		process.env.PI_ZIP_COLD_CAP = "100000";
		const file = template(240 * 60_000);
		for (const entry of file) if (entry.message?.role === "assistant") delete entry.message.usage;
		file.find((e) => e.message?.role === "toolResult").message.content = [{ type: "text", text: bulk("output", 6000) }];
		const initial = SessionManager.inMemory(CWD, undefined, file);
		initial.appendCustomEntry("pi-zip/rent", { rent: 10_000 });
		const r = await rig(undefined, { file: [initial.getHeader() as Any, ...initial.getEntries()], tui: true, start: false, model: { ...MODEL, contextWindow: 100_000 } });
		let restored: Awaited<ReturnType<typeof rig>> | undefined;
		const ctx = r.runner.createContext(), provider = ctx.modelRegistry.complete;
		const releases: (() => void)[] = [];
		try {
			await r.runner.emit({ type: "agent_start" } as Any);
			const view = r.sm.buildSessionProjection().entries;
			const options = r.zip.opts(ctx, true, view, 0, true).o;
			const shallow = planContext(view, { ...options, coldCap: 200_000 })!;
			const response = { ...asst([{ type: "text", text: "finished" }]), timestamp: Date.now(), usage: undefined };
			const id = r.sm.appendMessage(response);
			const entries = r.sm.buildSessionProjection().entries;
			const d = decideTurnEnd({ failed: false, justEdited: false, pWarm: 1, ready: r.zip.ready(r.sm.getBranch()), entries,
				opts: (cutAt, foldsOnly, ready) => r.zip.opts(ctx, false, entries, 1, false, cutAt, foldsOnly, ready) });
			expect(d.kind).toBe("plan");
			expect(d.kind === "plan" && d.p?.folds.length).toBeGreaterThan(0); // newly selected folds must also be rejected after deactivation
			expect(d.kind !== "none" && d.o.law?.pWarm).toBe(1);
			expect(d.kind !== "none" && d.rentNext).toBe(0);
			expect(r.zip.rent).toBe(10_000);
			expect(d.room?.cutIdx).toBeGreaterThan(0);
			expect(d.room?.firstKeptEntryId).not.toBe(shallow.firstKeptEntryId);
			ctx.modelRegistry.complete = async (...args: Any[]) => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return provider(...args);
			};
			expect(r.zip.startBg(phase === "cancellation" ? shallow : d.room, ctx, true)).toBe(true);
			await sleep(0);
			const old = r.zip.bg;
			const waiting = r.turnEnd(id, response);
			await sleep(0);
			expect(old.controller.signal.aborted).toBe(phase === "cancellation");
			expect(releases).toHaveLength(1);
			r.zip.setOff(true);
			if (resume) r.zip.setOff(false);
			releases[0]();
			expect(await old.promise).toBeNull();
			await sleep(0);
			const calls = releases.length;
			for (const release of releases) release(); // finish a wrongly started replacement before reporting the regression
			const drafts = await waiting;
			expect(calls).toBe(1);
			expect(drafts.some((d) => d.type === "compaction" || d.type === "context_edit")).toBe(false);
			expect(r.zip.stats.summaries).toBe(0);
			expect(r.zip.bg).toBeNull();
			expect(drafts.some((d) => d.customType === "pi-zip/rent")).toBe(false);
			expect(r.zip.rent).toBe(10_000);
			expect(rentOf(r.sm.getBranch())).toBe(10_000);
			restored = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], start: false });
			expect(restored.zip.rent).toBe(10_000);
			await restored.prompt();
			expect(restored.zip.rent).toBe(10_000);
		} finally {
			for (const release of releases) release();
			ctx.modelRegistry.complete = provider;
			await restored?.shutdown();
			await r.shutdown();
		}
	});

	test("a measured-latency timer invalidating a running cut persists its loss after the callback", async () => {
		delete process.env.PI_ZIP_TTL_SECS;
		process.env.PI_ZIP_COLD_CAP = "100000";
		const model = { ...MODEL, provider: "timer", id: "replacement" };
		record("timer/replacement", { explicit: true, total: 0, gapS: 300, alive: false, call: { ms: 200, tokens: 60_000 } });
		const r = await rig(undefined, { file: template(), tui: true, start: false, model, latencyMs: 500 });
		const originalOpts = r.zip.opts.bind(r.zip);
		r.zip.opts = (...args: Any[]) => { const r = originalOpts(...args); r.o.law.g = 5000; return r; };
		const realSet = globalThis.setTimeout, realNow = Date.now;
		const callbacks = new Map<Any, { fire: () => void; due: number }>();
		let inTimer = false, timerWrites = 0;
		const append = r.zip.pi.appendEntry;
		r.zip.pi.appendEntry = (type: string, data: Any) => {
			if (inTimer) timerWrites++;
			return append(type, data);
		};
		(globalThis as Any).setTimeout = (fn: () => void, ms: number) => {
			const handle = realSet(fn, ms);
			callbacks.set(handle, { fire: fn, due: realNow() + ms });
			return handle;
		};
		try {
			await r.settle();
			const running = r.zip.bg;
			expect(running).toBeTruthy();
			const timer = callbacks.get(r.zip.timer)!;
			expect(timer).toBeTruthy(); // warm and pause cuts differ, so a running call still leaves a pause deadline
			const lastTouch = Math.max(...(r.sm.getBranch() as Any[]).map((e) => e.message?.timestamp ?? 0));
			expect(timer.due).toBeLessThan(lastTouch + 300_000); // a measured lead starts before the first paying gap
			await sleep(10);
			expect(r.narrativeCalls).toHaveLength(1);
			const keep = (r.sm.getBranch() as Any[]).filter((e) => e.type === "message" && e.message.role === "user")[3];
			r.sm.appendCompaction("short history", keep.id, 12_000, { by: "other" }, true);
			clearTimeout(r.zip.timer);
			Date.now = () => timer.due + 1;
			inTimer = true;
			try { timer.fire(); } finally { inTimer = false; Date.now = realNow; }
			expect(timerWrites).toBe(0);
			expect(running.controller.signal.aborted).toBe(true);
			expect(r.zip.stats.summaryUsd).toBeGreaterThanOrEqual(running.estUsd);
			expect(r.sm.getEntries().filter((e: Any) => e.customType === "pi-zip/summary")).toHaveLength(0);
			expect(r.zip.bg).toBe(running); // cancellation retains the slot while the provider ignores abort
			expect(await running.promise).toBeNull(); // completion persists the cancellation exactly once
			const lost = () => r.sm.getEntries().filter((e: Any) => e.customType === "pi-zip/summary" && e.data.lost === "replaced") as Any[];
			expect(lost()).toHaveLength(1);
			expect(lost()[0].data).toMatchObject({ key: running.key, head: running.head, usd: running.estUsd, estimated: true });
			await sleep(550);
			expect(lost()).toHaveLength(1); // the late provider completion cannot record or charge the aborted call again
			expect(r.zip.stats.summaryUsd).toBeCloseTo(running.estUsd, 9);
		} finally {
			globalThis.setTimeout = realSet;
			Date.now = realNow;
			await r.shutdown();
		}
	});

	test("the timer re-plans after a compaction instead of using a cached settle plan", async () => {
		process.env.PI_ZIP_TTL_SECS = "0.1";
		const r = await rig(undefined, { file: template(3_600_000), tui: true, native: false, idle: false, start: false });
		// Replacing the old history leaves a short prefix whose production pays only after a pause.
		const branch = r.sm.getBranch() as Any[];
		const keep = branch.filter((e) => e.type === "message" && e.message.role === "user")[3];
		r.sm.appendCompaction("short history", keep.id, 12_000, { by: "pi-zip" }, true);
		await r.runner.emit({ type: "session_start", reason: "resume" } as Any);
		await r.settle();
		await sleep(1_250);
		expect(r.narrativeCalls.length).toBe(1);
		const read = JSON.stringify(r.narrativeCalls[0]);
		expect(read).toContain("request 4");
		expect(read).not.toContain("request 1");
		await r.shutdown();
	});
});
// A run an extension's message starts (sendMessage with triggerTurn): Pi 1.1.0 fires agent_start only, Pi 1.2.0 before_agent_start with
// messageType "custom" first. Either way it begins once, as a driven run, and never compacts.
for (const order of ORDERS) describe(`item 5: a run an extension's message starts (sendMessage with triggerTurn) begins once as a driven run (Pi ${order} order)`, () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = (agoMs: number) => shiftedFile(agoMs, 9000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	/** What Pi does for sendCustomMessage({ ..., triggerTurn: true }) on an idle session: the run's start, the message appended, the first request. */
	const drive = async (r: Any, text = "drive the owed work") => {
		await r.drive(text);
		return r.request();
	};

	test("a driven run after a gap longer than the TTL gets the cold plan (old code: no plan, a full cold rewrite of the whole context)", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		const req = await drive(r);
		expect(req.some(isFolded)).toBe(true); // the cold plan's folds; its summary is written in the background (nobody waits)
		expect(req.some((m) => m.role === "compactionSummary")).toBe(false);
		await sleep(20);
		expect(r.narrativeCalls.length).toBe(1);
		expect(req.some((m) => m.role === "custom")).toBe(true); // the message that started the run is kept
	});

	test("with the idle door off, a driven run defers its ready summary to the first turn_end and never calls ctx.compact()", async () => {
		process.env.PI_ZIP_IDLE_DOOR = "0";
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false });
		await r.settle(); // the end of a run asks the shared producer about the next return
		await sleep(150);
		expect(r.narrativeCalls.length).toBe(1);
		const req = await drive(r);
		expect(r.narrativeCalls.length).toBe(1); // adopted, not written again
		expect(r.compactCalls.n).toBe(0);
		expect(req.some((m) => m.role === "compactionSummary")).toBe(false);
		const response = asst([call("driven")], "toolUse");
		const id = r.sm.appendMessage(response);
		r.sm.appendMessage(result("driven", "short output"));
		const before = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens;
		const drafts = await r.turnEnd(id, response);
		expect(drafts[0].type).toBe("compaction");
		const comp = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
		const notice = r.sm.getBranch().find((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind) as Any;
		expect(comp.tokensBefore).toBe(before);
		expect(notice.data.before).toBe(before);
		expect(notice.data.desc).toMatch(/ready while you were away$/); // ready before the run began (0.4.5 said "written while you worked")
		expect((await r.request()).some((m) => m.role === "compactionSummary")).toBe(true);
	});

	// 0.4.0 took a "custom" before_agent_start (Pi 1.2.0) for a prompt and began the run again at its first message_end
	test("a driven run begins once: one start of run, one driven_run record, no prompt decision", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pz-driven-once-")), ledger = join(dir, "ledger.jsonl"), saved = process.env.PI_ZIP_LEDGER;
		process.env.PI_ZIP_LEDGER = ledger;
		try {
			const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false });
			let begun = 0;
			const begin = r.zip.beginRun.bind(r.zip);
			r.zip.beginRun = (...a: Any[]) => (begun++, begin(...a));
			await drive(r);
			const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect([begun, rows.filter((x) => x.type === "driven_run").length, rows.filter((x) => x.type === "prompt").length]).toEqual([1, 1, 1]);
			expect(r.compactCalls.n).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.PI_ZIP_LEDGER;
			else process.env.PI_ZIP_LEDGER = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a prompt begins its run once: input decides, before_agent_start and agent_start start one run", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		let begun = 0;
		const begin = r.zip.beginRun.bind(r.zip);
		r.zip.beginRun = (...a: Any[]) => (begun++, begin(...a));
		await r.prompt("next request");
		sendPrompt(r.sm, "next request");
		const req = await r.request();
		await sleep(20);
		expect(begun).toBe(1);
		expect(r.narrativeCalls.length).toBe(1); // one start of the run: one summary call
		expect(req.some(isFolded)).toBe(true);
	});

	// review P2: before_agent_start fired, then the prompt failed before its run started (Pi's image normalisation throws between the two):
	// no agent_start, no agent_end. The next driven run is planned as the cold return it is, not on the failed prompt's start
	test("a prompt that fails before its run starts does not swallow the next driven run's start", async () => {
		const r = await rig(undefined, { file: template(0), tui: true, native: false, idle: false, start: false });
		await r.prompt("look at this image", { fail: true }); // warm (the session's last response is 0 s old); then the prompt throws
		await sleep(1_300); // past the 1 s TTL
		await drive(r);
		const response = asst([{ type: "text", text: "done" }], "stop", 10_000_001);
		await r.turnEnd(r.sm.appendMessage(response), response);
		const notice = (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
		expect(notice?.why).toMatch(/^cache cold/); // old code: a warm plan ("cache warm · ...") or none
	});

	test("a warm driven run (inside the TTL) is planned exactly as a warm prompt is (the valve), not as a cold return", async () => {
		process.env.PI_ZIP_TTL_SECS = "300";
		const driven = await rig(undefined, { file: template(2_000), tui: true, native: false, idle: false, start: false });
		const dReq = await drive(driven);
		const prompted = await rig(undefined, { file: template(2_000), tui: true, native: false, idle: false, start: false });
		await prompted.prompt("next request");
		sendPrompt(prompted.sm, "next request");
		const pReq = await prompted.request();
		await new Promise((res) => setTimeout(res, 50)); // a summary starts in the background: its call is made off the request path
		expect(driven.narrativeCalls.length).toBe(prompted.narrativeCalls.length);
		expect(dReq.some(isFolded)).toBe(pReq.some(isFolded));
		expect(dReq.some((m) => m.role === "compactionSummary")).toBe(pReq.some((m) => m.role === "compactionSummary"));
	});
});

// 0.4.1: the typed-prompt door is Pi's input event, where Pi is idle on 1.1.0 and on 1.2.0 (1.2.0 counts the starting run as busy from
// before_agent_start on: 0.4.0's door there stayed closed, and the first request carried the whole old history).
for (const order of ORDERS) describe(`the typed-prompt door opens at Pi's input event (Pi ${order} order)`, () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	// the typed door alone: the idle door would take the ready summary before the prompt comes (its own describe below)
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; process.env.PI_ZIP_IDLE_DOOR = "0"; rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	/** A cold session whose return summary is ready (the producer wrote it while the user was away). */
	const readyRig = async (o: Partial<RigOpts> = {}) => {
		const r = await rig(undefined, { file: shiftedFile(240 * 60_000, 9000), tui: true, native: true, idle: true, start: true, ...o }); // a run of this process (the door opens only after one)
		await r.settle();
		await sleep(150);
		expect(r.narrativeCalls.length).toBe(1);
		return r;
	};

	for (const text of ["Continue with the task.", "/review the open work"]) test(`a typed prompt takes the ready summary through Pi's compaction, and its own run's first request carries that decision (${text.startsWith("/") ? "a /template, priced unexpanded" : "plain text"})`, async () => {
		const r = await readyRig();
		const idleAtCompact: boolean[] = [];
		const compact = r.zip.nativeSummary.bind(r.zip);
		r.zip.nativeSummary = (ctx: Any, ...a: Any[]) => (idleAtCompact.push(ctx.isIdle()), compact(ctx, ...a));
		await r.prompt(text);
		expect(idleAtCompact).toEqual([true]);
		expect(r.compactCalls.n).toBe(1);
		expect(r.compactions[0].details).toMatchObject({ by: "pi-zip", via: "native", trigger: "cold" });
		const carried = r.zip.nativeRun;
		expect(carried?.before).toBe(r.compactions[0].tokensBefore);
		sendPrompt(r.sm, text);
		const req = await r.request();
		expect(req.find((m: Any) => m.role === "compactionSummary")?.summary).toBe(r.compactions[0].summary);
		expect(r.zip.runPlan.native.text).toBe(r.compactions[0].summary);
		expect(r.zip.runPlan.ctxBefore).toBe(r.compactions[0].tokensBefore);
		expect(r.zip.runPlan.folds.map((t: Any) => t.entryId)).toEqual(carried.p.folds.map((t: Any) => t.entryId));
		await sleep(5);
		const notice = (r.sm.getBranch().filter((e: Any) => e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any).data;
		expect(notice.before).toBe(r.compactions[0].tokensBefore); // Pi's "Compacted from N" is the notice's before
		expect(notice.native).toBe("ok");
	});

	for (const behavior of ["steer", "followUp"] as const) test(`a ${behavior} typed while the run streams does not open the door`, async () => {
		const r = await readyRig();
		await r.drive(); // a run is streaming; its ready summary waits for turn_end (never a compaction inside a run)
		const started = r.zip.start;
		await r.steer("also look at the logs", behavior);
		expect(r.compactCalls.n).toBe(0);
		expect(r.zip.start).toBe(started); // and leaves the start of the run in progress alone
		expect(r.sm.getBranch().some((e: Any) => e.type === "compaction")).toBe(false);
	});

	const ledgerOf = (r: Any) => {
		const out: Any[] = [];
		const ledger = r.zip.ledger;
		r.zip.ledger = (rec: Any) => (out.push(rec), ledger(rec));
		return out;
	};

	if (order === "1.2") test("a steer typed into the starting run (busy from before_agent_start on, before agent_start) leaves the prompt's decision to its run", async () => {
		const r = await readyRig();
		await r.prompt("Continue with the task.", { afterStart: () => r.steer("also look at the logs") });
		expect(r.compactCalls.n).toBe(1);
		expect(r.zip.nativeRun?.before).toBe(r.compactions[0].tokensBefore); // the steer did not take the run's start from it
		sendPrompt(r.sm, "Continue with the task.");
		await r.request();
		expect(r.zip.runPlan.native.text).toBe(r.compactions[0].summary);
	});

	// an input without streamingBehavior while Pi is busy (prompt() called during a run's start, as RPC can: Pi throws only after the
	// input handlers ran) changes nothing of the run already announced
	if (order === "1.2") test("a prompt sent into the starting run (no streamingBehavior, Pi busy) leaves the prompt's decision to its run", async () => {
		const r = await readyRig();
		await r.prompt("Continue with the task.", { afterStart: () => r.runner.emitInput("again", undefined, "rpc", undefined) });
		expect(r.compactCalls.n).toBe(1);
		expect(r.zip.nativeRun?.before).toBe(r.compactions[0].tokensBefore);
	});
	if (order === "1.2") test("a custom run begins once when a prompt (no streamingBehavior, Pi busy) lands in its before_agent_start", async () => {
		const r = await readyRig();
		const led = ledgerOf(r);
		const bas = r.zip.beforeAgentStart.bind(r.zip);
		r.zip.beforeAgentStart = async (ctx: Any, e: Any) => {
			await bas(ctx, e);
			await r.runner.emitInput("again", undefined, "rpc", undefined);
		};
		await r.drive();
		expect(led.filter((x: Any) => x.type === "driven_run").length).toBe(1);
	});

	test("another compaction between the prompt's input and its run (Pi's own, say) voids the carried decision: the run reads its own start", async () => {
		const r = await readyRig();
		const led = ledgerOf(r);
		await r.prompt("Continue with the task.", { afterInput: () => void r.sm.appendCompaction("Pi's own summary.", r.compactions[0].firstKeptEntryId, 50_000, undefined, false) });
		expect(r.compactCalls.n).toBe(1);
		expect(led).toContainEqual(expect.objectContaining({ type: "start_dropped", reason: "the projection changed between the prompt and its run", native: true }));
		expect(r.zip.nativeRun).toBeNull();
	});

	test("another model chosen before the run (a before_agent_start handler, say) voids the carried decision: the run reads its own start", async () => {
		const r = await readyRig();
		const led = ledgerOf(r);
		await r.prompt("Continue with the task.", { afterStart: () => r.setModel({ ...MODEL, provider: "other", id: `switched-${order}` }) });
		expect(r.compactCalls.n).toBe(1);
		expect(led).toContainEqual(expect.objectContaining({ type: "start_dropped", reason: "the model changed between the prompt and its run", native: true }));
		expect(r.zip.nativeRun).toBeNull();
		expect(r.zip.model.id).toBe(`switched-${order}`);
	});

	test("two inputs that overlap (Pi's queue after a compaction sends the rest without waiting) ask for one compaction; the first keeps its decision", async () => {
		const r = await readyRig();
		const led = ledgerOf(r);
		await Promise.all([r.runner.emitInput("Continue with the task.", undefined, "interactive", undefined), r.runner.emitInput("and the tests", undefined, "interactive", undefined)]);
		expect(r.compactCalls.n).toBe(1);
		expect(r.compactions).toHaveLength(1);
		expect(led).toContainEqual(expect.objectContaining({ type: "native_skip", reason: "an earlier input is still being handled" }));
		expect(r.zip.start?.nat?.before).toBe(r.compactions[0].tokensBefore);
	});

	test("a run that starts while a prompt's input is handled takes nothing of it, and nothing is left for a later run", async () => {
		const r = await readyRig();
		const led = ledgerOf(r);
		await Promise.all([r.runner.emitInput("Continue with the task.", undefined, "interactive", undefined), r.drive()]);
		expect(r.zip.start).toBeNull();
		expect(led).toContainEqual(expect.objectContaining({ type: "start_dropped", reason: "a run started while the prompt's input was handled" }));
	});

	test("an input another extension handles starts no run: the compaction stays, pi-zip is not in a run, the decision reaches no later run", async () => {
		const r = await readyRig({ input: () => ({ action: "handled" }) });
		let armed = 0;
		const arm = r.zip.armProducer.bind(r.zip);
		r.zip.armProducer = (c: Any) => (armed++, arm(c));
		const out = await r.runner.emitInput("handled by another extension", undefined, "interactive", undefined);
		expect(armed).toBe(1); // the timer stopped while Pi compacted is armed again on the compacted session
		expect(out.action).toBe("handled");
		expect(r.compactions).toHaveLength(1); // pi-zip's own summary with its exact size before: valid without the run
		expect(r.zip.inRun).toBe(false);
		// the producer is as a process that opens the compacted session arms it (0.4.0 on Pi 1.1.0 entered the run: no timer)
		const fresh = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], tui: true, native: true, start: false });
		expect([!!r.zip.timer, r.zip.inRun]).toEqual([!!fresh.zip.timer, fresh.zip.inRun]);
		await fresh.shutdown();
		await r.drive(); // the next run is another one: it takes nothing the input decided
		expect(r.zip.start).toBeNull();
		await r.request();
		expect(r.zip.runPlan?.native).toBeUndefined();
	});

	for (const how of ["handled", "image"] as const) test(`a prompt that starts no run (${how === "handled" ? "another extension handles its input" : "it fails after before_agent_start"}) leaves the producer's timer armed`, async () => {
		const r = await rig(undefined, { file: shiftedFile(0, 9000), tui: true, native: true, idle: true, start: false, ...(how === "handled" ? { input: () => ({ action: "handled" }) } : {}) });
		expect(r.zip.timer).not.toBeNull(); // opening the session armed the deadline of the first paying pause
		if (how === "handled") await r.runner.emitInput("handled elsewhere", undefined, "interactive", undefined);
		else await r.prompt("look at this image", { fail: true });
		expect(r.zip.inRun).toBe(false);
		await sleep(2_300); // 0.4.0 (image): before_agent_start had cancelled the timer and entered the run, so no call ever came
		expect(r.narrativeCalls.length).toBe(1);
	});
});

// 0.4.6: the idle door ("epsilon", research pi-tricks §1b variant 4). A run an extension's message starts has no idle input: before, its
// ready summary waited for the first turn_end, so a cold return wrote the whole folded context and, a turn later, the summarized one
// (walle 10-14 13:32: 230K, then 44K more). Now the summary goes in through Pi's compaction while Pi is idle, at the first moment the
// return's own decision takes it, and the next run, whoever starts it, carries that decision from its first request.
for (const order of ORDERS) describe(`the idle door: a ready summary goes in while Pi is idle, for any next run (Pi ${order} order)`, () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	const ledgerOf = (r: Any) => {
		const out: Any[] = [];
		const ledger = r.zip.ledger;
		r.zip.ledger = (rec: Any) => (out.push(rec), ledger(rec));
		return out;
	};
	const noticeOf = (r: Any) => (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
	/** A cold session (its newest response hours old) whose run just ended: the producer writes the return's summary while Pi is idle. */
	const coldRig = async (o: Partial<RigOpts> = {}, before?: (r: Any) => void) => {
		const r = await rig(undefined, { file: shiftedFile(240 * 60_000, 9000), tui: true, native: true, idle: true, start: true, ...o }); // a run of this process (the door opens only after one)
		const led = ledgerOf(r);
		before?.(r);
		await r.settle();
		await r.runner.emit({ type: "agent_end", messages: [] } as Any); // the run of this process ends as Pi ends it
		await sleep(150);
		expect(r.narrativeCalls.length).toBe(1);
		return { r, led };
	};

	test("a summary finished while Pi is idle and the cache is cold goes in at once; an extension's run carries it from its first request and no turn_end writes it again", async () => {
		const { r, led } = await coldRig();
		expect(r.compactCalls.n).toBe(1); // old code: none; the driven run's first request carried the whole folded history
		expect(r.compactions[0].details).toMatchObject({ by: "pi-zip", via: "native", trigger: "cold", door: "idle" });
		expect(led).toContainEqual(expect.objectContaining({ type: "idle_door", taken: true, pWarm: 0 }));
		const carried = r.zip.idleNat;
		expect(carried?.nat.before).toBe(r.compactions[0].tokensBefore);
		await r.drive();
		const req = await r.request();
		expect(r.compactCalls.n).toBe(1);
		expect(req.find((m: Any) => m.role === "compactionSummary")?.summary).toBe(r.compactions[0].summary);
		expect(r.zip.runPlan?.native?.text, "the next run carries the idle door's decision").toBe(r.compactions[0].summary);
		expect(r.zip.runPlan.ctxBefore).toBe(r.compactions[0].tokensBefore);
		expect(r.zip.runPlan.folds.map((t: Any) => t.entryId)).toEqual(carried.nat.p.folds.map((t: Any) => t.entryId));
		expect(r.zip.idleNat).toBeNull(); // taken once
		const notice = noticeOf(r);
		expect([notice.before, notice.native]).toEqual([r.compactions[0].tokensBefore, "idle"]); // Pi's "Compacted from N" is the notice's before
		expect(notice.why).toMatch(/^cache cold · away/);
		const response = asst([call("driven")], "toolUse");
		const id = r.sm.appendMessage(response);
		r.sm.appendMessage(result("driven", "short output"));
		const drafts = await r.turnEnd(id, response);
		expect(drafts.some((d: Any) => d.type === "compaction")).toBe(false);
		expect(r.sm.getBranch().filter((e: Any) => e.type === "compaction")).toHaveLength(1);
	});

	/** Old compactions: one an extension since removed supplied (Pi's own details, fromHook), then one of pi-zip's, or the reverse. */
	const oldCompactions = (foreignNewest: boolean, piAfter = false) => shiftedFile(240 * 60_000, 9000, (sm: Any) => {
		const first = sm.appendMessage(user("an early task"));
		sm.appendMessage({ ...asst([{ type: "text", text: "done" }]), usage: undefined });
		const theirs = () => sm.appendCompaction("an extension's summary", first, 50_000, { readFiles: [], modifiedFiles: [] }, true);
		const ours = () => sm.appendCompaction("pi-zip's summary", first, 40_000, { by: "pi-zip" }, true);
		if (foreignNewest) { ours(); theirs(); } else { theirs(); ours(); }
		if (piAfter) sm.appendCompaction("Pi's own summary", first, 30_000, { readFiles: [], modifiedFiles: [] }, false); // not supplied by an extension
	});

	test("an old compaction by an extension since removed, followed by pi-zip's own, leaves the door open", async () => {
		// a live session (walle) kept 6 such compactions from its first days: every native compaction was refused for good
		const { r, led } = await coldRig({ file: oldCompactions(false) });
		expect(led.filter((x: Any) => x.type === "native_skip").map((x: Any) => x.reason), "an old foreign compaction never closes the door").toEqual([]);
		expect(r.compactCalls.n).toBe(1);
		expect(r.compactions.at(-1).details).toMatchObject({ by: "pi-zip", via: "native", door: "idle" });
	});

	test("another extension's compaction newer than pi-zip's keeps the door shut: its handler would run for pi-zip's too", async () => {
		const { r, led } = await coldRig({ file: oldCompactions(true) });
		expect(r.compactCalls.n).toBe(0);
		expect(led).toContainEqual(expect.objectContaining({ type: "native_skip", reason: "another extension's compaction is the newest in this branch" }));
	});

	test("Pi's own compaction after another extension's says nothing about that extension: the door stays shut", async () => {
		const { r, led } = await coldRig({ file: oldCompactions(true, true) });
		expect(r.compactCalls.n, "a Pi compaction does not hide another extension's").toBe(0);
		expect(led).toContainEqual(expect.objectContaining({ type: "native_skip", reason: "another extension's compaction is the newest in this branch" }));
	});

	test("a typed prompt after the idle door finds nothing left to compact: its run carries the idle door's decision", async () => {
		const { r } = await coldRig();
		expect(r.compactCalls.n).toBe(1);
		await r.prompt("Continue with the task.");
		expect(r.compactCalls.n).toBe(1);
		sendPrompt(r.sm, "Continue with the task.");
		const req = await r.request();
		expect(req.find((m: Any) => m.role === "compactionSummary")?.summary).toBe(r.compactions[0].summary);
		expect(r.zip.runPlan.native.text).toBe(r.compactions[0].summary);
		expect(noticeOf(r).native).toBe("idle");
	});

	test("opening a session whose summary is ready arms no idle door: old history is never compacted by just being open", async () => {
		process.env.PI_ZIP_IDLE_DOOR = "0";
		const { r } = await coldRig();
		expect(r.compactCalls.n).toBe(0);
		process.env.PI_ZIP_IDLE_DOOR = "";
		const opened = await rig(undefined, { file: [r.sm.getHeader() as Any, ...r.sm.getEntries()], tui: true, native: true, idle: true, start: false });
		await sleep(1_300); // past the TTL: a door armed at session start would have opened by now
		expect(opened.compactCalls.n, "opening a session compacts nothing").toBe(0);
		expect(opened.zip.doorTimer).toBeNull();
		await opened.shutdown();
	});

	test("without the TUI (RPC: a sub-agent) no idle door: Pi refuses a prompt sent while it compacts, the TUI queues it", async () => {
		const { r } = await coldRig({ tui: false }); // after a run of this process, as in the TUI
		await sleep(1_300);
		expect(r.compactCalls.n, "no idle door without the TUI").toBe(0);
	});

	test("with the idle door off nothing goes in while idle (PI_ZIP_IDLE_DOOR=0)", async () => {
		process.env.PI_ZIP_IDLE_DOOR = "0";
		const { r } = await coldRig();
		await sleep(1_300);
		expect(r.compactCalls.n).toBe(0);
	});

	test("a prompt whose input comes while the door reads its clock: the door stays shut and the prompt's own door takes the summary", async () => {
		const { r, led } = await coldRig({}, (r: Any) => {
			const read = r.zip.readStart.bind(r.zip);
			let once = false;
			r.zip.readStart = async (ctx: Any, viaPrompt: boolean) => {
				const s = await read(ctx, viaPrompt);
				if (!viaPrompt && !once) { once = true; void r.prompt("Continue with the task."); await sleep(20); } // the rig emits input 5 ms in
				return s;
			};
		});
		await sleep(50);
		expect(r.compactions.map((c: Any) => c.details.door ?? "input"), "an input during the door's clock read keeps the door shut").toEqual(["input"]);
		expect(led).toContainEqual(expect.objectContaining({ type: "idle_door", taken: false, reason: "a prompt, a run, /zip or a new summary came while the door read its clock" }));
		expect(r.compactCalls.n).toBe(1);
		expect(r.compactions[0].details.door).toBeUndefined(); // the typed door's
		expect(r.zip.idleNat).toBeNull();
	});

	test("a run an extension's message starts while the door's compaction is in flight starts on the compacted session and carries it", async () => {
		let driving: Promise<Any> | null = null;
		const { r } = await coldRig({}, (r: Any) => {
			const native = r.zip.nativeSummary.bind(r.zip);
			r.zip.nativeSummary = (...a: Any[]) => {
				const p = native(...a);
				if (a[3] === "idle") driving = r.drive();
				return p;
			};
		});
		expect(driving).not.toBeNull();
		await driving;
		const req = await r.request();
		expect(r.compactCalls.n).toBe(1);
		expect(req.find((m: Any) => m.role === "compactionSummary")?.summary).toBe(r.compactions[0].summary);
		expect(r.zip.runPlan.native.text).toBe(r.compactions[0].summary);
	});

	for (const at of ["before", "after"] as const)
		test(`a run an extension's message starts while another handler (${at} pi-zip's) holds the door's compaction past its deadline waits for it: never aborted, it starts on the compaction`, async () => {
			process.env.PI_ZIP_NATIVE_MS = "150";
			try {
				let driving: Promise<Any> | null = null;
				const { r, led } = await coldRig({ foreign: { at, on: async () => { await sleep(400); return undefined; } } }, (r: Any) => {
					const native = r.zip.nativeSummary.bind(r.zip);
					r.zip.nativeSummary = (...a: Any[]) => {
						const p = native(...a);
						if (a[3] === "idle") setTimeout(() => { driving = r.drive(); }, 20); // Pi starts it: sendCustomMessage does not check isCompacting
						return p;
					};
				});
				expect(driving).not.toBeNull();
				await driving;
				expect(r.abortsInRun.n, "the idle door never aborts an announced run").toBe(0);
				expect(r.compactions.length).toBe(1);
				const req = await r.request();
				expect(req.find((m: Any) => m.role === "compactionSummary")?.summary, "the run waits for the door's compaction").toBe(r.compactions[0].summary);
				expect(led.some((x: Any) => x.type === "idle_door" && x.taken)).toBe(true);
			} finally {
				delete process.env.PI_ZIP_NATIVE_MS;
			}
		});

	test("a slow handler at the idle door with no run is cancelled at the deadline (its own summary call is not left to run)", async () => {
		process.env.PI_ZIP_NATIVE_MS = "150";
		try {
			let aborted = false;
			const { r, led } = await coldRig({
				foreign: { at: "before", on: async (e: Any) => { await sleep(400); aborted = e.signal?.aborted === true; return undefined; } },
			});
			await sleep(600);
			expect(r.compactCalls.n).toBe(1);
			expect(aborted, "a slow handler at the idle door is cancelled").toBe(true);
			expect(r.compactions.length).toBe(0);
			expect(r.abortsInRun.n).toBe(0);
			expect(led.some((x: Any) => x.type === "native_fail" && x.error === "deadline")).toBe(true);
		} finally {
			delete process.env.PI_ZIP_NATIVE_MS;
		}
	});

	test("a door armed again while it reads its clock (a summary finished meanwhile) asks again once that read ends", async () => {
		const { r, led } = await coldRig({}, (r: Any) => {
			const read = r.zip.readStart.bind(r.zip);
			let once = false;
			r.zip.readStart = async (ctx: Any, viaPrompt: boolean) => {
				if (!viaPrompt && !once) (once = true), r.zip.armDoor(ctx, true), await sleep(30); // startBg's arm while the read awaits a token refresh
				return read(ctx, viaPrompt);
			};
		});
		await sleep(300);
		expect(r.compactCalls.n, "the door asks again after a re-arm during its read").toBe(1);
	});

	test("a shutdown while the door reads its clock (/new, /resume) never compacts the session being left", async () => {
		const { r } = await coldRig({}, (r: Any) => {
			const read = r.zip.readStart.bind(r.zip);
			let once = false;
			r.zip.readStart = async (ctx: Any, viaPrompt: boolean) => {
				if (!viaPrompt && !once) (once = true), r.zip.shutdown(), await sleep(30);
				return read(ctx, viaPrompt);
			};
		});
		await sleep(300);
		expect(r.compactCalls.n, "no idle door after shutdown").toBe(0);
	});

	test("a session only opened: a summary the producer writes after the open never goes in while idle", async () => {
		const r = await rig(undefined, { file: shiftedFile(0, 9000), tui: true, native: true, idle: true, start: false });
		await sleep(2_600); // the producer's timer (armed at open) writes the summary; the TTL (1 s) passes
		expect(r.narrativeCalls.length).toBe(1);
		expect(r.compactCalls.n, "no idle door before a run of this process").toBe(0);
		await r.shutdown();
	});

	test("another compaction after the idle door (Pi's own, say) voids its decision: the next run reads its own start", async () => {
		const { r, led } = await coldRig();
		r.sm.appendCompaction("Pi's own summary.", r.compactions[0].firstKeptEntryId, 50_000, undefined, false);
		await r.drive();
		await r.request();
		expect(led).toContainEqual(expect.objectContaining({ type: "start_dropped", reason: "the projection changed after the idle door", native: true }));
		expect(r.zip.runPlan?.native).toBeUndefined();
	});

	test("a door that declines asks again only at the return's next P(warm) change (here the TTL, 1 s past the newest touch), not before", async () => {
		const asked: number[] = [];
		const { r, led } = await coldRig({ file: shiftedFile(0, 9000) }, (r: Any) => {
			const native = r.zip.nativeSummary.bind(r.zip);
			r.zip.nativeSummary = async (...a: Any[]) => {
				if (a[3] !== "idle") return native(...a);
				asked.push(Date.now());
				if (asked.length === 1) return; // the decision declines at this moment (s.nat stays unset)
				return native(...a);
			};
		});
		const doors = () => led.filter((x: Any) => x.type === "idle_door");
		expect(doors()).toEqual([expect.objectContaining({ taken: false, pWarm: 1 })]);
		const touch = Math.max(r.zip.lastReqMs, ...r.sm.getBranch().map((e: Any) => e.message?.timestamp ?? 0));
		expect(r.zip.doorNext(r.zip.liveCtx, r.sm.getBranch(), Date.now())).toBe(touch + 2_000); // just past the TTL edge
		await sleep(touch + 1_900 - Date.now());
		expect(asked.length, "the door asks only when P(warm) changes").toBe(1); // nothing in between
		await sleep(touch + 2_300 - Date.now());
		expect(asked.length).toBe(2);
		expect(asked[1]).toBeGreaterThanOrEqual(touch + 2_000);
		expect(doors().at(-1)).toMatchObject({ taken: true, pWarm: 0 });
		expect(r.compactCalls.n).toBe(1);
		expect(r.compactions[0].details).toMatchObject({ door: "idle", trigger: "cold" });
		expect(r.zip.doorNext(r.zip.liveCtx, r.sm.getBranch(), Date.now())).toBeNull(); // nothing changes after the TTL
	});

	test("a run that starts before the door's next moment closes it: nothing is compacted behind it, and its own turn_end decides", async () => {
		const asked: number[] = [];
		const { r, led } = await coldRig({ file: shiftedFile(0, 9000) }, (r: Any) => {
			const native = r.zip.nativeSummary.bind(r.zip);
			r.zip.nativeSummary = async (...a: Any[]) => {
				if (a[3] === "idle" && (asked.push(Date.now()), asked.length === 1)) return; // declines now
				return native(...a);
			};
		});
		expect(r.zip.doorTimer).not.toBeNull();
		await r.drive();
		expect(r.zip.doorTimer).toBeNull();
		await sleep(2_300);
		expect(asked.length).toBe(1);
		expect(r.compactCalls.n, "nothing is compacted behind a run").toBe(0);
		expect(led.filter((x: Any) => x.type === "idle_door")).toHaveLength(1);
	});
});

describe("the notice's why line says the cache was judged cold, as the warm one says it was warm", () => {
	test("a cold return: 'cache cold · away ...'", async () => {
		const r = await rig(undefined, { tui: true }); // every message is hours old
		sendPrompt(r.sm, "next request");
		await r.request();
		const response = asst([{ type: "text", text: "done" }], "stop", 10_000_001);
		await r.turnEnd(r.sm.appendMessage(response), response);
		const notice = (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
		expect(notice?.why).toMatch(/^cache cold · away [\d.]+ (s|min|h)$/); // old code: "away 3.0 h"
	});
});

// Round 5: the incident (0.3.0, a warm prompt 1 min 48 s after a run that ended at 111.5K; the user waited 39 s for a summary, which went in
// as a draft whose "Compacted from N" Pi took from the post-summary request). Rule A and the background production against Pi's own session and draft code.
for (const order of ORDERS) describe(`round 5 on real Pi: rule A starts the warm summary early, nobody waits for it while the cache is warm (Pi ${order} order)`, () => {
	beforeEach(() => { rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = (agoMs: number) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 9000); // long prose: folds alone cannot reach the cap, so a warm return would summarise too
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		return file;
	};
	const noticeOf = (r: Any) => (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
	const prompt = async (r: Any, text = "next request") => {
		const t0 = performance.now();
		await r.prompt(text);
		r.sm.appendMessage(user(text, Date.now() - T0));
		const req = await r.request();
		return { req, waited: performance.now() - t0 };
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "300"; process.env.PI_ZIP_IDLE_DOOR = "0"; }); // the typed door alone (the idle door: below)

	test("a warm restart stays quiet through typing until a decision wants production", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: true, native: false, idle: false, start: false });
		r.typeKey("h");
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(0);
		expect(r.inputListeners.size).toBe(0);
		await prompt(r);
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(1);
	});

	for (const [label, kept, p, ago] of [["initial plan", 11, 1, 60_000], ["pinned plan", 1, 0, 3_600_000]] as const) {
		test(`native adoption prices a ready cut at zero in the ${label}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "pz-native-price-")), ledger = join(dir, "ledger.jsonl");
			const before = process.env.PI_ZIP_LEDGER;
			process.env.PI_ZIP_LEDGER = ledger;
			try {
				process.env.PI_ZIP_COLD_CAP = "40000";
				const sm = SessionManager.inMemory(CWD);
				const keys: string[] = [];
				for (let i = 0; i < 18; i++) {
					keys.push(sm.appendMessage(user(`turn ${i + 1}`, Date.now() - T0 - ago)));
					sm.appendMessage({ ...asst([{ type: "text", text: "z ".repeat(6500) }], "stop", Date.now() - T0 - ago), usage: undefined });
				}
				const entries = sm.buildSessionProjection().entries as Any[];
				const env = { model: MODEL, cwd: CWD, sys: { text: "You are a coding agent.", tools: [] }, reserve: 16_384, recalled: new Set<string>(), steerIds: new Set<string>(), rereadOnly: false };
				const learned = { model: MODEL, g: 2500, justEdited: false };
				const key = keys[kept];
				const opts = (ready: string[]) => planOpts(entries, sm.getBranch(), env, learned, true, p, false, undefined, false, ready).o;
				if (p === 1) expect(planContext(entries, opts([]))?.cutIdx ?? null).toBeNull();
				else expect(planContext(entries, { ...opts([]), cutAt: key })?.cutIdx ?? null).toBeNull();
				const readyPlan = planContext(entries, { ...opts([key]), cutAt: key })!;
				expect(readyPlan.firstKeptEntryId).toBe(key);
				const text = "## Decisions\n" + "summary ".repeat(500);
				sm.appendCustomEntry("pi-zip/summary", { head: "", key, usd: 0, cut: { firstKeptEntryId: key, text, trigger: "valve", count: kept, prefixTokens: readyPlan.prefixTokens, summaryTokens: Math.ceil(text.length / 4), llmOk: true, llmError: null, costUsd: 0, ms: 0, prepared: true } });
				const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], tui: true, native: true, idle: true, start: false });
				await r.prompt();
				expect(r.compactCalls.n).toBe(1);
				expect(r.compactions[0]).toMatchObject({ summary: text, firstKeptEntryId: key, details: { via: "native" } });
				r.sm.appendMessage(user("next request", Date.now() - T0));
				const req = await r.request();
				expect(req.find((m: Any) => m.role === "compactionSummary")?.summary).toBe(text);
				expect(r.narrativeCalls).toHaveLength(0);
				await sleep(5);
				expect(r.compactions[0].tokensBefore).toBe(noticeOf(r).before);
				const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
				expect(rows.find((x) => x.type === "cold_plan")).toMatchObject({ via: "native" });
				await r.shutdown();
			} finally {
				if (before === undefined) delete process.env.PI_ZIP_LEDGER;
				else process.env.PI_ZIP_LEDGER = before;
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("native joint pricing carries exactly its folds by entry ID on real Pi, with an exact before-number and no first-request re-plan", async () => {
		const sm = SessionManager.inMemory(CWD), timestamp = Date.now() - T0 - 60_000, keys: string[] = [];
		for (let i = 0; i < 18; i++) {
			keys.push(sm.appendMessage(user(`turn ${i + 1}`, timestamp)));
			if (i === 12) {
				sm.appendMessage({ ...asst([call("joint-fold")], "toolUse", timestamp), usage: undefined });
				sm.appendMessage(result("joint-fold", bulk("joint", 1500), timestamp));
			}
			sm.appendMessage({ ...asst([{ type: "text", text: "z ".repeat(6500) }], "stop", timestamp), usage: undefined });
		}
		const key = keys[9], text = "## Decisions\n" + "summary ".repeat(500);
		const entries = sm.buildSessionProjection().entries as Any[];
		const env = { model: MODEL, cwd: CWD, sys: { text: "You are a coding agent.", tools: [] }, reserve: 16_384, recalled: new Set<string>(), steerIds: new Set<string>(), rereadOnly: false };
		const o = planOpts(entries, sm.getBranch(), env, { model: MODEL, g: 2500, justEdited: false }, true, 1, false, key, false, [key]).o;
		const prepared = planContext(entries, o)!;
		expect(prepared.cutIdx).not.toBeNull();
		expect(prepared.folds.length).toBeGreaterThan(0);
		sm.appendCustomEntry("pi-zip/summary", { head: "", key, usd: 0, cut: { firstKeptEntryId: key, text, trigger: "valve", count: 9, prefixTokens: prepared.prefixTokens, summaryTokens: Math.ceil(text.length / 4), llmOk: true, llmError: null, costUsd: 0, ms: 0, prepared: true } });
		const r = await rig(undefined, { file: [sm.getHeader() as Any, ...sm.getEntries()], tui: true, native: true, idle: true, start: false });
		await r.prompt("next request");
		expect(r.compactions).toHaveLength(1);
		const priced = r.zip.nativeRun.p;
		expect(priced.folds.length).toBeGreaterThan(0);
		r.sm.appendMessage(user("next request", Date.now() - T0));
		const originalOpts = r.zip.opts;
		r.zip.opts = () => { throw new Error("first native request must not re-plan"); };
		const request = await r.request();
		r.zip.opts = originalOpts;
		expect(r.zip.runPlan.folds.map((t: Any) => t.entryId)).toEqual(priced.folds.map((t: Any) => t.entryId));
		expect([...r.zip.runPlan.applied]).toEqual(priced.folds.map((t: Any) => t.entryId));
		expect(request.filter(isFolded)).toHaveLength(priced.folds.length);
		await sleep(5);
		expect(r.compactions[0].tokensBefore).toBe(noticeOf(r).before);
		const response = asst([{ type: "text", text: "done" }], "stop", Date.now() - T0), id = r.sm.appendMessage(response);
		const drafts = await r.turnEnd(id, response);
		expect(drafts.filter((d: Any) => d.type === "context_edit").map((d: Any) => d.targetId)).toEqual(priced.folds.map((t: Any) => t.entryId));
		await r.shutdown();
	});

	// A smaller actual prompt keeps the native summary and the prompt decision's folds.
	for (const [label, announced] of [["same prompt", "next request"], ["real prompt smaller than announced", `next request ${"with an expanded template ".repeat(400)}`]] as const) {
		test(`warm native adoption (${label}): an early summary goes in through Pi's compaction before the prompt, Pi's 'Compacted from N' is the notice's before, no wait, the priced folds are carried by entry ID`, async () => {
			const ledger = join(mkdtempSync(join(tmpdir(), "pz-r5-native-")), "ledger.jsonl");
			const before = process.env.PI_ZIP_LEDGER;
			process.env.PI_ZIP_LEDGER = ledger;
			try {
				const r = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
				await r.settle(); // the run ends: rule A starts the warm return's summary now
				await sleep(400);
				expect(r.narrativeCalls.length).toBe(1); // 0.3.0: 0 here, then a 300 ms wait at the prompt
				const t0 = performance.now();
				await r.prompt(announced);
				r.sm.appendMessage(user("next request", Date.now() - T0));
				const req = await r.request();
				expect(performance.now() - t0).toBeLessThan(250);
				expect(r.narrativeCalls.length).toBe(1);
				expect(r.compactCalls.n).toBe(1); // 0.3.0: 0 (a warm return never took the native path)
				expect(r.compactions).toHaveLength(1);
				const branch = r.sm.getBranch() as Any[];
				const at = branch.findIndex((e) => e.type === "compaction");
				const promptAt = branch.findIndex((e) => e.type === "message" && e.message.role === "user" && e.message.content === "next request");
				expect(at).toBeGreaterThan(-1);
				expect(at).toBeLessThan(promptAt); // one place, before the prompt
				expect(branch[at].details).toMatchObject({ by: "pi-zip", via: "native", trigger: "valve" });
				expect(req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
				const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
				expect(rows.find((x) => x.type === "cold_plan")).toMatchObject({ via: "native" });
				await sleep(5);
				const n = noticeOf(r);
				expect(n.before).toBe(branch[at].tokensBefore);
				expect(n.native).toBe("ok");
				expect(n.desc).toMatch(/ready while you were away$/);
			} finally {
				if (before === undefined) delete process.env.PI_ZIP_LEDGER;
				else process.env.PI_ZIP_LEDGER = before;
			}
		});
	}

	test("B on real Pi: no wait at the warm prompt, nothing applied; a later turn_end commits the summary as a draft the next request first carries, so Pi's tokensBefore is the size before", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 600 });
		const raw = r.projectionMessages().length + 1;
		const { req, waited } = await prompt(r); // no settle ran in this process and no key was typed: nothing was started
		expect(waited).toBeLessThan(300); // 0.3.0: the whole 600 ms call (39 s in the incident)
		expect(req === undefined || (!req.some(isFolded) && !req.some((m: Any) => m.role === "compactionSummary"))).toBe(true);
		expect(r.projectionMessages().length).toBe(raw);
		await sleep(20);
		expect(r.narrativeCalls.length).toBe(1); // started in the background
		const big = (input: number): Any => ({ ...usage, input, totalTokens: input });
		// the first turn: the summary is still being written: turn_end persists nothing and does not wait
		const a1 = r.sm.appendMessage({ ...asst([call("w1")], "toolUse", 20_000_001), usage: big(110_000) });
		r.sm.appendMessage(result("w1", "small", 20_000_002));
		const t1 = performance.now();
		expect((await r.turnEnd(a1, { ...asst([call("w1")], "toolUse"), usage: big(110_000) })).filter((d: Any) => d.type === "compaction")).toEqual([]);
		expect(performance.now() - t1).toBeLessThan(200);
		await sleep(700);
		// a later turn, once it is done: the valve adopts it at turn_end
		const a2 = r.sm.appendMessage({ ...asst([call("w2")], "toolUse", 20_000_003), usage: big(111_500) });
		r.sm.appendMessage(result("w2", "y".repeat(2_000), 20_000_004));
		const piBefore = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens;
		const drafts = await r.turnEnd(a2, { ...asst([call("w2")], "toolUse"), usage: big(111_500) });
		expect(drafts.filter((d: Any) => d.type === "compaction")).toHaveLength(1);
		const comp = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
		expect(comp.tokensBefore).toBe(piBefore); // the size before (0.3.0's run-plan draft got the size after: "Compacted from 52,519")
		expect(comp.tokensBefore).toBe(111_500 + 500);
		expect(r.narrativeCalls.length).toBe(1);
		const next = await r.request();
		expect(next === undefined || next.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		await sleep(5);
		const n = noticeOf(r);
		expect(n.desc).toMatch(/summarized \d+ requests in [\d.]+ m?s · written while you worked$/);
		expect(Math.abs(n.before - comp.tokensBefore) / comp.tokensBefore).toBeLessThan(0.05); // the notice's before is pi-zip's estimate of the same request
	});

	test("no UI on real Pi (pi -p, json): the warm prompt does not wait either; the summary is written in the background, as with a UI", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: false, native: true, idle: true, start: false, latencyMs: 300 });
		const { req, waited } = await prompt(r);
		expect(waited).toBeLessThan(250); // 0.3.1: the whole call, in the request
		expect(req === undefined || !req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		expect(r.compactCalls.n).toBe(0);
		await sleep(20);
		expect(r.narrativeCalls.length).toBe(1);
		const ui = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
		const noTs = (x: Any) => JSON.stringify(x, (k, v) => (k === "timestamp" ? undefined : v));
		expect(noTs((await prompt(ui)).req)).toBe(noTs(req)); // the same request with a UI
	});
});

// 0.4.4 (P1 on long sessions): every turn_end and run start passed every bash command of the branch through an unanchored regex
// (quadratic in a long word; 0.3 s locally and 0.6 s on a loaded machine per turn_end on a 32K-entry session), and one settle read
// the whole branch and its token scale again for each of the ~30 plans it priced (0.16 s / 0.85 s). Both stall Pi's UI.
describe("a long branch: the per-turn handlers stay bounded", () => {
	/** populate, then 80 tool rounds whose commands carry one 3,000-char word each (old code: ~1.6 s per turn_end here). */
	const longCommands = (sm: SessionManager) => {
		populate(sm);
		const word = "x".repeat(3000);
		for (let i = 0; i < 80; i++) {
			sm.appendMessage(user(`long ${i}`, 100 + 4 * i));
			sm.appendMessage(asst([call(`L${i}`, `echo ${word}${i} | wc -c`)], "toolUse", 101 + 4 * i));
			sm.appendMessage(result(`L${i}`, "3001", 102 + 4 * i));
			sm.appendMessage(asst([{ type: "text", text: `counted ${i}` }], "stop", 103 + 4 * i));
		}
	};

	test("a long branch: turn_end reads the branch's commands in bounded time", async () => {
		const r = await rig(longCommands);
		await r.request();
		const response = asst([call("t1")], "toolUse");
		const id = r.sm.appendMessage(response);
		const t0 = performance.now();
		await r.turnEnd(id, response);
		expect(performance.now() - t0, "turn_end on a branch of 80 long commands stays under 400 ms").toBeLessThan(400);
		await r.shutdown();
	}, 60_000); // the old scan must reach the assertion, not the test timeout

	test("a long branch: one settle reads the branch a bounded number of times", async () => {
		const r = await rig(undefined, { tui: true });
		await r.request();
		const response = asst([{ type: "text", text: "done" }], "stop");
		const id = r.sm.appendMessage(response);
		await r.turnEnd(id, response);
		const get = r.sm.getBranch.bind(r.sm);
		let reads = 0;
		(r.sm as Any).getBranch = (...a: Any[]) => (reads++, get(...a));
		await r.settle();
		expect(reads, "one settle reads the branch at most 6 times").toBeLessThanOrEqual(6);
		await r.shutdown();
	});
});

// 0.4.1-0.4.4 (P1): a /model in the middle of a run has no run start. Requests were booked under the run's first model, so every later
// turn_end saw a "model switch" (P(warm) = 0: any edit is free) and folded one output per turn, each a full rewrite of the new model's
// cache (~130K tokens for 1-15K saved, 23 times in 25 minutes on one session), under a notice that said "cache warm".
describe("a mid-run /model: the new model's requests are its own", () => {
	const m2 = { ...MODEL, id: "m2" };
	const switched = async (select: boolean, request: boolean) => {
		const r = await rig(undefined, { start: false });
		await r.prompt("current");
		r.sm.appendMessage(user("current", Date.now() - T0));
		await r.request();
		await r.runner.emitBeforeProviderRequest({});
		const first = { ...asst([call("s1")], "toolUse"), timestamp: Date.now() };
		const firstId = r.sm.appendMessage(first);
		r.sm.appendMessage(result("s1", "ok"));
		await r.turnEnd(firstId, first);
		r.setModel(m2);
		if (select) await r.runner.emit({ type: "model_select", model: m2, previousModel: MODEL, source: "set" } as Any);
		if (!request) return r;
		await r.request();
		await r.runner.emitBeforeProviderRequest({});
		const second = { ...asst([call("s2")], "toolUse"), model: "m2", timestamp: Date.now() };
		const secondId = r.sm.appendMessage(second);
		r.sm.appendMessage(result("s2", "ok"));
		await r.turnEnd(secondId, second);
		return r;
	};

	test("a mid-run /model: turn_end judges the new model's cache by the request it just made", async () => {
		const r = await switched(false, true);
		expect(r.zip.turnWhy, "a mid-run /model: the request it made is booked under the new model").toBe("cache warm \u00b7 worth it at this size");
		await r.shutdown();
	});

	test("a mid-run /model: model_select makes it the current model before any request", async () => {
		const r = await switched(true, false);
		expect(r.zip.status(r.runner.createContext()), "a mid-run /model: /zip shows the selected model").toContain("cache p/m2:");
		await r.shutdown();
	});
});

// 0.4.9: a relay that pools accounts (sub2api) keeps a session on one account only when the request names it, as Claude Code's
// metadata.user_id does (sub2api's legacy form below); a request that names its own, another API, a request that already speaks as
// Claude Code, a first-party endpoint, and a model whose endpoint refused it are left alone. The request goes through Pi's real
// before_provider_request chain; the model state is kept in sticky.json next to the cache stats (a fresh directory per test).
describe("a relay keeps the session on one account: metadata.user_id", () => {
	const SUB2API_LEGACY = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/;
	const body = (): Any => ({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
	const send = async (r: Any, p: Any = body()) => (await r.runner.emitBeforeProviderRequest(p)) as Any;
	const none = { ...usage, input: 0, output: 0, totalTokens: 0 };
	const refuse = (r: Any, errorMessage: string) => r.runner.emitMessageEnd({ type: "message_end", message: { ...asst([], "error"), usage: none, errorMessage } } as Any);
	const answer = (r: Any) => r.runner.emitMessageEnd({ type: "message_end", message: asst([{ type: "text", text: "ok" }]) } as Any);
	const stats = process.env.PI_ZIP_CACHE_STATS;
	beforeEach(() => { process.env.PI_ZIP_CACHE_STATS = join(mkdtempSync(join(tmpdir(), "pz-sticky-")), "cache-survival.json"); });
	afterEach(() => { process.env.PI_ZIP_CACHE_STATS = stats; });

	test("a relay keeps the session: an Anthropic request names its session, and only that", async () => {
		const r = await rig(undefined, { start: false });
		const p = body(), out = await send(r, p);
		expect(SUB2API_LEGACY.exec(out?.metadata?.user_id ?? "")?.[3], "an Anthropic request names its session").toBe(r.sm.getSessionId());
		expect(out.messages, "the request is otherwise the one Pi built").toEqual(body().messages);
		expect(p, "the payload Pi built is not changed in place").toEqual(body());
		expect((await send(r, { ...body(), metadata: { user_id: "theirs" } })).metadata, "a request that names its own keeps it").toEqual({ user_id: "theirs" });
		process.env.PI_ZIP_STICKY = "0";
		expect((await send(r)).metadata, "the emergency switch turns it off").toBeUndefined();
		delete process.env.PI_ZIP_STICKY;
		expect((await send(r, { ...body(), system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] })).metadata, "a request that speaks as Claude Code is left alone").toBeUndefined();
		// models.json headers and keys never reach ctx.model: Pi's own registry resolves them for the request
		const dir = mkdtempSync(join(tmpdir(), "pz-sticky-models-")), def = { api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1000, cost: MODEL.cost }] };
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { cc: { ...def, apiKey: "sk-test", headers: { "User-Agent": "claude-cli/2.1.280" } }, oauth: { ...def, apiKey: "sk-ant-oat01-test" }, plain: { ...def, apiKey: "sk-test" } } }));
		const reg = new ModelRegistry(await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false }));
		r.runner.createContext().modelRegistry.getApiKeyAndHeaders = (m: Any) => reg.getApiKeyAndHeaders(m);
		r.setModel(reg.find("cc", "m"));
		expect((await send(r)).metadata, "a claude-cli user agent is left alone").toBeUndefined();
		r.setModel(reg.find("oauth", "m"));
		expect((await send(r)).metadata, "an OAuth key is left alone").toBeUndefined();
		r.setModel(reg.find("plain", "m"));
		expect((await send(r)).metadata, "a relay from models.json names its session").toBeDefined();
		r.setModel({ ...MODEL, baseUrl: "https://api.anthropic.com" });
		expect((await send(r)).metadata, "api.anthropic.com is left alone").toBeUndefined();
		r.setModel({ ...MODEL, provider: "github-copilot" });
		expect((await send(r)).metadata, "Copilot is left alone").toBeUndefined();
		r.setModel({ ...MODEL, api: "openai-responses" });
		expect((await send(r)).metadata, "another API is left alone").toBeUndefined();
		await r.shutdown();
	});

	test("a relay keeps the session: an endpoint that refuses it is not sent it again, in this process or the next", async () => {
		const r = await rig(undefined, { start: false });
		expect((await send(r)).metadata).toBeDefined();
		await refuse(r, "529 overloaded");
		expect((await send(r)).metadata, "another refusal keeps it").toBeDefined();
		await refuse(r, "400 prompt is too long: 2430000 tokens > 1000000 maximum");
		expect((await send(r)).metadata, "a prompt too long keeps it").toBeDefined();
		await refuse(r, "400 status code (no body)");
		expect((await send(r)).metadata, "a first 400 without a body turns it off").toBeUndefined();
		await r.shutdown();
		const next = await rig(undefined, { start: false });
		expect((await send(next)).metadata, "a refused metadata.user_id is not sent in the next process").toBeUndefined();
		await next.shutdown();
	});

	test("a relay keeps the session: once an endpoint answered it, a refusal that names it or a second 400 in a row turns it off", async () => {
		const r = await rig(undefined, { start: false });
		expect((await send(r)).metadata).toBeDefined();
		await answer(r);
		await send(r);
		await refuse(r, "400 status code (no body)");
		expect((await send(r)).metadata, "a 400 after an answer keeps it").toBeDefined();
		await refuse(r, "400 metadata: Extra inputs are not permitted");
		expect((await send(r)).metadata, "a refused metadata.user_id is not sent again").toBeUndefined();
		r.setModel({ ...MODEL, baseUrl: "http://127.0.0.1:2" }); // another endpoint for the same model: its own state
		expect((await send(r)).metadata, "another endpoint has its own state").toBeDefined();
		await answer(r);
		await send(r);
		await refuse(r, "400 status code (no body)");
		await send(r);
		await refuse(r, "400 status code (no body)");
		expect((await send(r)).metadata, "the second 400 in a row after an answer turns it off").toBeUndefined();
		await r.shutdown();
	});
});

// Without a UI (pi -p, --mode json; rpc binds one on Pi 1.1) pi-zip decides as with one (0.4.0): nobody waits for a summary, it is
// written in the background and the next decision takes it; settle prepares a return as in every mode (a call the exit aborts is unused).
// Every request and every session entry of three no-UI scenarios (a warm return that summarises, a warm return right after an edit, a
// cold return that summarises), normalised only for what differs from run to run (entry ids and the handles made from them,
// timestamps, measured durations), hash to the digest below, printed by this test with R5_PRINT_DIGEST=1. It moves only when the
// no-UI behaviour moves, and each move is justified in its commit: 0.3.1's (0907ceea..., 0.3.0's decisions with 0.3.1's format, where
// these scenarios waited for their summaries in line) became this one when 0.4.0 stopped waiting.
describe("no UI (pi -p, json): the requests and the session of three scenarios hash to a recorded digest", () => {
	const NOUI_DIGEST = "384dbbd126b2279dc19bf6d1d2fe48f5"; // R5_PRINT_DIGEST=1 prints it (0.3.1: 0907ceeacca2be4a8b8f684dd6a47a96)
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const shifted = (agoMs: number, prose: number) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, prose);
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
		return file;
	};
	const big = (input: number): Any => ({ ...usage, input, totalTokens: input });
	const transcript = async (scenario: (r: Any, log: (x: Any) => void) => Promise<void>, file: Any[]) => {
		const r = await rig(undefined, { file, tui: false, native: true, idle: true, start: false });
		const out: Any[] = [];
		await scenario(r, (x) => out.push(x));
		out.push({ entries: r.sm.getEntries(), narrativeCalls: r.narrativeCalls.length });
		// normalise: entry ids (and the fold handles made from them) to ordinals, timestamps and measured durations out
		let s = JSON.stringify(out, (k, v) => (k === "timestamp" || k === "reqTs" || /(^|[a-z])(ms|Ms)$/.test(k) ? undefined : v));
		const { handleFor } = await import("../src/placeholder.ts");
		r.sm.getEntries().forEach((e: Any, i: number) => {
			s = s.split(e.id).join(`#${i}`).split(handleFor(e.id)).join(`@${i}`);
		});
		// 0.3.1 rows and placeholders carry the local time of the output (MM-DD HH:MM), which moves with the clock
		return s.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "D").replace(/\d+(\.\d+)? ?(ms|s)\b/g, "T").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "U");
	};
	// a summary call started in the background finishes before the next event (the model answers at once): the transcript does not
	// depend on how fast this machine runs it
	const prompt = async (r: Any, log: (x: Any) => void, text: string) => {
		await r.prompt(text);
		r.sm.appendMessage(user(text, Date.now() - T0));
		log(await r.request());
		await sleep(50);
	};
	const step = async (r: Any, log: (x: Any) => void, n: number, input: number, out: string, prose = "") => {
		const a = r.sm.appendMessage({ ...asst([...(prose ? [{ type: "text", text: prose }] : []), call(`s${n}`)], "toolUse", 30_000_000 + 2 * n), usage: big(input) });
		r.sm.appendMessage(result(`s${n}`, out, 30_000_001 + 2 * n));
		log(await r.turnEnd(a, { ...asst([call(`s${n}`)], "toolUse"), usage: big(input) }));
		await sleep(50);
		log(await r.request());
	};
	const scenarios = async () => {
		const parts: string[] = [];
		// warm return 60 s after a big run: its summary is written in the background, the first turn_end takes it (0.3.1: the prompt waited)
		parts.push(await transcript(async (r, log) => {
			await prompt(r, log, "warm return");
			await step(r, log, 1, 110_000, "small");
			await step(r, log, 2, 111_000, "y".repeat(2_000));
			log(await r.settle());
		}, shifted(60_000, 6000)));
		// a warm prompt right after a request that carried an edit (b2b: no warm edit at the prompt; the state a restarted process
		// restores, set here directly): its summary is still produced, and its first turn_end valve takes it (0.3.1: the turn_end waited)
		parts.push(await transcript(async (r, log) => {
			r.zip.justEdited = true; // from the prompt's input on
			await prompt(r, log, "right after an edit");
			r.zip.justEdited = false; // the prompt's response answered a request without a fresh edit (message_end, which this rig does not fire)
			await step(r, log, 1, 110_000, "small");
			await step(r, log, 2, 111_000, "small");
			log(await r.settle());
		}, shifted(60_000, 6000)));
		// a cold return (past the TTL) that summarises: its folds at once, its summary at the turn_end after the run plan's
		parts.push(await transcript(async (r, log) => {
			await prompt(r, log, "cold return");
			await step(r, log, 1, 110_000, "small");
			await step(r, log, 2, 111_000, "small");
			log(await r.settle());
		}, shifted(400_000, 6000)));
		return parts;
	};

	test("three no-UI scenarios hash to the recorded digest; background calls do not block compaction", async () => {
		const parts = await scenarios();
		const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
		if (process.env.R5_PRINT_DIGEST) console.log("R5 NO-UI DIGEST", digest, parts.map((p) => createHash("sha256").update(p).digest("hex").slice(0, 12)).join(" "));
		parts.forEach((p, i) => {
			const session = JSON.parse(p).at(-1);
			expect(session.entries.filter((e: Any) => e.type === "compaction")).toHaveLength(1);
			expect(session.narrativeCalls).toBe(i === 2 ? 2 : 1);
		});
		expect(parts[1]).toContain('"trigger":"valve"');
		expect(digest).toBe(NOUI_DIGEST);
		// the same warm return with a UI and a slow call: no summary in its first request, and no wait
		const ui = await rig(undefined, { file: shifted(60_000, 6000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
		await ui.prompt("warm return");
		ui.sm.appendMessage(user("warm return", Date.now() - T0));
		const t0 = performance.now();
		const req = await ui.request();
		expect(performance.now() - t0).toBeLessThan(250);
		expect(req === undefined || !req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		await sleep(400);
	});
});
