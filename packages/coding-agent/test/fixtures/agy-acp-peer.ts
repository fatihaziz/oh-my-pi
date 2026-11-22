import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
writeFileSync('peer.json', JSON.stringify({pid:process.pid,keys:Object.keys(process.env)}));
const reply = (data: unknown) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...Object(data)})+'\n');
const configs = ['model','thought_level'].map((id,i) => ({id,type:'select',currentValue:i?'high':'other',options:[{value:i?'high':'fixture'}]}));
let turn: number | undefined;
for await (const line of createInterface({input:process.stdin})) {
 const m = JSON.parse(line); appendFileSync('frames.jsonl',line+'\n');
 switch(m.method) {
 case 'initialize': reply({id:m.id,result:{protocolVersion:1}});break;
 case 'session/new': reply({id:m.id,result:{sessionId:'peer',configOptions:configs,modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}}});break;
 case 'session/set_config_option': if(scenario !== 'mismatch') configs[0].currentValue='fixture';reply({id:m.id,result:{configOptions:configs}});break;
 case 'session/prompt': turn=m.id; writeFileSync('unfinished.txt','local edit');
  if(scenario==='question') reply({id:'ask',method:'elicitation/create',params:{sessionId:'peer',mode:'form',message:'Choose a name',requestedSchema:{type:'object',properties:{name:{type:'string'}}}}});
  else reply({id:'perm',method:'session/request_permission',params:{sessionId:'peer',toolCall:{toolCallId:'call',title:'Write'},options:[{optionId:'deny-17',kind:'reject_once',name:'Deny'},{optionId:'yes',kind:'allow_once',name:'Allow'}]}});break;
 default: if(m.id==='perm') reply({id:turn,result:{stopReason:m.result.outcome.optionId==='deny-17'?'refusal':'end_turn'}});
 }
}
