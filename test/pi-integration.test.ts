// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, getCurrentSystemMessage, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { collapseSystem } from "../src/plan.ts";
import type { Any } from "./helpers.ts";

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

async function rig(setup: (sm: SessionManager) => void = populate) {
	const sm = SessionManager.inMemory(CWD);
	setup(sm);
	// the real loader, from the real entry file: exactly how `pi -e` loads the extension
	const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], CWD, "/tmp/pi-zip-integration-agent", createEventBus());
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	const narrativeCalls: Any[] = [];
	const registry: Any = {
		complete: async (_m: Any, c: Any) => (narrativeCalls.push(c), { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0 } } }),
	};
	const runner = new ExtensionRunner(loaded.extensions, runtime, CWD, sm, registry);
	const noop = () => {};
	runner.bindCore(
		{ sendMessage: noop, sendUserMessage: noop, appendEntry: (t: string, d: Any) => sm.appendCustomEntry(t, d), setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => ["read", "bash", "zip_recall"], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop } as Any,
		{ getModel: () => MODEL, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "You are a coding agent." } as Any,
	);
	const projectionMessages = () => sm.buildSessionContext().messages as Any[];
	/** One request as Pi sends it: the agent state is the session projection; the extension transforms it. */
	const request = async () => (await runner.emitContext(projectionMessages())) as Any[];
	/** What Pi's agent session does at turn_end: boundary handlers propose entries, the drafts are applied to the real session. */
	const turnEnd = async (assistantEntryId: string, message: Any) => {
		const build = (drafts: Any[]) => {
			const preview = SessionManager.inMemory(CWD, undefined, [sm.getHeader() as Any, ...sm.getBranch()]);
			apply(preview, drafts);
			const projection = preview.buildSessionProjection();
			return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: convertToLlm(projection.messages), pendingMessages: [], canContinue: false };
		};
		const out = await runner.emitBoundary({ type: "turn_end", turnIndex: 1, message, toolResults: [], messageEntryId: assistantEntryId, toolResultEntryIds: [], outcome: message.stopReason === "aborted" ? "aborted" : "completed" } as Any, build as Any);
		apply(sm, out.entries as Any[]);
		return out.entries as Any[];
	};
	const apply = (manager: SessionManager, drafts: Any[]) => {
		for (const d of drafts) {
			if (d.type === "custom") manager.appendCustomEntry(d.customType, d.data);
			else if (d.type === "context_edit") manager.appendContextEdit(d.targetId, d.replacement);
			else if (d.type === "compaction") manager.appendCompaction(d.summary, d.firstKeptEntryId, 0, d.details, true, d.usage);
		}
	};
	await runner.emit({ type: "session_start", reason: "startup" } as Any);
	await runner.emitBeforeAgentStart("next request", undefined, { cwd: CWD } as Any);
	return { sm, runner, request, turnEnd, narrativeCalls, projectionMessages };
}

const saved: Record<string, string | undefined> = {};
const ENV = { PI_ZIP_COLD_CAP: "3000", PI_ZIP_MIN_GAIN: "1000", PI_ZIP_TTL_SECS: "300" };
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const isFolded = (m: Any) => m.role === "toolResult" && JSON.stringify(m.content).includes("[folded by pi-zip");

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

	test("a summary cut: request N equals request N+1 (replayed system message, summary, kept messages)", async () => {
		const r = await rig((sm) => populate(sm, 6000)); // long assistant prose: folds alone cannot reach the cap, so a summary is planned (and its uncached call pays: X ~ 70K)
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(r.narrativeCalls.length).toBe(1);
		expect(req1.filter((m) => m.role === "system").length).toBe(1); // collapsed, exactly like Pi's compaction projection
		const a = r.sm.appendMessage(asst([call("c8")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("c8", "tiny", 10_000_002));
		const req2 = await r.request();
		await r.turnEnd(a, asst([call("c8")], "toolUse"));
		const req3 = await r.request();
		for (const mid of [true, false]) {
			expect(llm(req2.slice(0, req1.length), mid)).toBe(llm(req1, mid));
			expect(llm(req3, mid)).toBe(llm(req2, mid));
		}
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
