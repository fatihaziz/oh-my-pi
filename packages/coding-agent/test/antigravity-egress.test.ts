import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { getBundledModel } from '@oh-my-pi/pi-catalog/models';
import { streamOpenAICompletions } from '../../ai/src/providers/openai-completions';
import { TempDir } from '@oh-my-pi/pi-utils';
import { ModelRegistry } from '../src/config/model-registry';
import { Settings } from '../src/config/settings';
import { AuthStorage } from '../src/session/auth-storage';
import { runAgyWorker } from '../src/task/agy-acp';

test('disabled native Antigravity cannot resolve a credential or launch its ACP worker', async()=>{
 const dir=TempDir.createSync('disabled-acp-');const auth=await AuthStorage.create(join(dir.path(),'auth.db'));
 try {
  const settings=Settings.isolated({disabledProviders:['google-antigravity','antigravity-cli'],'task.disabledAgents':['agy-acp']});
  let sends=0; const registry=new ModelRegistry(auth,join(dir.path(),'models.yml'),{settings, fetch:async()=>{sends++;throw Error('network forbidden')}});
  const real=getBundledModel('openai','gpt-4o-mini')!;
  for(const provider of ['google-antigravity','antigravity-cli']){auth.keys.setRuntime(provider,'fixture');expect(await registry.getApiKey({...real,provider})).toBeUndefined();expect(registry.find(provider,real.id)).toBeUndefined();}
  await expect(runAgyWorker({settings,cwd:dir.path(),agent:{name:'agy-acp',description:'test',systemPrompt:'private parent sentinel',source:'bundled'},task:'brief',index:0,id:'test',assertSpawnAuthorization:()=>{throw Error('should not reach grant')}})).rejects.toThrow('dispatch is disabled');expect(sends).toBe(0);
 }finally{auth.close();dir.removeSync();}
});
test('a per-spawn ACP grant cannot select a different family or exceed the effort ceiling', async()=>{
 const settings=Settings.isolated({'task.perCallModel':'on','task.maxEffort':'high'});
 for(const [selector,error] of [['agy-acp/claude-opus-5-5:high','Argon'],['agy-acp/gemini-4-neon:xhigh','ceiling']]) {
  await expect(runAgyWorker({settings,cwd:'.',index:0,id:'policy',task:'policy',modelOverride:[selector],
   agent:{name:'agy-acp',description:'test',systemPrompt:'',source:'bundled'},
   perCallModelGrants:{settings,agentName:'agy-acp',agentSource:'bundled',standaloneSelector:selector,
    standaloneInvocationKind:'task',automaticSelection:true,assertAuthorization:()=>{}}})).rejects.toThrow(error);
 }
});
for(const wire of ['ag/fixture','antigravity/fixture','cc/fixture'])test(`wire-level 9Router dispatch: ${wire}`,async()=>{
 const base=getBundledModel<'openai-completions'>('openai','gpt-4o-mini');
 const model={...base,id:'display-alias',requestModelId:wire,api:'openai-completions' as const,provider:'9router',baseUrl:'https://router.invalid/v1',headers:{'X-9Router-Exclude-Provider':'antigravity'}};
 const guards:(string|null)[]=[];
 const result=await streamOpenAICompletions(model,{messages:[{role:'user',content:'Only this brief',timestamp:1}]},{apiKey:'fixture',maxHttpAttempts:3,fetch:async(_input,init)=>{guards.push(new Headers(init?.headers).get('x-9router-exclude-provider'));return new Response('denied',{status:403})}}).result();
 if(wire.startsWith('cc/'))expect(guards).toEqual(['antigravity']);else{expect(guards).toEqual([]);expect(result.errorMessage).toContain('excluded by client policy');}
});
