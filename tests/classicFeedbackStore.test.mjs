import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStore,COLLECTIONS}=require('../cloudbase/feedback-classic/store.cjs');

function fakeDb(arraySnapshot=false) {
  const rows=new Map(); let rollback=0,commit=0,fail=false;
  const key=ref=>`${ref.collection}:${ref.id}`;
  const db={command:{neq:value=>({neq:value})},collection(name){return {doc:id=>({collection:name,id, get:async()=>({data:rows.has(`${name}:${id}`)?[rows.get(`${name}:${id}`)]:[]}), set:async data=>rows.set(`${name}:${id}`,data), update:async patch=>rows.set(`${name}:${id}`,{...rows.get(`${name}:${id}`),...patch})}),add:async row=>rows.set(`${name}:${row._id}`,row)};},async startTransaction(){const staged=new Map(rows);return {get:async ref=>({data:arraySnapshot?(staged.has(key(ref))?[staged.get(key(ref))]:[]):()=>staged.get(key(ref))}),set:async(ref,row)=>staged.set(key(ref),row),update:async(ref,patch)=>{if(fail)throw Error('write failed');staged.set(key(ref),{...staged.get(key(ref)),...patch});},commit:async()=>{commit++;rows.clear();for(const [k,v] of staged)rows.set(k,v);},rollback:async()=>{rollback++;}};}};
  return {db,rows,stats:()=>({commit,rollback}),fail:()=>{fail=true;}};
}
test('reply transaction commits both documents and rolls back on failure',async()=>{
 const f=fakeDb(),store=createStore(f.db);f.rows.set(`${COLLECTIONS.feedback}:a`,{id:'a',status:'open',deleted_at:null});
 await store.reply('a',{id:'r',content:'reply'},{status:'resolved',status_changed_at:'now'});
 assert.equal(f.rows.get(`${COLLECTIONS.feedback}:a`).status,'resolved');assert.equal(f.rows.get(`${COLLECTIONS.replies}:r`).content,'reply');
 f.fail();await assert.rejects(()=>store.reply('a',{id:'r2',content:'x'},{status:'open'}));assert.equal(f.rows.has(`${COLLECTIONS.replies}:r2`),false);assert.deepEqual(f.stats(),{commit:1,rollback:1});
});
test('accepts transaction data returned as an array by CloudBase runtime',async()=>{
 const f=fakeDb(true),store=createStore(f.db);f.rows.set(`${COLLECTIONS.feedback}:a`,{id:'a',status:'open',deleted_at:null});
 await store.update('a',{status:'resolved',updated_at:'now'});
 assert.equal(f.rows.get(`${COLLECTIONS.feedback}:a`).status,'resolved');assert.equal(f.rows.get(`${COLLECTIONS.feedback}:a`).status_changed_at,'now');
});
test('supports the deployed CloudBase transaction.collection interface',async()=>{
 const f=fakeDb(true),start=f.db.startTransaction;
 f.db.startTransaction=async()=>{const tx=await start();return {collection:name=>({doc:id=>({get:()=>tx.get({collection:name,id}),set:value=>tx.set({collection:name,id},value),update:value=>tx.update({collection:name,id},value)})}),commit:tx.commit,rollback:tx.rollback};};
 const store=createStore(f.db);f.rows.set(`${COLLECTIONS.feedback}:a`,{id:'a',status:'open',deleted_at:null});
 await store.reply('a',{id:'r',content:'reply'},{status:'resolved',updated_at:'now'});
 assert.equal(f.rows.get(`${COLLECTIONS.feedback}:a`).status,'resolved');assert.equal(f.rows.get(`${COLLECTIONS.replies}:r`).content,'reply');
});
test('announcement publishing increments revision in a committed transaction',async()=>{
 const f=fakeDb(),store=createStore(f.db);f.rows.set(`${COLLECTIONS.drafts}:d`,{id:'d',title:'标题',body:'正文'});
 assert.equal((await store.publish('d','today')).revision,1);assert.equal((await store.publish('d','tomorrow')).revision,2);assert.deepEqual(f.stats(),{commit:2,rollback:0});
});
