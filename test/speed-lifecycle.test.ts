// Real Pi 1.4.0 AgentSession, extension loading, automatic compaction and persistence. Synthetic provider only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createProvider, createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, InMemoryModelsStore, InMemoryCredentialStore, getSystemMessageText, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { handleFor } from "../src/placeholder.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import { recallRoot } from "../src/recallfile.ts";
import piZip from "../src/index.ts";
import type { Any } from "./helpers.ts";

const disposals: (()=>Promise<void>)[]=[];
beforeEach(()=>{process.env.PI_ZIP_MODE="speed";});
afterEach(async()=>{for(const dispose of disposals.splice(0)) await dispose();process.env.PI_ZIP_MODE="early";});
const clean = (value:Any) => JSON.parse(JSON.stringify(value,(k,v)=>k==="timestamp"?undefined:v));
const bytes = (context:Any) => JSON.stringify(clean(resolveTranscript(normalizeContext(context),true)));

async function lifecycle(options: { native?:boolean; seed?:Any[]; held?:boolean; foreign?: "replace"|"cancel"; memory?:boolean; warm?:boolean; bound?:boolean; tools?:string[]; cwd?:string; reopen?:string; wire?:"anthropic-messages"|"openai-responses" }={}) {
	const dir=mkdtempSync(join(tmpdir(),"pz-speed-life-"));
	const faux=fauxProvider({provider:"speed-offline",api:options.wire ?? (options.bound?"anthropic-messages":"speed-synthetic"),models:[{id:"physical",contextWindow:200000,maxTokens:16384,reasoning:!!options.bound || !!options.wire,cost:{input:100,output:1,cacheRead:.01,cacheWrite:100}},{id:"small",contextWindow:65536,maxTokens:8192}],tokenSize:{min:10000,max:10000}});
	const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
	const wire:Any[]=[], wireOptions:Any[]=[], replies:Any[]=[];
	let fetches=0;
	const api=options.wire === "anthropic-messages" ? anthropic : responses;
	const connected=(simple:boolean)=>(m:Any,c:Any,o:Any)=>{
		const stream=createAssistantMessageEventStream();
		void (async()=>{
			const sys=c.messages.filter((m:Any)=>m.role==="system").map(getSystemMessageText).join("\n");
			const kind=sys.includes("write ONLY the requested summary sections")?"summary":sys.includes("summariz")?"native":"main";
			let captured=false;
			const result=await (simple?api.streamSimple:api.stream)(m,c,{
				...o,apiKey:"synthetic",maxRetries:0,
				fetch:async()=>{fetches++;throw new Error("network forbidden in lifecycle fixture");},
				onPayload:async(p:Any)=>{
					const payload=await o?.onPayload?.(p,m) ?? p;
					wire.push({kind,payload:structuredClone(payload)});
					// Capture every serializable provider option, omitting only callbacks and the per-request signal.
					const {signal,...serializable}=o??{};
					wireOptions.push({kind,options:JSON.parse(JSON.stringify(serializable))});
					expect(signal?.aborted ?? false).toBe(false);
					captured=true;throw new Error("captured before dispatch");
				},
			} as Any).result();
			expect(result.stopReason).toBe("error");expect(captured).toBe(true);
			const reply=await respond(c,o);
			const message={...reply,api:m.api,provider:m.provider,model:m.id,timestamp:200000,
				usage:{input:1000,output:1,cacheRead:0,cacheWrite:0,totalTokens:1001,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
			stream.push({type:"start",partial:message});
			stream.push({type:"done",reason:message.stopReason,message});stream.end(message);
		})().catch(error=>stream.end({...fauxAssistantMessage([],{stopReason:"error",errorMessage:String(error)}),api:m.api,provider:m.provider,model:m.id}));
		return stream;
	};
	if(options.wire) runtime.registerNativeProvider(createProvider({id:"speed-offline",auth:{apiKey:{name:"Synthetic",resolve:async()=>({auth:{apiKey:"synthetic"}})}},
		models:faux.models.map(m=>({...m,baseUrl:"https://offline.invalid/v1",compat:{supportsMidConvoSystemMessages:true,supportsMidConvoToolChanges:true,supportsMidConvoEffort:true}})),
		api:{stream:connected(false),streamSimple:connected(true)}}));
	else runtime.registerNativeProvider(faux.provider);
	const model=runtime.getModel("speed-offline","physical")!, cwd=options.cwd ?? dir;
	if(options.warm) model.promptCache={short:300,long:3600};
	const seedFile=join(dir,"seed.jsonl");
	if(options.seed && !options.memory) writeFileSync(seedFile,options.seed.map(e=>JSON.stringify(e)).join("\n")+"\n");
	const sm=options.reopen ? SessionManager.open(options.reopen) : options.seed ? options.memory ? SessionManager.inMemory(cwd,undefined,structuredClone(options.seed)) : SessionManager.open(seedFile) : options.memory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd,join(dir,"sessions"));
	if(!options.seed && !options.reopen) {
		for(let i=0;i<5;i++) {
			sm.appendMessage({role:"user",content:`request ${i} `+"x ".repeat(32000)+`CRITICAL-MIDDLE-${i}`+"x ".repeat(32000),timestamp:1000+i*2} as Any);
			if(i===0) {
				const opaque=options.wire === "anthropic-messages" ? [{type:"thinking",thinking:"opaque prior reasoning",thinkingSignature:"lifecycle-signed-prefix"},{type:"thinking",thinking:"",thinkingSignature:"lifecycle-redacted-prefix",redacted:true}] : [];
				sm.appendMessage({...fauxAssistantMessage([...opaque,{type:"toolCall",id:"original-call",name:"bash",arguments:{command:"printf synthetic-original"}}],{stopReason:"toolUse"}),api:model.api,provider:model.provider,model:model.id} as Any);
				sm.appendMessage({role:"toolResult",toolName:"bash",toolCallId:"original-call",isError:false,content:[{type:"text",text:"EXACT ORIGINAL\n"+"synthetic output\n".repeat(500)}],timestamp:1000} as Any);
			}
			const content=options.wire==="openai-responses" && i===4 ? [{type:"thinking",thinking:"opaque public summary",thinkingSignature:JSON.stringify({id:"rs_lifecycle",type:"reasoning",encrypted_content:"lifecycle-encrypted-suffix",summary:[]})},{type:"text",text:"done"}] : "done";
			sm.appendMessage({...fauxAssistantMessage(content as Any),api:model.api,provider:model.provider,model:model.id,timestamp:1001+i*2,usage:{input:(i+1)*32000,output:1,cacheRead:0,cacheWrite:0,totalTokens:(i+1)*32000+1,cost:{total:0}}} as Any);
		}
	}
	const settings=SettingsManager.inMemory({cacheWarming:options.warm?"idle":"off",retry:{enabled:false},compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:20000}} as Any);
	const main:Any[]=[], summaries:Any[]=[], native:Any[]=[], hooks:Any[]=[], errors:Any[]=[], failed:Any[]=[];
	let finish!:()=>void;
	const held=new Promise<void>(r=>finish=r);
	let extension:Any;
	const factory=(pi:Any)=>{
		if(!options.native) piZip(pi);
		pi.on("session_before_compact",(e:Any)=>{hooks.push(e); if(options.foreign==="cancel") return {cancel:true}; if(options.foreign==="replace") return {compaction:{summary:"foreign immutable",firstKeptEntryId:e.preparation.firstKeptEntryId,tokensBefore:e.preparation.tokensBefore,details:{by:"foreign"}}};});
		pi.on("session_compact_failed",(e:Any)=>{failed.push(e);});
		extension=pi;
	};
	const loader=new DefaultResourceLoader({cwd,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[factory],systemPrompt:"Synthetic native system."});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const respond=async(c:Any,o:Any)=>{
		// Synthetic usage has no cache: avoid Faux counting a first write in both input and cacheWrite.
		if(o && !options.wire) o.cacheRetention="none";
		const sys=c.messages.filter((m:Any)=>m.role==="system").map(getSystemMessageText).join("\n");
		if(sys.includes("write ONLY the requested summary sections")) {summaries.push({context:clean(c),options:o}); if(options.held) await held; return fauxAssistantMessage("Verified immutable synthetic summary.");}
		if(sys.includes("summariz") || c.messages.some((m:Any)=>JSON.stringify(m).includes("summarize the conversation"))) {native.push(clean(c));return fauxAssistantMessage("native safety summary");}
		main.push(clean(c));return replies.shift() ?? fauxAssistantMessage("synthetic solved");
	};
	faux.setResponses(Array.from({length:100},()=>respond));
	const {session}=await createAgentSession({cwd,agentDir:dir,modelRuntime:runtime,model,settingsManager:settings,sessionManager:sm,resourceLoader:loader,thinkingLevel:"off",tools:options.tools});
	await session.bindExtensions({mode:"rpc",onError:e=>errors.push(e)});
	disposals.push(async()=>{finish();await session.abort();await (session as Any)._extensionRunner.emit({type:"session_shutdown"});session.dispose();});
	const idleWorker=async()=>{for(let i=0;i<100;i++){if(sm.getBranch().some((e:Any)=>e.customType==="pi-zip/summary"))return;await new Promise(r=>setTimeout(r,2));}throw new Error("worker did not complete: "+JSON.stringify({errors,summaries:summaries.length}));};
	const raise=(n=190000)=>{const last=sm.getBranch().findLast((e:Any)=>e.message?.role==="assistant") as Any;last.message.usage={...last.message.usage,input:n-1,totalTokens:n};};
	return {cwd,runtime,session,sm,model,main,summaries,native,hooks,errors,finish,raise,idleWorker,extension,settings,wire,wireOptions,replies,failed,fetches:()=>fetches};
}

test("Pi 1.4 lifecycle: below-pressure context and tools equal an extension-free baseline",async()=>{
	delete process.env.PI_ZIP_MODE; // exercise the actual unset/default mode through extension registration
	for(const tools of [undefined,["read","bash"]]) {
		const speed=await lifecycle({tools});await speed.idleWorker();
		const seed=[speed.sm.getHeader(),...speed.sm.getBranch().filter((e:Any)=>e.type!=="custom")];
		const native=await lifecycle({native:true,seed,cwd:speed.cwd,tools});
		speed.raise(175423);native.raise(175423); // T - 1, including an explicit built-in allowlist
		await speed.session.prompt("next synthetic request");await native.session.prompt("next synthetic request");
		expect(speed.errors).toEqual([]);expect(native.errors).toEqual([]);
		expect(speed.main).toHaveLength(1);expect(native.main).toHaveLength(1);
		expect(bytes(speed.main[0])).toBe(bytes(native.main[0]));
		expect(speed.session.getActiveToolNames()).toEqual(native.session.getActiveToolNames());
		expect(speed.session.getActiveToolNames()).not.toContain("zip_recall");
		expect(speed.sm.getBranch().filter(e=>e.type==="compaction")).toHaveLength(0);
	}
});

test("Pi 1.4 lifecycle: automatic compaction persists one immutable prefix before continuation",async()=>{
	const r=await lifecycle();await r.idleWorker();
	expect(r.summaries).toHaveLength(1);
	await r.session.prompt("native prefix before pressure");
	r.raise();await r.session.prompt("after automatic pressure");
	const compact=r.sm.getBranch().filter(e=>e.type==="compaction") as Any[];
	expect(r.errors).toEqual([]);expect(compact).toHaveLength(1);expect(compact[0].details.via).toBe("speed");
	expect(r.native).toHaveLength(0);expect(r.main).toHaveLength(2);
	expect(JSON.stringify(r.main[1])).toContain(compact[0].summary.split("\n")[0]);
	await r.session.prompt("append-only continuation");
	expect(r.sm.getBranch().filter(e=>e.type==="compaction")).toHaveLength(1);
	expect(r.main[2].messages.slice(0,r.main[1].messages.length)).toEqual(r.main[1].messages);
	const rewrites=r.main.slice(1).filter((c:Any,i:number)=>JSON.stringify(c.messages.slice(0,r.main[i].messages.length))!==JSON.stringify(r.main[i].messages));
	expect(rewrites).toHaveLength(1);
	for(const text of ["CRITICAL-MIDDLE-3","CRITICAL-MIDDLE-4"]) expect(JSON.stringify(r.main[1])).toContain(text);
	expect(r.session.getActiveToolNames()).not.toContain("zip_recall");
});

test.each([175424,183616,183617])("Pi's automatic boundary, not input, owns adoption at %i",async n=>{
	const r=await lifecycle();await r.idleWorker();r.raise(n);
	await r.session.prompt("new user is appended after the compaction check");
	const compact=r.sm.getBranch().filter(e=>e.type==="compaction") as Any[];
	expect(r.errors).toEqual([]);
	expect(compact).toHaveLength(n>183616?1:0);
	if(compact.length) expect(compact[0].details.via).toBe("speed");
});

test("real pending worker never blocks foreground; native summary runs at hard pressure",async()=>{
	const r=await lifecycle({held:true});
	await r.session.prompt("foreground finishes while summary is held");
	expect(r.summaries).toHaveLength(1);expect(r.main).toHaveLength(1);
	r.raise();await r.session.prompt("native safety recovery while zip worker stays held");
	expect(r.native.length).toBeGreaterThan(0);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction").every((e:Any)=>e.details?.via!=="speed")).toBe(true);
	expect(r.errors).toEqual([]);r.finish();
});

test.each(["replace","cancel"] as const)("foreign handler %s cannot create a tool or local-prefix transaction",async foreign=>{
	const r=await lifecycle({foreign});await r.idleWorker();const tools=r.session.getActiveToolNames();
	r.raise();await r.session.prompt("foreign handler owns its outcome");
	expect(r.session.getActiveToolNames()).toEqual(tools);expect(tools).not.toContain("zip_recall");
	const compactions=r.sm.getBranch().filter(e=>e.type==="compaction") as Any[];
	if(foreign==="replace"){expect(compactions).toHaveLength(1);expect(compactions[0].summary).toBe("foreign immutable");}
	else expect(compactions).toHaveLength(0);
	expect(r.errors).toEqual([]);
});

test("actual _persist failure has native parity on disk, projection, continuation and reopen",async()=>{
	const outcomes:Any[]=[];
	for(const native of [false,true]) {
		const r=await lifecycle({native});if(!native) await r.idleWorker();r.raise();
		const tools=r.session.getActiveToolNames(), persist=(r.sm as Any)._persist.bind(r.sm);
		let lost:Any;
		(r.sm as Any)._persist=(entry:Any)=>{
			if(entry.type==="compaction" && !lost){lost=entry;throw new Error("synthetic disk write failure");}
			return persist(entry);
		};
		await r.session.prompt("continue after the actual compaction write fails");
		expect(lost).toBeDefined();expect(r.failed).toHaveLength(1);
		expect(r.failed[0].errorMessage).toContain("synthetic disk write failure");
		expect(r.failed[0].fromExtension).toBe(!native);
		expect(r.session.getActiveToolNames()).toEqual(tools);
		expect(r.sm.getBranch().filter(e=>e.type==="compaction")).toEqual([lost]);
		const projected=r.sm.buildSessionProjection().messages;
		expect(projected.some((m:Any)=>m.summary===lost.summary)).toBe(true);
		expect(JSON.stringify(r.main[0])).toContain(lost.summary.split("\n")[0]);
		await r.session.prompt("the following request keeps Pi's in-memory projection");
		expect(JSON.stringify(r.main[1])).toContain(lost.summary.split("\n")[0]);
		const disk=readFileSync(r.sm.getSessionFile()!,"utf8").trim().split("\n").map(line=>JSON.parse(line));
		expect(disk.some(e=>e.type==="compaction")).toBe(false);
		expect(disk.some(e=>e.parentId===lost.id)).toBe(true); // Pi permits an orphan after the failed append.
		const reopened=SessionManager.open(r.sm.getSessionFile()!);
		expect(reopened.getEntries().some(e=>e.type==="compaction")).toBe(false);
		expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain(lost.summary.split("\n")[0]);
		outcomes.push({diskCompactions:disk.filter(e=>e.type==="compaction").length,memoryCompactions:1,
			projectedSummary:projected.some((m:Any)=>m.role==="compactionSummary"),
			reopenedRoles:reopened.buildSessionProjection().messages.map(m=>m.role),
			contextEdits:r.sm.getBranch().filter(e=>e.type==="context_edit").length,
			tools:r.session.getActiveToolNames(),errors:r.errors});
		expect(r.native.length>0).toBe(native);
	}
	expect(outcomes[0]).toEqual(outcomes[1]);expect(outcomes[0].contextEdits).toBe(0);
});

test("a stale candidate falls through to actual native summarization",async()=>{
	const r=await lifecycle();await r.idleWorker();
	const first=r.sm.getBranch().find((e:Any)=>e.message?.role==="user")!;
	r.sm.appendContextEdit(first.id,{content:"external prefix change"+"z".repeat(300000)} as Any);
	r.raise();await r.session.prompt("native safety after external edit");
	expect(r.native.length).toBeGreaterThan(0);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction").every((e:Any)=>e.details?.via!=="speed")).toBe(true);
	expect(r.errors).toEqual([]);
});

test("restart recovers the persisted candidate without regenerating or activating recall",async()=>{
	const first=await lifecycle();await first.idleWorker();
	const resumed=await lifecycle({seed:[first.sm.getHeader(),...first.sm.getBranch()],cwd:first.cwd});
	resumed.raise();await resumed.session.prompt("resumed automatic boundary");
	expect(resumed.summaries).toHaveLength(0);
	expect((resumed.sm.getBranch().find(e=>e.type==="compaction") as Any)?.details.via).toBe("speed");
	expect(resumed.session.getActiveToolNames()).not.toContain("zip_recall");
	expect(resumed.errors).toEqual([]);
});

test("in-memory sessions without file recall keep native recovery",async()=>{
	const r=await lifecycle({memory:true});r.raise();await r.session.prompt("no persisted recall source");
	expect(r.summaries).toHaveLength(0);expect(r.native.length).toBeGreaterThan(0);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction").every((e:Any)=>e.details?.via!=="speed")).toBe(true);
});

test("Pi's real warmer refuses an old refresh after the persisted switch",async()=>{
	const r=await lifecycle({warm:true});await r.idleWorker();
	await r.session.prompt("seed the real warmer below pressure");
	const warmer=(r.session as Any)._cacheWarmer, old=warmer.run;
	expect(old).toBeDefined();expect(old.isCurrent()).toBe(true);
	r.raise();await r.session.prompt("automatic compaction invalidates old refresh");
	expect(old.isCurrent()).toBe(false);
	const calls=r.main.length+r.summaries.length+r.native.length;
	await warmer.refresh(old);
	expect(r.main.length+r.summaries.length+r.native.length).toBe(calls);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction")).toHaveLength(1);
	expect(warmer.run).not.toBe(old);
});

test("invalid settings cannot supply a compaction through the real public hook",async()=>{
	const r=await lifecycle();await r.idleWorker();
	for(const invalid of [1.25,Number.MAX_SAFE_INTEGER+1]) {
		r.settings.applyOverrides({compaction:{reserveTokens:invalid}});
		const out=await (r.session as Any)._extensionRunner.emit({type:"session_before_compact",reason:"threshold",signal:new AbortController().signal,branchEntries:r.sm.getBranch()});
		expect(out).toBeUndefined();expect(()=>r.settings.getCompactionSettings(r.model)).toThrow();
	}
	expect(r.session.getActiveToolNames()).not.toContain("zip_recall");
});

test("a real virtual selection alternating physical windows always leaves adoption to Pi",async()=>{
	const r=await lifecycle();await r.idleWorker();let routes=0;
	r.runtime.registerVirtualModel({provider:r.model.provider,id:"router",name:"Synthetic router",contextWindow:1000000,
		route:()=>({model:r.runtime.getModel(r.model.provider,++routes%2?"small":"physical")!,thinkingLevel:"off"})});
	r.settings.applyOverrides({compaction:{modelOverrides:{"speed-offline/router":{reserveTokens:1000},"speed-offline/small":{reserveTokens:2000},"speed-offline/physical":{reserveTokens:3000}}}});
	await r.session.setModel(r.runtime.getModel(r.model.provider,"router")!);
	expect(r.session.model?.api).toBe("pi-virtual");
	await r.session.prompt("first physical window");await r.session.prompt("second physical window");
	expect(routes).toBeGreaterThan(1);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction").every((e:Any)=>e.details?.via!=="speed")).toBe(true);
	expect(r.summaries).toHaveLength(1);expect(r.errors).toEqual([]);
});


test("default file recall materializes the exact old output after real compaction",async()=>{
	const r=await lifecycle();await r.idleWorker();r.raise();await r.session.prompt("compact with fixed file recall");
	const original=r.sm.getBranch().find((e:Any)=>e.message?.toolCallId==="original-call") as Any;
	expect(original).toBeDefined();
	const handle=handleFor(original.id), input={path:`~/.cache/pi-zip/recall/${r.sm.getSessionId()}/${handle}.txt`};
	await (r.session as Any)._extensionRunner.emit({type:"tool_call",toolName:"read",toolCallId:"recall-file",input});
	expect(readFileSync(input.path,"utf8")).toBe(original.message.content[0].text);
	expect(r.session.getActiveToolNames()).not.toContain("zip_recall");
});


test("appended signed reasoning keeps the guarded cut native-safe in the real lifecycle",async()=>{
	const r=await lifecycle({bound:true});await r.idleWorker();
	expect(r.summaries).toHaveLength(1);
	r.sm.appendMessage({...fauxAssistantMessage([{type:"thinking",thinking:"opaque",thinkingSignature:"signed-suffix"},{type:"text",text:"completed"}]),api:r.model.api,provider:r.model.provider,model:r.model.id} as Any);
	r.session.agent.state.messages=r.sm.buildSessionContext().messages;
	r.raise();await r.session.prompt("native fallback for retained binding");
	expect(r.native.length).toBeGreaterThan(0);
	expect(r.sm.getBranch().filter(e=>e.type==="compaction").every((e:Any)=>e.details?.via!=="speed")).toBe(true);
	expect(r.errors).toEqual([]);
});


test("append while pending starts a deeper replacement when the worker finishes, without another foreground event",async()=>{
	const r=await lifecycle({held:true});
	await r.session.prompt("appended suffix "+"z".repeat(80000));
	expect(r.summaries).toHaveLength(1);
	// Further queued input grows the persisted suffix while the same worker is still pending.
	r.sm.appendMessage({role:"user",content:"queued suffix "+"q".repeat(160000),timestamp:300000} as Any);
	r.finish();
	for(let i=0;i<200 && r.summaries.length<2;i++) await new Promise(resolve=>setTimeout(resolve,2));
	expect(r.summaries).toHaveLength(2);
	for(let i=0;i<200 && r.sm.getBranch().filter((e:Any)=>e.customType==="pi-zip/summary").length<2;i++) await new Promise(resolve=>setTimeout(resolve,2));
	const artifacts=r.sm.getBranch().filter((e:Any)=>e.customType==="pi-zip/summary").map((e:Any)=>e.data);
	expect(artifacts).toHaveLength(2);expect(artifacts[0].key).not.toBe(artifacts[1].key);
	const old=JSON.stringify(artifacts[0]);r.raise();await r.session.prompt("adopt the ready replacement");
	expect(r.native).toHaveLength(0);
	const compact=r.sm.getBranch().find(e=>e.type==="compaction") as Any;
	expect(compact.details.via).toBe("speed");expect(compact.firstKeptEntryId).toBe(artifacts[1].key);
	expect(JSON.stringify(artifacts[0])).toBe(old);expect(r.errors).toEqual([]);
});

for(const api of ["anthropic-messages","openai-responses"] as const) test(`${api}: real lifecycle wire identity, JSONL reopen, recall turn and following request`,async()=>{
	delete process.env.PI_ZIP_MODE;
	const r=await lifecycle({wire:api});await r.idleWorker();
	const seed=[r.sm.getHeader(),...r.sm.getEntries().filter(e=>e.type!=="custom")];
	const baseline=await lifecycle({native:true,seed,cwd:r.cwd,wire:api});
	const equalMain=(a:Awaited<ReturnType<typeof lifecycle>>,b:Awaited<ReturnType<typeof lifecycle>>)=>{
		const left=a.wire.filter(e=>e.kind==="main"),right=b.wire.filter(e=>e.kind==="main");
		expect(left.length).toBeGreaterThan(0);expect(left).toHaveLength(right.length);
		for(let i=0;i<left.length;i++) {
			const payload=structuredClone(left[i].payload),native=structuredClone(right[i].payload);
			if(api==="anthropic-messages") {
				expect(payload.metadata.user_id).toContain(a.sm.getSessionId());
				delete payload.metadata.user_id;
				if(Object.keys(payload.metadata).length===0) delete payload.metadata;
			}
			expect(JSON.stringify(payload)).toBe(JSON.stringify(native));
		}
		expect(a.wireOptions.filter(e=>e.kind==="main")).toEqual(b.wireOptions.filter(e=>e.kind==="main"));
		for(const entry of a.wireOptions.filter(e=>e.kind==="main")) expect(entry.options.cacheRetention).not.toBe("none");
		expect(a.fetches()+b.fetches()).toBe(0);expect(a.errors).toEqual([]);expect(b.errors).toEqual([]);
	};
	r.raise(175423);baseline.raise(175423);
	await r.session.prompt("native wire at T - 1");await baseline.session.prompt("native wire at T - 1");
	equalMain(r,baseline);
	const firstPayload=r.wire.find(e=>e.kind==="main").payload, firstWire=JSON.stringify(firstPayload);
	if(api==="anthropic-messages") expect(firstWire).toContain("\"cache_control\"");
	else expect(firstPayload.prompt_cache_key).toBeDefined();
	expect(firstWire).toContain("original-call");
	for(const opaque of api==="anthropic-messages"?["lifecycle-signed-prefix","lifecycle-redacted-prefix"]:["lifecycle-encrypted-suffix"]) expect(firstWire).toContain(opaque);
	r.raise();await r.session.prompt("persist the speed boundary");
	const compact=r.sm.getBranch().find(e=>e.type==="compaction") as Any;
	expect(compact.details.via).toBe("speed");
	const reopened=await lifecycle({wire:api,reopen:r.sm.getSessionFile()!,cwd:r.cwd});
	// The extension-free control opens an actual copy of the identical persisted branch.
	const disk=readFileSync(r.sm.getSessionFile()!,"utf8").trim().split("\n").map(line=>JSON.parse(line));
	const native=await lifecycle({wire:api,native:true,seed:disk,cwd:r.cwd});
	expect(reopened.sm.getSessionId()).toBe(r.sm.getSessionId());
	const original=reopened.sm.getEntries().find((e:Any)=>e.message?.toolCallId==="original-call") as Any;
	const path=join(recallRoot(),reopened.sm.getSessionId(),`${handleFor(original.id)}.txt`);
	for(const fixture of [reopened,native]) fixture.replies.push(fauxAssistantMessage([{type:"toolCall",id:"recall-turn",name:"read",arguments:{path}}],{stopReason:"toolUse"}));
	await reopened.session.prompt("recall the original output");await native.session.prompt("recall the original output");
	expect(readFileSync(path,"utf8")).toBe(original.message.content[0].text);
	for(const fixture of [reopened,native]) {
		const result=fixture.sm.getBranch().find((e:Any)=>e.message?.toolCallId==="recall-turn") as Any;
		expect(result.message.isError).toBe(false);expect(result.message.content[0].text).toContain("EXACT ORIGINAL");
	}
	await reopened.session.prompt("following request after completed recall");await native.session.prompt("following request after completed recall");
	expect(reopened.main).toHaveLength(3);equalMain(reopened,native);
	if(api==="openai-responses") expect(JSON.stringify(reopened.wire.filter(e=>e.kind==="main"))).toContain("lifecycle-encrypted-suffix");
	else expect(reopened.wire.find(e=>e.kind==="main").payload.metadata.user_id).toBe(firstPayload.metadata.user_id);
	expect(reopened.session.getActiveToolNames()).toEqual(native.session.getActiveToolNames());
});
