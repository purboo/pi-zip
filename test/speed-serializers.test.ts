// Capture real provider serializers before dispatch. onPayload throws; fetch is a second no-network fence.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as anthropicRaw, streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildCut, narrative, SUMMARY_MARK } from "../src/summary.ts";
import { NARRATIVE_CALL_MAX, toolCallIndex } from "../src/plan.ts";
import { Zip, stickyUserId } from "../src/run.ts";
import { buildBlocks } from "../src/plan.ts";
import { digest, safeCut } from "../src/speed.ts";
import type { Any } from "./helpers.ts";

beforeEach(()=>{process.env.PI_ZIP_MODE="speed";});
afterEach(()=>{process.env.PI_ZIP_MODE="early";});
const base:Any={baseUrl:"https://offline.invalid/v1",contextWindow:200000,maxTokens:16384,reasoning:true,input:["text"],cost:{input:1,output:1,cacheRead:.1,cacheWrite:1}};
const usage={input:100,output:1,cacheRead:0,cacheWrite:0,totalTokens:101,cost:{total:0}};
const sessionId="11111111-2222-4333-8444-555555555555";

for(const api of ["anthropic-messages","openai-responses"]) test(`${api}: native bytes, signed/encrypted reasoning, tool IDs and cache controls survive speed hooks`,async()=>{
	const model={...base,api,provider:api==="anthropic-messages"?"anthropic":"openai",id:api==="anthropic-messages"?"claude-opus-4-7":"gpt-6.1-sol",compat:{supportsMidConvoEffort:true}};
	const signature=api==="anthropic-messages"?"opaque-signed-block":JSON.stringify({id:"rs_1",type:"reasoning",encrypted_content:"opaque-encrypted-block",summary:[]});
	const messages:Any[]=[
		{role:"user",content:"original request",timestamp:0},
		{role:"assistant",api,provider:model.provider,model:model.id,content:[{type:"thinking",thinking:"private reasoning",thinkingSignature:signature},...(api==="anthropic-messages"?[{type:"thinking",thinking:"",thinkingSignature:"redacted-private",redacted:true}]:[]),{type:"toolCall",id:"call_1",name:"bash",arguments:{command:"printf synthetic"}}],stopReason:"toolUse",usage,timestamp:1},
		{role:"toolResult",toolCallId:"call_1",toolName:"bash",isError:false,content:[{type:"text",text:"exact output"}],timestamp:2},
		{role:"assistant",api,provider:model.provider,model:model.id,content:[{type:"text",text:"finished transaction"}],stopReason:"stop",usage,timestamp:3},
		{role:"user",content:"next request",timestamp:4},
	];
	const z:Any=new Zip({getAllTools:()=>[],getSettings:()=>({})} as Any);
	const ctx:Any={model,sessionManager:{getBranch:()=>[],getSessionId:()=>sessionId},modelRegistry:{getApiKeyAndHeaders:async()=>({apiKey:"synthetic"})}};
	const original=structuredClone(messages);
	expect(await z.context({messages},ctx)).toBeUndefined();expect(messages).toEqual(original);
	let fetches=0;
	const capture=async(speed:boolean)=>{
		let payload:Any;
		const stream=api==="anthropic-messages"?anthropic:responses;
		const result=await stream(model,normalizeContext({systemPrompt:"Native instructions",messages,tools:[{name:"bash",description:"run",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}]}),{
			apiKey:"synthetic",reasoning:"low",sessionId,cacheRetention:"long",maxTokens:8192,maxRetries:0,
			fetch:async()=>{fetches++;throw new Error("network forbidden in serializer fixture");},
			onPayload:async(p:Any)=>{payload=speed?(await z.providerRequest({payload:p},ctx)??p):p;throw new Error("captured before dispatch");},
		} as Any).result();
		expect(result.stopReason).toBe("error");expect(payload).toBeDefined();return payload;
	};
	const native=await capture(false), speed=await capture(true);
	if(api==="anthropic-messages") {
		expect(speed.metadata.user_id).toContain(sessionId);
		const {metadata,...content}=speed;expect(content).toEqual(native);
		expect(JSON.stringify(speed.messages)).toContain("opaque-signed-block");
		expect(JSON.stringify(speed.messages)).toContain("redacted-private");
		expect(JSON.stringify(speed.messages)).toContain("redacted_thinking");
	} else {
		expect(speed).toEqual(native);expect(JSON.stringify(speed.input)).toContain("opaque-encrypted-block");
		expect(speed.prompt_cache_key).toBeDefined();
	}
	expect(JSON.stringify(speed)).toContain("call_1");expect(fetches).toBe(0);
});

test("an appended signed suffix invalidates a formerly safe Anthropic candidate without changing any signature",()=>{
	const model={...base,api:"anthropic-messages"};
	const messages:Any[]=[];
	for(let i=0;i<4;i++) messages.push({role:"user",content:`request ${i}`},{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop"});
	const entries=messages.map((m,i)=>({sourceEntry:{id:`id-${i}`,type:"message",message:m},messages:[m]}));
	const blocks=buildBlocks(entries);expect(safeCut(blocks,2,model)).toBe(true);
	const signed={type:"thinking",thinking:"private",thinkingSignature:"unchanged"};
	messages.at(-1).content.push(signed);
	expect(safeCut(buildBlocks(entries),2,model)).toBe(false);expect(signed.thinkingSignature).toBe("unchanged");
});


function summaryWire(model:Any) {
	const calls:Any[]=[], results:Any[]=[];let fetches=0;
	const complete=(simple:boolean)=>async(m:Any,c:Any,o:Any)=>{
		let payload:Any;
		const result=await (simple?anthropic:anthropicRaw)(m,normalizeContext(c),{
			...o,apiKey:"synthetic",maxRetries:0,
			fetch:async()=>{fetches++;throw new Error("network forbidden in summary fixture");},
			onPayload:async(p:Any)=>{payload=structuredClone(await o.onPayload?.(p) ?? p);throw new Error("captured before dispatch");},
		}).result();
		expect(result.stopReason).toBe("error");expect(payload).toBeDefined();
		calls.push({context:structuredClone(c),options:o,payload});
		return results.shift() ?? {role:"assistant",stopReason:"stop",content:[{type:"text",text:"Verified synthetic summary."}]};
	};
	const registry={complete:complete(false),completeSimple:complete(true),getApiKeyAndHeaders:async()=>({apiKey:"synthetic"})};
	return {ctx:{model,modelRegistry:registry,sessionManager:{getSessionId:()=>sessionId}},calls,results,fetches:()=>fetches};
}
const summaryBlocks=(messages:Any[])=>buildBlocks(messages.map((message,i)=>({sourceEntry:{type:"message",id:`summary-${i}`,message},messages:[message]})));
const relay={...base,api:"anthropic-messages",provider:"summary-relay",id:"budget-thinking",maxTokens:64000};

test.each(["speed","early"])("%s: the real Anthropic wire total, including thinking, stays within the chosen summary cap",async mode=>{
	process.env.PI_ZIP_MODE=mode;
	const levels=["minimal","low","medium","high","xhigh","max"];
	for(const level of levels) for(const simple of [true,false]) for(const maxTokens of [64000,4000]) {
		const thinkingLevelMap=Object.fromEntries(["off",...levels].map(key=>[key,key===level?level:null]));
		const r=summaryWire({...relay,maxTokens,thinkingLevelMap});if(!simple) delete (r.ctx.modelRegistry as Any).completeSimple;
		const result=await narrative(summaryBlocks([{role:"user",content:"public conversation",timestamp:0}]),r.ctx,4000,undefined,null,mode==="speed"?{sessionId:"stable-lane",cacheRetention:"short"}:undefined);
		expect(result.ok).toBe(true);expect(r.calls).toHaveLength(1);
		const payload=r.calls[0].payload;
		expect(payload.max_tokens).toBe(Math.min(NARRATIVE_CALL_MAX,maxTokens));
		if(simple) expect(r.calls[0].options.reasoning).toBe(level);
		expect(payload.thinking.type).toBe("enabled");
		expect(payload.thinking.budget_tokens).toBe(2048);
		expect(payload.thinking.budget_tokens).toBeLessThanOrEqual(payload.max_tokens-1024);
		expect(r.fetches()).toBe(0);
	}
});

test("summary instructions remain a fixed serialized prefix when conversation or previous narrative contains their literal marker",async()=>{
	const r=summaryWire({...relay,reasoning:false});
	const messages=[{role:"user",content:"Inspect the literal Write the NARRATIVE part in source.",timestamp:0},
		{role:"assistant",content:[{type:"toolCall",id:"source-call",name:"read",arguments:{path:"src/summary.ts"}}],stopReason:"toolUse",timestamp:1},
		{role:"toolResult",toolCallId:"source-call",toolName:"read",content:[{type:"text",text:"const source = 'Write the NARRATIVE part';"}],timestamp:2},
		{role:"assistant",content:[{type:"text",text:"completed one"}],stopReason:"stop",timestamp:3}];
	const lane={sessionId:"stable-lane",cacheRetention:"short" as const};
	for(const previous of [null,{text:"Earlier Write the NARRATIVE part marker in public prose.",at:"stable",foreign:false}]) {
		await narrative(summaryBlocks(messages),r.ctx,4000,undefined,previous as Any,lane);
		await narrative(summaryBlocks([...messages,{role:"user",content:"one more chunk",timestamp:4}]),r.ctx,4000,undefined,previous as Any,lane);
		const [before,after]=r.calls.slice(-2);
		expect(before.context.messages[0].content[0].text).toStartWith("Write the NARRATIVE part of a context summary");
		expect(before.context.messages[0].content[0].text).not.toContain("Inspect the literal");
		expect(after.context.messages.slice(0,before.context.messages.length)).toEqual(before.context.messages);
		// Cache control moves to the new tail; all earlier serialized conversation bytes remain unchanged.
		const stripped=(p:Any)=>JSON.parse(JSON.stringify(p,(key,value)=>key==="cache_control"?undefined:value));
		expect(stripped(after.payload).messages.slice(0,before.payload.messages.length)).toEqual(stripped(before.payload).messages);
	}
	expect(r.fetches()).toBe(0);
});

test("summary relay routing is stable on the wire and leaves main request identity and learning untouched",async()=>{
	const r=summaryWire({...relay,provider:"summary-routing-stable"});
	const z:Any=new Zip({} as Any), lane=z.summaryLane(r.ctx,"head","identity");
	z.stickyKey="main-request-in-flight";z.sticky400=1;z.pending={key:"main-learning"};
	const blocks=summaryBlocks([{role:"user",content:"public prefix",timestamp:0}]);
	await narrative(blocks,r.ctx,4000,undefined,null,lane);
	await narrative([...blocks,...summaryBlocks([{role:"user",content:"append",timestamp:1}])],r.ctx,4000,undefined,null,z.summaryLane(r.ctx,"head","identity"));
	expect(r.calls).toHaveLength(2);
	const uid=r.calls[0].payload.metadata.user_id;
	expect(uid).toBe(r.calls[1].payload.metadata.user_id);expect(uid).not.toBe(stickyUserId(sessionId));
	expect(uid).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]{36}$/);
	expect(r.calls[0].options.sessionId).toBe(r.calls[1].options.sessionId);
	expect(r.calls[0].payload.system[0].cache_control).toBeDefined();
	expect(z.stickyKey).toBe("main-request-in-flight");expect(z.sticky400).toBe(1);expect(z.pending).toEqual({key:"main-learning"});
	expect(r.fetches()).toBe(0);z.shutdown();
});

test.each(["disabled","direct","oauth","cli","copilot","existing","claude-code","refused"])("summary routing preserves the existing %s exclusion",async kind=>{
	const r=summaryWire({...relay,provider:`summary-excluded-${kind}`}),z:Any=new Zip({} as Any);
	if(kind==="direct") r.ctx.model.baseUrl="https://api.anthropic.com/v1";
	if(kind==="copilot") r.ctx.model.provider="github-copilot";
	if(kind==="oauth") r.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({apiKey:"sk-ant-oat-synthetic"});
	if(kind==="cli") r.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({apiKey:"synthetic",headers:{"user-agent":"claude-cli"}}) as Any;
	if(kind==="disabled") process.env.PI_ZIP_STICKY="0";
	if(kind==="refused") z.stickyOf(`${r.ctx.model.provider}/${r.ctx.model.id}@${r.ctx.model.baseUrl}`,"off");
	try {
		const lane=z.summaryLane(r.ctx,"head","identity"),payload:Any={system:kind==="claude-code"?"You are Claude Code, test":"summary instructions",messages:[]};
		if(kind==="existing") payload.metadata={user_id:"caller identity"};
		expect(await lane.onPayload(payload)).toBeUndefined();expect(payload.metadata).toEqual(kind==="existing"?{user_id:"caller identity"}:undefined);
	} finally {if(kind==="disabled") delete process.env.PI_ZIP_STICKY;z.shutdown();}
});

test("summary metadata refusal uses its own counter and suppresses the next serialized request",async()=>{
	const r=summaryWire({...relay,provider:"summary-routing-refused"}),z:Any=new Zip({} as Any);
	const lane=z.summaryLane(r.ctx,"head","identity");
	z.stickyKey="main-request-in-flight";z.sticky400=1;
	const blocks=summaryBlocks([{role:"user",content:"public prefix",timestamp:0}]);
	r.results.push({role:"assistant",stopReason:"error",errorMessage:"400 unsupported metadata.user_id"});
	const result=await narrative(blocks,r.ctx,4000,undefined,null,lane);
	expect(result.ok).toBe(true);expect(r.calls).toHaveLength(2);
	expect(r.calls[0].payload.metadata.user_id).toBeDefined();expect(r.calls[1].payload.metadata).toBeUndefined();
	expect(z.stickyKey).toBe("main-request-in-flight");expect(z.sticky400).toBe(1);expect(r.fetches()).toBe(0);z.shutdown();
});


test("buildCut keeps the previous narrative fixed across expanding speed candidates in the same epoch",async()=>{
	const r=summaryWire({...relay,reasoning:false});
	const previous=`${SUMMARY_MARK}\n## User requests\n1. original task\n## Narrative (model-written)\nHEAD-FACT\n${"public state line\n".repeat(2000)}TAIL-FACT`;
	const summary={sourceEntry:{id:"previous-compaction",type:"compaction"},messages:[{role:"compactionSummary",summary:previous,timestamp:1000,tokensBefore:0}]};
	const initial=[{role:"user",content:"first public request",timestamp:1001},{role:"assistant",content:[{type:"text",text:"first complete"}],stopReason:"stop",timestamp:1002}];
	const expanded:Any[]=[...initial];
	for(let i=0;i<100;i++) {
		const name=i%2?"read":"bash",args=name==="read"?{path:`src/long-path-${i}-${"path".repeat(35)}.ts`}:{command:`verify-step-${i} ${"argument ".repeat(25)}`};
		expanded.push({role:"assistant",content:[{type:"toolCall",id:`expand-${i}`,name,arguments:args}],stopReason:"toolUse",timestamp:1100+i*2},
			{role:"toolResult",toolCallId:`expand-${i}`,toolName:name,isError:true,content:[{type:"text",text:`error-${i}: ${"public diagnostic ".repeat(20)}`}],timestamp:1101+i*2});
	}
	const plan=(messages:Any[])=>{
		const blocks=[...buildBlocks([summary]),...summaryBlocks([...messages,{role:"user",content:"kept suffix",timestamp:2000}])];
		return {blocks,calls:toolCallIndex(blocks),cutIdx:blocks.length-1,prefixTokens:50000,summaryTokensPlanned:4000} as Any;
	};
	const lane={sessionId:"fixed-epoch-lane",cacheRetention:"short" as const};
	const small=await buildCut(plan(initial),r.ctx,undefined,lane),large=await buildCut(plan(expanded),r.ctx,undefined,lane);
	expect(small.llmOk).toBe(true);expect(large.llmOk).toBe(true);
	expect(large.text.length).toBeGreaterThan(small.text.length+5000);
	const [before,after]=r.calls;
	expect(digest(after.context.messages[0])).toBe(digest(before.context.messages[0]));
	expect(after.context.messages.slice(0,before.context.messages.length)).toEqual(before.context.messages);
	const prevText=(c:Any)=>/<previous-narrative[^>]*>\n([\s\S]*?)\n<\/previous-narrative>/.exec(c.messages[0].content[0].text)![1];
	expect(prevText(before.context)).toContain("HEAD-FACT");expect(prevText(before.context)).toContain("TAIL-FACT");
	const stripped=(p:Any)=>JSON.parse(JSON.stringify(p,(key,value)=>key==="cache_control"?undefined:value));
	expect(stripped(after.payload).messages.slice(0,before.payload.messages.length)).toEqual(stripped(before.payload).messages);
	// Early mode keeps the existing skeleton-dependent allowance.
	await buildCut(plan(initial),r.ctx);await buildCut(plan(expanded),r.ctx);
	expect(prevText(r.calls[2].context).length).toBeGreaterThan(prevText(r.calls[3].context).length);
	expect(r.fetches()).toBe(0);
});
