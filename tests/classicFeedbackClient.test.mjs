import test from 'node:test';
import assert from 'node:assert/strict';
import {transform} from 'esbuild';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/lib/classicFeedback.ts',import.meta.url),'utf8');
const compiled=await transform(source,{loader:'ts',format:'esm'});
const {createClassicFeedback}=await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
test('classic client calls only the dedicated function and rejects server errors',async()=>{
 const calls=[];const api=createClassicFeedback({callFunction:async input=>{calls.push(input);return {result:{ok:true,data:[{id:'one',last_replied_at:null,status:'open',status_changed_at:null}]}};}});
 assert.equal((await api.replyStatus())[0].id,'one');
 assert.deepEqual(calls[0],{name:'lijin_feedback_v1',data:{action:'list'},parse:true});
 const failed=createClassicFeedback({callFunction:async()=>({result:{ok:false,error:'拒绝'}})});
 await assert.rejects(()=>failed.list(),/拒绝/);
});
