import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseAcp } from '../src/task/agy-acp';
for (const scenario of ['deny','mismatch','question','excluded']) test(`ACP worker: ${scenario}`, async () => {
 const cwd=mkdtempSync(join(tmpdir(),'acp-peer-')), controller=new AbortController();
 const prior=process.env.PARENT_ONLY_ACP_TEST; process.env.PARENT_ONLY_ACP_TEST='private-parent-value';
 try {
  const run=superviseAcp([process.execPath,'--no-env-file',join(import.meta.dir,'fixtures','agy-acp-peer.ts'),scenario],
   {cwd,brief:'Only this assignment',model:'fixture',effort:'high',mode:'default',signal:controller.signal}, {
   requestPermission:()=>({outcome:{outcome:'selected',optionId:'deny-17'}}), sessionUpdate(){},
   async unstable_createElicitation(){controller.abort();return {action:'cancel'};},
  },()=>{if(scenario==='excluded')throw new Error('excluded');});
  if(scenario==='deny') expect((await run).stopReason).toBe('refusal');
  else await expect(run).rejects.toThrow(scenario==='mismatch'?'acknowledge':scenario==='excluded'?'excluded':undefined);
  if(scenario==='excluded'){expect(existsSync(join(cwd,'peer.json'))).toBe(false);return;}
  const peer=JSON.parse(readFileSync(join(cwd,'peer.json'),'utf8'));
  expect(peer.keys).not.toContain('PARENT_ONLY_ACP_TEST'); expect(()=>process.kill(peer.pid,0)).toThrow();
  const frames=readFileSync(join(cwd,'frames.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  expect(frames.find(f=>f.method==='initialize').params).toEqual({protocolVersion:1,clientCapabilities:{elicitation:{form:{}}}});
  expect(frames.find(f=>f.method==='session/new').params).toEqual({cwd,mcpServers:[]});
  const prompts=frames.filter(f=>f.method==='session/prompt');
  if(scenario==='mismatch')expect(prompts).toEqual([]);
  else { expect(prompts.map(f=>f.params)).toEqual([{sessionId:'peer',prompt:[{type:'text',text:'Only this assignment'}]}]);expect(readFileSync(join(cwd,'unfinished.txt'),'utf8')).toBe('local edit'); }
  if(scenario==='question')expect(frames.some(f=>f.method==='session/cancel')).toBe(true);
 } finally {if(prior===undefined)delete process.env.PARENT_ONLY_ACP_TEST;else process.env.PARENT_ONLY_ACP_TEST=prior;rmSync(cwd,{recursive:true,force:true});}
});
