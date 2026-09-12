import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerUsage } from '../extensions/runtime.ts';
import { DEFAULT_USAGE_URL } from '../extensions/usage.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const token=account=>`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:account}})).toString('base64url')}.signature`;
const deepseek={provider:'deepseek',id:'flash',baseUrl:'https://api.deepseek.com'};
const codex={provider:'openai-codex',id:'gpt',baseUrl:'https://chatgpt.com/backend-api/codex'};
function fixture(t, models=[deepseek]) {
  const hooks=new Map(),commands=new Map(),statuses=[],notifications=[];
  let key='key-a';
  const ctx={model:models[0],hasUI:true,cwd:'/tmp',isProjectTrusted:()=>true,ui:{setStatus:(_key,value)=>statuses.push(value),notify:(value)=>notifications.push(value)},modelRegistry:{getAvailable:()=>models,getApiKeyAndHeaders:async(model)=>({ok:true,apiKey:model.provider==='openai-codex'?token(key):key})}};
  const pi={on:(key,callback)=>hooks.set(key,callback),registerCommand:(key,command)=>commands.set(key,command)};
  let config={enabled:true,pollIntervalMs:60000,requestTimeoutMs:10000,usageUrl:DEFAULT_USAGE_URL};
  registerUsage(pi,()=>config);
  const old=globalThis.fetch;
  t.after(async()=>{await hooks.get('session_shutdown')({},ctx);globalThis.fetch=old;});
  return {ctx,hooks,commands,statuses,notifications,key:value=>{key=value;},config:value=>{config={...config,...value};}};
}
const balance=(value='12.00')=>Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:value}]});

test('active DeepSeek balance appears without changing inference requests',async t=>{
  const f=fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;return balance();};
  assert.deepEqual([...f.commands.keys()],['usage']);
  assert.equal(f.hooks.has('before_provider_request'),false);
  await f.hooks.get('session_start')({},f.ctx);await tick();
  assert.equal(f.statuses.at(-1),'deepseek USD 12.00'); assert.equal(calls,1);
  await f.hooks.get('agent_settled')({},f.ctx);assert.equal(calls,1);
});
test('successful Codex display remains byte-for-byte unchanged',async t=>{
  const f=fixture(t,[codex]);globalThis.fetch=async()=>Response.json({rate_limit:{primary_window:{used_percent:18,limit_window_seconds:18000},secondary_window:{used_percent:36,limit_window_seconds:604800}}});
  await f.commands.get('usage').handler('',f.ctx);
  assert.equal(f.statuses.at(-1),'5h 82% · wk 64%');assert.equal(f.notifications.at(-1),'Codex usage: 5h 82% · wk 64%');
});
test('account swap cannot publish an old in-flight balance',async t=>{
  const f=fixture(t);let release;globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  await f.hooks.get('session_start')({},f.ctx);await tick();f.key('key-b');release(balance('99.00'));await tick();await tick();
  assert.equal(f.statuses.at(-1),undefined);assert.equal(f.statuses.some(x=>x?.includes('99.00')),false);
});
test('model switch and shutdown reject stale request completion',async t=>{
  const f=fixture(t);let release;globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  await f.hooks.get('session_start')({},f.ctx);await tick();f.ctx.model={provider:'other',id:'x',baseUrl:'https://other.test'};await f.hooks.get('model_select')({},f.ctx);release(balance('99.00'));await tick();
  assert.equal(f.statuses.at(-1),undefined);
});
test('errors do not become a zero balance or leak server response bodies',async t=>{
  const f=fixture(t);globalThis.fetch=async()=>new Response('SECRET-RESPONSE',{status:403});
  await f.commands.get('usage').handler('',f.ctx);
  assert.match(f.notifications.at(-1),/403/);assert.doesNotMatch(f.notifications.at(-1),/SECRET|USD 0/);
});
test('disabled/headless sessions do not poll',async t=>{
  const f=fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;return balance();};
  f.config({enabled:false});await f.hooks.get('session_start')({},f.ctx);await tick();assert.equal(calls,0);
  f.config({enabled:true});f.ctx.hasUI=false;await f.hooks.get('session_start')({},f.ctx);await tick();assert.equal(calls,0);
});
test('/usage all is explicit and limits concurrent provider queries to two',async t=>{
  const models=[deepseek,{provider:'openrouter',id:'x',baseUrl:'https://openrouter.ai/api/v1'},{provider:'vercel-ai-gateway',id:'x',baseUrl:'https://ai-gateway.vercel.sh/v1'}];
  const f=fixture(t,models);let active=0,peak=0;
  globalThis.fetch=async url=>{active++;peak=Math.max(peak,active);await tick();active--;return String(url).includes('deepseek')?balance():String(url).includes('openrouter')?Response.json({data:{limit:null,usage:3}}):Response.json({balance:'4.00'});};
  await f.commands.get('usage').handler('all',f.ctx);
  assert.equal(peak,2);assert.match(f.notifications.at(-1),/deepseek USD 12/);assert.match(f.notifications.at(-1),/vercel-ai-gateway USD 4/);
  assert.equal(f.statuses.at(-1),'deepseek USD 12.00');
});
test('a configured proxy cannot send its credential to an official billing endpoint',async t=>{
  const f=fixture(t,[{...deepseek,baseUrl:'https://proxy.example'}]);let calls=0;globalThis.fetch=async()=>{calls++;return balance();};
  await f.commands.get('usage').handler('',f.ctx);assert.equal(calls,0);assert.match(f.notifications.at(-1),/official endpoint/);
});

test('timer refreshes between turns and stops after shutdown', async t => {
  const f=fixture(t);f.config({pollIntervalMs:1000});let calls=0;
  globalThis.fetch=async()=>{calls++;return balance();};
  await f.hooks.get('session_start')({},f.ctx);await tick();assert.equal(calls,1);
  await new Promise(resolve=>setTimeout(resolve,1100));assert.ok(calls>=2);
  await f.hooks.get('session_shutdown')({},f.ctx);const finished=calls;
  await f.hooks.get('agent_settled')({}, {...f.ctx,hasUI:false});assert.equal(calls,finished);
});

test('transient failure marks an existing value stale rather than presenting a fresh balance', async t => {
  const f=fixture(t);f.config({pollIntervalMs:1});let fail=false;
  globalThis.fetch=async()=>fail?new Response('error',{status:503}):balance();
  await f.hooks.get('session_start')({},f.ctx);await tick();fail=true;
  await f.hooks.get('agent_settled')({},f.ctx);await tick();
  assert.match(f.statuses.at(-1),/12.00 · stale$/);
});
