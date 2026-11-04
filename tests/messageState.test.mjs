import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const source=await readFile(new URL('../src/lib/messageState.ts',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from((await transform(source,{loader:'ts',format:'esm'})).code).toString('base64'));
const {emptyMessageState,announcementUnread,replyUnread,markAnnouncementRead,markReplyRead,readMessageState,saveMessageState,BUILTIN_GUIDE}=api;
test('announcement read state is revision-specific and cannot move backwards',()=>{
 let state=emptyMessageState();assert.equal(announcementUnread(BUILTIN_GUIDE,state),true);
 state=markAnnouncementRead(state,BUILTIN_GUIDE);assert.equal(announcementUnread(BUILTIN_GUIDE,state),false);
 const changed={...BUILTIN_GUIDE,revision:2};assert.equal(announcementUnread(changed,state),true);
 state=markAnnouncementRead(state,changed);state=markAnnouncementRead(state,BUILTIN_GUIDE);
 assert.equal(announcementUnread(changed,state),false);
});
test('reply read state follows the actual opened reply rather than polling or wall-clock time',()=>{
 let state=emptyMessageState();const item={id:'feedback-a',last_replied_at:'2026-11-04T10:00:00+00:00'};
 assert.equal(replyUnread(item,state),true);
 state=markReplyRead(state,item.id,'2026-11-04T10:00:00Z');assert.equal(replyUnread(item,state),false);
 const next={...item,last_replied_at:'2026-11-04T10:01:00Z'};assert.equal(replyUnread(next,state),true);
 state=markReplyRead(state,item.id,'2026-11-04T09:00:00Z');assert.equal(replyUnread(next,state),true);
 assert.equal(replyUnread({id:'new',last_replied_at:null},state),false);
});
test('read state survives restart and handles malformed or unavailable storage',()=>{
 const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
 const state=markAnnouncementRead(emptyMessageState(),BUILTIN_GUIDE);saveMessageState(state,storage);
 assert.deepEqual(readMessageState(storage),state);assert.equal(announcementUnread(BUILTIN_GUIDE,readMessageState(storage)),false);
 for(const key of values.keys())values.set(key,'broken-json');assert.deepEqual(readMessageState(storage),emptyMessageState());
 const unavailable={getItem(){throw Error('disabled')},setItem(){throw Error('disabled')}};
 assert.deepEqual(readMessageState(unavailable),emptyMessageState());assert.doesNotThrow(()=>saveMessageState(state,unavailable));
});
