import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Zip } from "../src/run.ts";
import { afterSize, pressure, safeCut, speedPlan } from "../src/speed.ts";
import { buildBlocks, UNIT } from "../src/plan.ts";
import { summaryEffort, narrative } from "../src/summary.ts";
import type { Any } from "./helpers.ts";

const model: Any = { provider: "synthetic", id: "physical", api: "openai-responses", baseUrl: "https://offline.invalid", contextWindow: 200000, maxTokens: 16384, reasoning: false, cost: { input: 1, output: 1, cacheRead: .1, cacheWrite: 1 } };
const usage = (n: number) => ({ input: n, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: n + 1, cost: { total: .01 } });
const assistant = (n = 160000): Any => ({ role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: usage(n), stopReason: "stop", timestamp: Date.now() });
const workers: Any[] = [];
beforeEach(() => { process.env.PI_ZIP_MODE = "speed"; });
afterEach(() => { for (const z of workers.splice(0)) z.shutdown(); process.env.PI_ZIP_MODE = "early"; });

function rig(options: { held?: boolean; failed?: boolean; memory?: boolean; settings?: Any } = {}) {
	const sm = SessionManager.inMemory("/tmp/speed-unit");
	for (let i = 0; i < 5; i++) { sm.appendMessage({ role: "user", content: `${i} ` + "request ".repeat(16000), timestamp: i } as Any); sm.appendMessage(assistant((i+1)*32000)); }
	const z: Any = new Zip({ getSettings: () => options.settings ?? {}, getActiveTools: () => ["read", "bash"], getAllTools: () => [], appendEntry: (t: string, d: Any) => sm.appendCustomEntry(t, d) } as Any);
	workers.push(z);
	let finish!: () => void, calls = 0;
	const blocked = new Promise<void>(r => { finish = r; });
	const ctx: Any = { model: { ...model }, mode: "rpc", cwd: "/tmp/speed-unit", getSystemPrompt: () => "native",
		sessionManager: { getBranch: () => sm.getBranch(), getSessionId: () => sm.getSessionId(), getSessionFile: () => options.memory ? null : "/tmp/synthetic-persisted-session.jsonl", buildSessionProjection: () => sm.buildSessionProjection() },
		modelRegistry: { complete: async (_m: Any, _c: Any, opts: Any) => { calls++; if (options.held) await blocked; return { stopReason: options.failed ? "error" : "stop", errorMessage: "content policy refusal", content: [{ type: "text", text: "Verified synthetic narrative." }], usage: usage(100) }; } },
	};
	z.setRecallMode("file", { read: true, grep: false, bash: true });
	z.sessionStart(ctx);
	const event = (reason = "threshold") => ({ reason, signal: new AbortController().signal, branchEntries: sm.getBranch() });
	return { z, sm, ctx, event, finish, calls: () => calls, prepare: async () => { z.prepareSpeed(ctx); await z.bg?.promise; } };
}

describe("speed routing", () => {
	test("virtual selections stay unresolved despite alternating physical windows and distinct overrides", async () => { const r=rig(); await r.prepare(); const prepared=r.z.mine.length; r.ctx.model={...model,api:"pi-virtual",id:"router",contextWindow:1000000}; for (const physical of [32768,1000000]) { r.ctx.model.contextWindow=physical; expect(pressure(r.ctx.model,{compaction:{modelOverrides:{"synthetic/router":{reserveTokens:0},"synthetic/physical":{reserveTokens:100}}}})).toBeNull(); expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined(); } expect(r.z.mine.length).toBe(prepared); });
});

describe("speed worker and adoption", () => {
	test("foreground hooks finish with an unresolved worker, including native safety pressure", async () => { const r=rig({held:true}); r.z.prepareSpeed(r.ctx); expect(r.calls()).toBe(0); await Promise.resolve(); await Promise.resolve(); expect(r.z.bg).not.toBeNull(); const view=r.sm.buildSessionProjection(); for(const mode of ["rpc","print","json","tui"]) { r.ctx.mode=mode; await r.z.input({text:"new"},r.ctx); await r.z.context({messages:view.messages},r.ctx); await r.z.turnEnd({entries:[],message:assistant(),context:{contextEntries:view.entries}},r.ctx); } expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined(); expect(r.sm.getBranch().some(e=>e.type==="compaction")).toBe(false); r.finish(); await r.z.bg?.promise; });
	test("only automatic adoption, with an immutable result and a frozen <= P target", async () => { const r=rig(); await r.prepare(); expect(r.calls()).toBe(1); const a=r.z.mine.find((a:Any)=>a.cut); expect(a?.speed).toBeDefined(); const before=JSON.stringify(r.sm.buildSessionProjection().messages); expect(r.z.sessionBeforeCompact(r.event("manual"),r.ctx)).toBeUndefined(); await r.z.input({text:"future user has no ID"},r.ctx); expect(JSON.stringify(r.sm.buildSessionProjection().messages)).toBe(before); const blocks=buildBlocks(r.sm.buildSessionProjection().entries), at=blocks.findIndex(b=>b.entryId===a.key), exact=afterSize(blocks,at,a.cut.text,r.z.speedState(r.ctx).scale); a.speed.target=exact; const out=r.z.sessionBeforeCompact(r.event("overflow"),r.ctx); expect(out?.compaction.summary).toBe(a.cut.text); expect(out.compaction.details.after).toBe(exact); expect(out.compaction.details.target).toBe(exact); a.speed.target=exact-1; expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined();
		a.speed.target=exact;
		const persisted=r.sm.appendCompaction(out.compaction.summary,out.compaction.firstKeptEntryId,out.compaction.tokensBefore,out.compaction.details,true,out.compaction.usage);
		r.z.sessionCompacted({compactionEntry:r.sm.getEntry(persisted)},r.ctx);
		expect(r.z.stats.summaries).toBe(1);expect(r.z.speedSample).toBeNull();
		expect(r.z.speedState(r.ctx).tokens).toBeLessThanOrEqual(exact); });
	test.each(["cancel", "stale", "settings", "unavailable-settings", "model", "off", "conflict", "no-recall"])("%s leaves native compaction available", async kind => { const r=rig(); await r.prepare(); expect(r.calls()).toBe(1); const e=r.event("overflow"); if(kind==="cancel") e.signal=AbortSignal.abort(); if(kind==="stale") { const edit=r.sm.getBranch().find((e:Any)=>e.message?.role==="user")!; r.sm.appendContextEdit(edit.id,{content:"changed prefix"} as Any); } if(kind==="settings") r.z.pi.getSettings=()=>({compaction:{reserveTokens:1.25}}); if(kind==="unavailable-settings") r.z.pi.getSettings=undefined; if(kind==="model") r.ctx.model={...model,baseUrl:"https://changed.invalid"}; if(kind==="off") r.z.setOff(true); if(kind==="conflict") r.z.conflict="other"; if(kind==="no-recall") r.z.setRecallMode("reread",{read:false,grep:false,bash:false}); expect(r.z.sessionBeforeCompact({...e,branchEntries:r.sm.getBranch()},r.ctx)).toBeUndefined(); });
	test("failed narratives are charged, recorded, never adopted or regenerated for an identical prefix", async () => { const r=rig({failed:true}); await r.prepare(); expect(r.z.mine[0].cut.llmOk).toBe(false); expect(r.z.mine[0].usd).toBeGreaterThan(0); expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined(); await r.prepare(); expect(r.calls()).toBe(1); });
	test("no session or no useful guarded cut starts no speculative work", async () => { const r=rig({memory:true}); await r.prepare(); expect(r.calls()).toBe(0); expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined(); const p=pressure({...model,contextWindow:32768},{})!; expect(speedPlan(r.sm.buildSessionProjection().entries,model,p,UNIT,new Set(),"id")).toBeNull(); });
	test("stale completion after a model switch is never installed", async () => { const r=rig({held:true}); r.z.prepareSpeed(r.ctx); const pending=r.z.bg.promise; r.ctx.model={...model,id:"another"}; r.z.prepareSpeed(r.ctx); r.finish(); await pending; expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined(); });
	test("payload repair is bypassed; sticky is the only permitted payload difference", async () => { const r=rig(); const malformed={messages:[{role:"user",content:[{type:"tool_result",tool_use_id:"orphan",content:"original"}]}]}; expect(await r.z.providerRequest({payload:malformed},r.ctx)).toBeUndefined(); expect(malformed.messages[0].content[0].type).toBe("tool_result"); r.ctx.model={...model,api:"anthropic-messages"}; const out=await r.z.providerRequest({payload:malformed},r.ctx); expect(out.messages).toEqual(malformed.messages); expect(out.metadata.user_id).toContain(r.sm.getSessionId()); });
});

describe("reasoning, recent requests, and effort", () => {
	test("the two newest long requests and images stay intact; prefix-bound retained reasoning defers", async () => { const r=rig(); const state=r.z.speedState(r.ctx), p=speedPlan(state.view,model,state.p,state.scale,new Set(),state.identity)!; expect(p).not.toBeNull(); const kept=p.blocks.slice(p.cutIdx!); expect(kept.filter(b=>b.kind==="user").length).toBeGreaterThanOrEqual(2); const recent=p.blocks.findLast(b=>b.kind==="user")!; recent.msg.content=[{type:"text",text:"start"+"x".repeat(4000)+"CRITICAL MIDDLE"+"y".repeat(4000)},{type:"image",data:"AA==",mimeType:"image/png"}]; const last=kept.findLast(b=>b.kind==="assistant")!; last.msg.content.push({type:"thinking",thinking:"opaque",thinkingSignature:"signed"}); expect(safeCut(p.blocks,p.cutIdx!,{...model,api:"anthropic-messages"})).toBe(false); expect(safeCut(p.blocks,p.cutIdx!,model)).toBe(true); last.msg.stopReason="toolUse"; expect(safeCut(p.blocks,p.cutIdx!,model)).toBe(false); expect(JSON.stringify(recent.msg.content)).toContain("CRITICAL MIDDLE"); });
	test("capability mappings are resolved without network discovery", () => { expect(summaryEffort({...model,reasoning:true},16384).raw).toEqual({reasoningEffort:"low"}); expect(summaryEffort({...model,reasoning:true,thinkingLevelMap:{minimal:null,low:null,medium:"medium"}},16384).raw).toEqual({reasoningEffort:"medium"}); expect(summaryEffort(model,16384).raw).toEqual({}); expect(()=>summaryEffort({...model,reasoning:true,thinkingLevelMap:{low:"none"}},16384)).toThrow(); expect(()=>summaryEffort({...model,reasoning:true,api:"anthropic-messages"},1000)).toThrow(); });
	test("speed summary prefixes and identity are stable across appends; thinking is stripped", async () => { const r=rig(); const blocks=buildBlocks(r.sm.buildSessionProjection().entries).slice(0,3); blocks[1].msg.content.push({type:"thinking",thinking:"PRIVATE",thinkingSignature:"opaque"}); const calls:Any[]=[]; const ctx={...r.ctx,model:{...model,reasoning:true},modelRegistry:{complete:async(_m:Any,c:Any,o:Any)=>(calls.push({c,o}),{stopReason:"stop",content:[{type:"text",text:"summary"}]})}}; const lane={sessionId:"lane",cacheRetention:"short" as const}; await narrative(blocks,ctx,4000,undefined,null,lane); await narrative([...blocks,...buildBlocks(r.sm.buildSessionProjection().entries).slice(3,4)],ctx,4000,undefined,null,lane); expect(calls).toHaveLength(2); expect(calls[0].o.reasoningEffort).toBe("low"); expect(calls[0].o.sessionId).toBe(calls[1].o.sessionId); expect(calls[1].c.messages.slice(0,calls[0].c.messages.length)).toEqual(calls[0].c.messages); expect(JSON.stringify(calls)).not.toContain("PRIVATE"); });
});


test("foreground Esc does not own the worker's signal", async () => {
	const r = rig({held:true}); r.z.prepareSpeed(r.ctx); const pending = r.z.bg.promise;
	r.ctx.signal = AbortSignal.abort();
	await r.z.context({messages:r.sm.buildSessionProjection().messages},r.ctx);
	await r.z.settle({entries:[],context:{contextEntries:r.sm.buildSessionProjection().entries}},r.ctx);
	expect(r.z.bg.aborted).toBe(false); r.finish(); await pending;
	expect(r.z.mine.some((a:Any)=>a.cut?.llmOk)).toBe(true);
});


test.each(["length", "aborted", "empty", "toolCall", "transient"])("%s worker failure is recorded but cannot replace native safety", async failure => {
	const r=rig(); let attempts=0;
	r.ctx.modelRegistry.complete=async()=>{ attempts++; if(failure==="transient") throw new Error("synthetic transport failure"); return {
		stopReason:failure==="length"||failure==="aborted"?failure:"stop", usage:usage(20),
		content:failure==="empty"?[]:failure==="toolCall"?[{type:"toolCall",id:"no",name:"bash",arguments:{command:"forbidden"}}]:[{type:"text",text:"partial"}]
	}; };
	await r.prepare(); expect(r.z.mine.some((a:Any)=>a.cut?.llmOk===false)).toBe(true);
	expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined();
	expect(attempts).toBeLessThanOrEqual(2); await r.prepare(); expect(r.z.bg).toBeNull();
});

test("summary deadline and local input-budget refusal never wait on the foreground", async()=>{
	const r=rig(), timeout=AbortSignal.timeout;
	try { AbortSignal.timeout=()=>AbortSignal.abort(new Error("synthetic summary deadline")); await r.prepare(); }
	finally { AbortSignal.timeout=timeout; }
	expect(r.calls()).toBe(0); expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)).toBeUndefined();
	const blocks=buildBlocks(r.sm.buildSessionProjection().entries);
	const n=await narrative(blocks,{...r.ctx,model:{...model,contextWindow:40000}},4000,undefined,null,{sessionId:"budget",cacheRetention:"short"});
	expect(n.ok).toBe(false);expect(n.error).toContain("input exceeds");expect(r.calls()).toBe(0);
});

test("steering IDs cannot turn the two-user-turn guard into a deeper cut",async()=>{
	const r=rig();await r.z.beforeAgentStart(r.ctx,{messageType:"user"});await r.z.agentStart(r.ctx);
	const first={role:"user",content:"new prompt",timestamp:100001};r.sm.appendMessage(first as Any);r.z.messageEnd(first,r.ctx);
	const steer={role:"user",content:"steering constraint",timestamp:100002};const id=r.sm.appendMessage(steer as Any);r.z.messageEnd(steer,r.ctx);
	const msg=assistant();r.sm.appendMessage(msg);
	const out=await r.z.turnEnd({entries:[],message:msg,context:{contextEntries:r.sm.buildSessionProjection().entries}},r.ctx);
	expect(out.entries.find((e:Any)=>e.customType==="pi-zip/steer").data.ids).toEqual([id]);
	await r.z.beforeAgentStart(r.ctx,{messageType:"user"});await r.z.agentStart(r.ctx);
	const next={role:"user",content:"another prompt",timestamp:100003};r.z.messageEnd(next,r.ctx);
	expect(r.z.steerTs.size).toBe(0);
});


test("model-specific artifacts survive a switch away and back without a duplicate call",async()=>{
	const r=rig();await r.prepare();const original=r.z.mine.find((a:Any)=>a.cut);
	r.ctx.model={...model,id:"second-physical",contextWindow:200000};await r.prepare();expect(r.calls()).toBe(2);
	r.ctx.model={...model};await r.prepare();expect(r.calls()).toBe(2);
	expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)?.compaction.summary).toBe(original.cut.text);
	expect(r.z.speedSelected.identity).toBe(original.speed.identity);
});

test("suffix growth prepares a deeper replacement without mutating the existing summary",async()=>{
	const r=rig();await r.prepare();const old=r.z.mine.find((a:Any)=>a.cut), snapshot=JSON.stringify(old);
	r.sm.appendMessage({role:"user",content:"new suffix "+"x".repeat(160000),timestamp:200000} as Any);
	await r.prepare();expect(r.calls()).toBe(2);expect(JSON.stringify(old)).toBe(snapshot);
	const next=r.z.mine.filter((a:Any)=>a.cut).at(-1);expect(next.key).not.toBe(old.key);
	expect(r.z.sessionBeforeCompact(r.event("overflow"),r.ctx)?.compaction.firstKeptEntryId).toBe(next.key);
});


test("slow summary history stays with its physical model",()=>{
	const r=rig();r.z.speedDurations.set("synthetic/physical",[200]);
	const slow=r.z.speedState(r.ctx).p;
	r.ctx.model={...model,id:"fast",contextWindow:250000};
	expect(r.z.speedState(r.ctx).p).toEqual(pressure(r.ctx.model,{},r.z.speedDeltas,250,[]));
	expect(slow.P).toBe(pressure(model,{},[],250,[200])!.P);
});


test("changed frozen prefix cancels a worker, but suffix appends preserve it",async()=>{
	const r=rig({held:true});r.z.prepareSpeed(r.ctx);const bg=r.z.bg;
	r.sm.appendMessage({role:"user",content:"append only",timestamp:200001} as Any);
	r.z.prepareSpeed(r.ctx);expect(r.z.bg).toBe(bg);expect(bg.controller.signal.aborted).toBe(false);
	const first=r.sm.getBranch().find((e:Any)=>e.message?.role==="user")!;
	r.sm.appendContextEdit(first.id,{content:"external replacement"} as Any);
	r.z.prepareSpeed(r.ctx);expect(bg.aborted).toBe(true);expect(bg.controller.signal.aborted).toBe(true);
	r.finish();await bg.promise;await r.z.bg?.promise;
	expect(r.z.mine.some((a:Any)=>a.lost==="replaced")).toBe(true);
	expect(r.z.mine.filter((a:Any)=>a.cut).every((a:Any)=>a.speed.prefix!==bg.speed.prefix)).toBe(true);
});

test.each(["off","shutdown","conflict"])("worker completion cannot restart after %s",async stop=>{
	const r=rig({held:true});r.z.prepareSpeed(r.ctx);const pending=r.z.bg.promise;
	await new Promise(resolve=>setTimeout(resolve,0));
	expect(r.calls()).toBe(1);
	r.sm.appendMessage({role:"user",content:"oversized suffix "+"x".repeat(160000),timestamp:200002} as Any);
	r.z.prepareSpeed(r.ctx);
	if(stop==="off") r.z.setOff(true);else if(stop==="shutdown") r.z.shutdown();else r.z.conflict="other";
	r.finish();await pending;await Promise.resolve();expect(r.calls()).toBe(1);expect(r.z.bg).toBeNull();
});

test("speed growth has one owner and resets by session, model and compaction epoch",async()=>{
	const r=rig(), last=r.sm.getBranch().findLast((e:Any)=>e.message?.role==="assistant") as Any;
	last.message.usage=usage(100000);
	await r.z.beforeAgentStart(r.ctx,{messageType:"user"});await r.z.agentStart(r.ctx);
	await r.z.context({messages:r.sm.buildSessionProjection().messages},r.ctx);
	r.z.messageEnd(assistant(100000),r.ctx);r.z.prepareSpeed(r.ctx);
	r.sm.appendMessage({role:"user",content:"next user",timestamp:300001} as Any);
	await r.z.context({messages:r.sm.buildSessionProjection().messages},r.ctx);
	const m=assistant(110000);r.sm.appendMessage(m);r.z.messageEnd(m,r.ctx);
	expect(r.z.deltas.at(-1)).toBe(10000);expect(r.z.speedDeltas).toEqual([]);
	r.z.prepareSpeed(r.ctx);r.z.prepareSpeed(r.ctx);
	expect(r.z.speedDeltas).toEqual([10000]); // turn_end and settle cannot sample the same completion twice.
	r.ctx.model={...model,id:"different-physical"};r.z.prepareSpeed(r.ctx);
	expect(r.z.speedDeltas).toEqual([]);expect(r.z.speedState(r.ctx).p).toEqual(pressure(r.ctx.model,{}));
	r.z.speedDeltas=[90000];r.z.speedVelocity=900;
	const first=r.sm.getBranch().find((e:Any)=>e.message?.role==="user")!;
	r.sm.appendCompaction("external epoch",first.id,110001);
	r.z.speedState(r.ctx);expect(r.z.speedDeltas).toEqual([]);expect(r.z.speedVelocity).toBe(250);
	r.z.speedDeltas=[80000];
	const next=SessionManager.inMemory("/tmp/another-speed-session");
	r.ctx.sessionManager={...r.ctx.sessionManager,getBranch:()=>next.getBranch(),getSessionId:()=>next.getSessionId(),buildSessionProjection:()=>next.buildSessionProjection()};
	r.z.speedState(r.ctx);expect(r.z.speedDeltas).toEqual([]);expect(r.z.speedSample).toBeNull();
});


test("worker readiness reevaluation never samples growth or changes the main completion clock",async()=>{
	let clock=0;
	const now=spyOn(performance,"now").mockImplementation(()=>clock);
	try {
		const observe=async(intervene:boolean,growAtWake=false)=>{
			clock=0;const r=rig({held:true});
			await r.z.beforeAgentStart(r.ctx,{messageType:"user"});await r.z.agentStart(r.ctx);
			const last=r.sm.getBranch().findLast((e:Any)=>e.message?.role==="assistant") as Any;
			last.message.usage=usage(100000);r.z.prepareSpeed(r.ctx);
			const baseline={...r.z.speedSample};
			if(intervene) {
				// Start a real held worker without inventing another main observation.
				const state=r.z.speedState(r.ctx),plan=speedPlan(state.view,r.ctx.model,state.p,state.scale,new Set(),state.identity)!;
				expect(r.z.startBg(plan,r.ctx)).toBe(true);const pending=r.z.bg.promise;
				clock=99000;if(growAtWake) last.message.usage=usage(105000);
				r.finish();await pending;await Promise.resolve();
				expect(r.z.speedSample).toEqual(baseline);expect(r.z.speedDeltas).toEqual([]);
			}
			// Isolate growth timing from the completed summary's legitimately learned service time.
			r.z.speedDurations.clear();
			clock=100000;last.message.usage=usage(110000);r.z.prepareSpeed(r.ctx);
			return {deltas:r.z.speedDeltas,velocity:r.z.speedVelocity,P:r.z.speedState(r.ctx).p.P};
		};
		const uninterrupted=await observe(false),workerWake=await observe(true),growingWake=await observe(true,true);
		expect(uninterrupted.deltas).toEqual([10000]);expect(uninterrupted.velocity).toBe(235);
		expect(workerWake).toEqual(uninterrupted);expect(growingWake).toEqual(uninterrupted);
	} finally { now.mockRestore(); }
});
