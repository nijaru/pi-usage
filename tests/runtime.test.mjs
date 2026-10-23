import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerUsage } from '../extensions/runtime.ts';
import { DEFAULT_USAGE_URL } from '../extensions/usage.ts';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeoutMs=2500){
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>=deadline)return false;
    await sleep(10);
  }
  return true;
}
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
  await f.hooks.get('session_start')({},f.ctx);await tick();
  assert.equal(f.statuses.at(-1),'· deepseek $12.00'); assert.equal(calls,1);
  await f.hooks.get('agent_settled')({},f.ctx);assert.equal(calls,1);
});
test('successful Codex display remains byte-for-byte unchanged',async t=>{
  const f=fixture(t,[codex]);globalThis.fetch=async()=>Response.json({rate_limit:{primary_window:{used_percent:18,limit_window_seconds:18000},secondary_window:{used_percent:36,limit_window_seconds:604800}}});
  await f.commands.get('usage').handler('',f.ctx);
  assert.equal(f.statuses.at(-1),'· 5h 82% · wk 64%');assert.equal(f.notifications.at(-1),'Codex usage: 5h 82% · wk 64%');
});
for (const scenario of [
  { name: 'an explicitly deleted header never revives from the JWT', headers: { 'chatgpt-account-id': null }, dispatched: null },
  { name: 'an explicit header override wins case-insensitively over the JWT', headers: { 'ChatGPT-Account-Id': 'acct-direct' }, dispatched: 'acct-direct' },
  { name: 'an absent header falls back to the JWT account id', headers: undefined, dispatched: 'acct-jwt' },
]) test(`codex account id: ${scenario.name}`, async t => {
  const f = fixture(t, [codex]);
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: true,
    apiKey: token('acct-jwt'),
    ...(scenario.headers ? { headers: scenario.headers } : {}),
  });
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers['ChatGPT-Account-Id']);
    return Response.json({ rate_limit: { primary_window: { used_percent: 18, limit_window_seconds: 18000 } } });
  };
  await f.commands.get('usage').handler('', f.ctx);
  if (scenario.dispatched === null) {
    assert.equal(sent.length, 0, 'a deleted account must not dispatch a usage request');
    assert.match(f.notifications.at(-1), /Codex account unavailable/);
  } else {
    assert.deepEqual(sent, [scenario.dispatched]);
  }
});

test('account swap cannot publish an old in-flight balance',async t=>{
  const f=fixture(t);let release;globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  await f.hooks.get('session_start')({},f.ctx);await tick();f.key('key-b');release(balance('99.00'));await tick();await tick();
  assert.equal(f.statuses.at(-1),undefined);assert.equal(f.statuses.some(x=>x?.includes('99.00')),false);
});
for (const event of ['model_select', 'session_shutdown']) test(`a late request completion cannot publish after ${event}`, async t => {
  const f = fixture(t);
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  await f.hooks.get('session_start')({}, f.ctx); await tick();
  if (event === 'model_select') f.ctx.model = { provider: 'other', id: 'x', baseUrl: 'https://other.test' };
  await f.hooks.get(event)({}, f.ctx);
  release(balance('99.00')); await tick();
  assert.equal(f.statuses.some(x => x?.includes('99')), false, 'the completed request must not republish');
  assert.equal(f.statuses.at(-1), undefined);
});
for (const event of ['session_shutdown', 'model_select']) test(`a late credential lookup cannot start a request after ${event}`, async t => {
  const f = fixture(t);
  let release;
  let authCalls = 0;
  let requests = 0;
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    if (++authCalls === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, apiKey: 'key-a' };
  };
  globalThis.fetch = async () => { requests++; return balance(); };
  await f.hooks.get('session_start')({}, f.ctx);
  await tick();
  if (event === 'model_select') f.ctx.model = { provider: 'other', id: 'x', baseUrl: 'https://other.test' };
  await f.hooks.get(event)({}, f.ctx);
  release();
  await tick();
  await tick();
  assert.equal(requests, 0);
  assert.equal(f.statuses.some(Boolean), false);
});

test('a retired query cannot delete a newer same-account balance', async t => {
  const f = fixture(t);
  t.mock.timers.enable({apis:['setTimeout', 'Date'], now:Date.now()});
  const drain = () => new Promise(resolve => setImmediate(resolve));
  let release, lookups = 0, requests = 0;
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    if (++lookups === 2) await new Promise(resolve => { release = resolve; });
    return {ok:true,apiKey:'key-a'};
  };
  globalThis.fetch = async () => ++requests <= 2 ? balance(requests === 1 ? '12.00' : '99.00') : new Response('', {status:503});
  await f.hooks.get('session_start')({}, f.ctx); await drain();
  assert.equal(typeof release, 'function');
  await f.hooks.get('model_select')({}, f.ctx); await drain();
  assert.match(f.statuses.at(-1), /99\.00/);
  release(); await drain();
  t.mock.timers.tick(6000);
  f.hooks.get('agent_settled')({}, f.ctx); await drain();
  assert.equal(requests, 2);
  assert.match(f.statuses.at(-1), /99\.00/);
});

test('a retired timer cannot replace the new model polling loop', async t => {
  const f = fixture(t, [deepseek, codex]);
  t.mock.timers.enable({apis:['setTimeout', 'Date'], now:Date.now()});
  const drain = () => new Promise(resolve => setImmediate(resolve));
  let release, lookups = 0;
  const requests = [];
  f.ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    if (model.provider === 'deepseek' && ++lookups === 3) await new Promise(resolve => { release = resolve; });
    return {ok:true,apiKey:model.provider === 'openai-codex' ? token('key-b') : 'key-a'};
  };
  globalThis.fetch = async url => {
    requests.push(String(url));
    return String(url).includes('deepseek') ? balance() : Response.json({rate_limit:{primary_window:{used_percent:10,limit_window_seconds:18000}}});
  };
  await f.hooks.get('session_start')({}, f.ctx); await drain();
  t.mock.timers.tick(60000); await drain();
  assert.equal(typeof release, 'function');
  const next = {...f.ctx, model:codex};
  await f.hooks.get('model_select')({}, next); await drain();
  const switched = requests.length;
  release(); await drain();
  t.mock.timers.tick(60000); await drain();
  assert.equal(requests.length, switched + 1);
  assert.match(requests.at(-1), /chatgpt/);
});

test('errors do not become a zero balance or leak server response bodies',async t=>{
  const f=fixture(t);globalThis.fetch=async()=>new Response('SECRET-RESPONSE',{status:403});
  await f.commands.get('usage').handler('',f.ctx);
  assert.match(f.notifications.at(-1),/403/);assert.doesNotMatch(f.notifications.at(-1),/SECRET|\$0/);
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
  const reports = f.notifications.join('\n');
  assert.equal(peak,2);assert.match(reports,/deepseek \$12/);assert.match(reports,/vercel-ai-gateway \$4/);
  assert.equal(f.notifications.length, models.length, 'publish each report once without holding an aggregate');
  assert.equal(f.statuses.at(-1),'· deepseek $12.00');
});
for (const change of ['key', 'dropped auth', 'auth endpoint', 'model endpoint', 'official auth endpoint', 'official model endpoint', 'management key', 'dropped management key']) {
  test(`/usage all clears the old footer without republishing after ${change} changes`, async t => {
    const management = change.includes('management');
    const fast = management ? {provider:'openrouter',id:'x',baseUrl:'https://openrouter.ai/api/v1'} : {...deepseek};
    const slow = {provider:'vercel-ai-gateway',id:'x',baseUrl:'https://ai-gateway.vercel.sh/v1'};
    const models = [fast, slow], f = fixture(t, models);
    let auth = {ok:true,apiKey:'key-a'}, release, calls = 0;
    f.ctx.modelRegistry.getApiKeyAndHeaders = async model => model.provider === fast.provider ? auth : {ok:true,apiKey:'slow-key'};
    if (management) {
      const names = ['PI_USAGE_TEST_INFERENCE', 'PI_USAGE_TEST_MANAGEMENT'];
      const previous = names.map(name => process.env[name]);
      t.after(() => names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
      }));
      process.env[names[0]] = 'key-a'; process.env[names[1]] = 'management-a';
      f.config({openrouterCredits:{inferenceKeyEnv:names[0],managementKeyEnv:names[1]}});
    }
    globalThis.fetch = async url => {
      calls++;
      if (String(url).includes('vercel')) return new Promise(resolve => { release = resolve; });
      if (String(url).endsWith('/credits')) return Response.json({data:{total_credits:100,total_usage:1}});
      return management ? Response.json({data:{limit:null,usage:3}}) : balance('99.00');
    };
    const pending = f.commands.get('usage').handler('all', f.ctx);
    assert.equal(await waitFor(() => release && f.statuses.at(-1)?.includes('$99')), true);
    const published = f.notifications.length;
    switch (change) {
      case 'key': auth = {ok:true,apiKey:'key-b'}; break;
      case 'dropped auth': auth = {ok:false}; break;
      case 'auth endpoint': auth = {...auth,baseUrl:'https://proxy.example'}; break;
      case 'model endpoint': models[0] = f.ctx.model = {...fast,baseUrl:'https://proxy.example'}; break;
      case 'official auth endpoint': auth = {...auth,baseUrl:'https://api.deepseek.com/v1'}; break;
      case 'official model endpoint': models[0] = f.ctx.model = {...fast,baseUrl:'https://api.deepseek.com/v1'}; break;
      case 'management key': process.env.PI_USAGE_TEST_MANAGEMENT = 'management-b'; break;
      case 'dropped management key': delete process.env.PI_USAGE_TEST_MANAGEMENT; break;
    }
    release(Response.json({balance:'4.00'}));
    await pending;
    assert.doesNotMatch(f.notifications.slice(published).join('\n'), /\$99/);
    assert.match(f.notifications.join('\n'), /vercel-ai-gateway \$4/);
    assert.equal(f.statuses.at(-1), undefined);
    assert.equal(calls, management ? 3 : 2, 'revalidation must not repeat provider requests');
  });
}

test('/usage all does not republish an earlier account while another final auth lookup waits', async t => {
  const models = [{...deepseek}, {provider:'vercel-ai-gateway',id:'x',baseUrl:'https://ai-gateway.vercel.sh/v1'}];
  const f = fixture(t, models), lookups = new Map();
  let key = 'key-a', release;
  f.ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    const count = (lookups.get(model.provider) ?? 0) + 1;
    lookups.set(model.provider, count);
    if (model.provider === 'vercel-ai-gateway' && count === 3) await new Promise(resolve => { release = resolve; });
    return {ok:true,apiKey:model.provider === 'deepseek' ? key : 'other-key'};
  };
  globalThis.fetch = async url => String(url).includes('deepseek') ? balance('99.00') : Response.json({balance:'4.00'});
  const pending = f.commands.get('usage').handler('all', f.ctx);
  assert.equal(await waitFor(() => release), true);
  await tick();
  const published = f.notifications.length;
  key = 'key-b'; release(); await pending;
  assert.doesNotMatch(f.notifications.slice(published).join('\n'), /\$99/);
  assert.match(f.notifications.join('\n'), /vercel-ai-gateway \$4/);
  assert.equal(f.statuses.at(-1), undefined);
});

test('/usage all reads management binding after a stalled final auth lookup', async t => {
  const models = [{provider:'openrouter',id:'x',baseUrl:'https://openrouter.ai/api/v1'}, {...deepseek}];
  const f = fixture(t, models);
  const names = ['PI_USAGE_REVIEW_INFERENCE', 'PI_USAGE_REVIEW_MANAGEMENT'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name,index) => {
    if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
  }));
  process.env[names[0]] = 'key-a'; process.env[names[1]] = 'management-a';
  f.config({openrouterCredits:{inferenceKeyEnv:names[0],managementKeyEnv:names[1]}});
  let count = 0, release;
  f.ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    if (model.provider === 'openrouter' && ++count === 3) await new Promise(resolve => { release = resolve; });
    return {ok:true,apiKey:'key-a'};
  };
  globalThis.fetch = async url => String(url).includes('deepseek') ? balance('4.00')
    : String(url).endsWith('/credits') ? Response.json({data:{total_credits:100,total_usage:1}})
    : Response.json({data:{limit:null,usage:3}});
  const pending = f.commands.get('usage').handler('all', f.ctx);
  assert.equal(await waitFor(() => release), true);
  f.config({openrouterCredits:undefined});
  release(); await pending;
  assert.doesNotMatch(f.notifications.join('\n'), /\$99/);
  assert.match(f.notifications.join('\n'), /deepseek \$4/);
  assert.equal(f.statuses.at(-1), undefined);
});

test('/usage all isolates provider errors from successful reports', async t => {
  const f = fixture(t, [deepseek, {provider:'openrouter',id:'x',baseUrl:'https://openrouter.ai/api/v1'}]);
  globalThis.fetch = async url => String(url).includes('deepseek') ? balance() : new Response('SECRET', {status:503});
  await f.commands.get('usage').handler('all', f.ctx);
  const reports = f.notifications.join('\n');
  assert.match(reports, /deepseek \$12.00/);
  assert.match(reports, /openrouter:.*503/);
  assert.doesNotMatch(reports, /SECRET/);
  assert.equal(f.statuses.at(-1), '· deepseek $12.00');
});

test('a configured proxy cannot send its credential to an official billing endpoint',async t=>{
  const f=fixture(t,[{...deepseek,baseUrl:'https://proxy.example'}]);let calls=0;globalThis.fetch=async()=>{calls++;return balance();};
  await f.commands.get('usage').handler('',f.ctx);assert.equal(calls,0);assert.match(f.notifications.at(-1),/official endpoint/);
});

test('timer refreshes between turns and stops after shutdown', async t => {
  const f=fixture(t);f.config({pollIntervalMs:1000});let calls=0;
  globalThis.fetch=async()=>{calls++;return balance();};
  await f.hooks.get('session_start')({},f.ctx);await tick();assert.equal(calls,1);
  assert.equal(await waitFor(()=>calls>=2),true);
  await f.hooks.get('session_shutdown')({},f.ctx);const finished=calls;
  await f.hooks.get('agent_settled')({}, {...f.ctx,hasUI:false});assert.equal(calls,finished);
});

test('transient failure marks an existing value stale rather than presenting a fresh balance', async t => {
  const f=fixture(t);f.config({pollIntervalMs:10});let fail=false;
  globalThis.fetch=async()=>fail?new Response('error',{status:503}):balance();
  await f.hooks.get('session_start')({},f.ctx);await tick();fail=true;
  await f.hooks.get('agent_settled')({},f.ctx);
  assert.equal(await waitFor(()=>(f.statuses.at(-1)??'').includes('stale · deepseek $12.00'),250),true);
});

test('enabling usage at runtime starts polling without a model event',async t=>{
  const f=fixture(t);f.config({enabled:false});let calls=0;
  globalThis.fetch=async()=>{calls++;return balance();};
  await f.hooks.get('session_start')({},f.ctx);assert.equal(calls,0);
  f.config({enabled:true});
  await f.hooks.get('agent_settled')({},f.ctx);await tick();
  assert.equal(calls,1);
});

test('a stalled auth resolver is bounded instead of hanging the handler',async t=>{
  const f=fixture(t);f.config({requestTimeoutMs:40});
  f.ctx.modelRegistry.getApiKeyAndHeaders=()=>new Promise(()=>{});
  await f.hooks.get('session_start')({},f.ctx);
  const settled=await waitFor(()=>f.statuses.some(x=>x?.includes('usage unavailable')),2000);
  assert.equal(settled,true,'expected a bounded auth failure, not a hang');
});
