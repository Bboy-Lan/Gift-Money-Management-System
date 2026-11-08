import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFeedbackService } = require('../cloudbase/feedback-classic/service.cjs');

function setup() {
  const rows = new Map(); const replies = new Map(); const drafts = new Map(); const announcements = new Map();
  const store = {
    isAdmin: async uid => uid === 'administrator',
    create: async row => { rows.set(row.id, row); },
    get: async id => rows.get(id),
    list: async () => [...rows.values()],
    update: async (id, patch) => { rows.set(id, {...rows.get(id), ...patch}); },
    replies: async id => replies.get(id) || [],
    reply: async (id, row, patch) => { replies.set(id, [...(replies.get(id) || []), row]); rows.set(id, {...rows.get(id), ...patch}); },
    listAnnouncements: async () => [...announcements.values()],
    listDrafts: async () => [...drafts.values()],
    saveDraft: async draft => { drafts.set(draft.id,draft); },
    publish: async (id,date) => { const draft=drafts.get(id); if(!draft) throw Error('不存在'); const row={...draft,revision:(announcements.get(id)?.revision||0)+1,published_at:date}; announcements.set(id,row); return row; },
  };
  let seq=0; const service=createFeedbackService(store, () => `id-${++seq}`, () => '2026-11-08T00:00:00.000Z');
  return { service, rows };
}
test('only authenticated owners see their own feedback and replies; administrator is checked server side', async () => {
  const {service}=setup();
  await assert.rejects(() => service({}, {action:'list'}), /身份/);
  const one=await service({uid:'owner-a'}, {action:'submit',category:'problem',content:'private',appVersion:'1'});
  await service({uid:'owner-b'}, {action:'submit',category:'other',content:'another',appVersion:'1'});
  assert.equal((await service({uid:'owner-a'}, {action:'list'})).length,1);
  await assert.rejects(() => service({uid:'owner-b'}, {action:'replies',id:one.id}), /权限/);
  await assert.rejects(() => service({uid:'owner-b',isAdmin:true}, {action:'reply',id:one.id,content:'fake',status:'resolved'}), /权限/);
  await service({uid:'administrator',isAnonymous:false}, {action:'reply',id:one.id,content:'answer',status:'in_progress'});
  assert.equal((await service({uid:'owner-a'}, {action:'replies',id:one.id}))[0].content,'answer');
});
test('only administrators edit and publish announcements; drafts remain private', async () => {
  const {service}=setup();
  await assert.rejects(() => service({uid:'visitor'}, {action:'saveDraft',title:'标题',body:'内容'}), /权限/);
  const draft=await service({uid:'administrator',isAnonymous:false}, {action:'saveDraft',title:'标题',body:'内容'});
  await assert.rejects(() => service({uid:'visitor'}, {action:'drafts'}), /权限/);
  assert.equal((await service({uid:'visitor'}, {action:'announcements'})).length,0);
  await service({uid:'administrator',isAnonymous:false}, {action:'publish',id:draft.id});
  assert.equal((await service({uid:'visitor'}, {action:'announcements'}))[0].revision,1);
});
test('recycling is reversible and hides feedback from owners, with independent status changes', async () => {
  const {service}=setup(); const row=await service({uid:'owner-a'}, {action:'submit',category:'problem',content:'private',appVersion:'1'});
  await service({uid:'administrator',isAnonymous:false}, {action:'status',id:row.id,status:'resolved'});
  assert.equal((await service({uid:'owner-a'}, {action:'list'}))[0].status,'resolved');
  await service({uid:'administrator',isAnonymous:false}, {action:'recycle',id:row.id});
  assert.equal((await service({uid:'owner-a'}, {action:'list'})).length,0);
  await assert.rejects(() => service({uid:'owner-a'}, {action:'replies',id:row.id}), /权限/);
  await service({uid:'administrator',isAnonymous:false}, {action:'restore',id:row.id});
  assert.equal((await service({uid:'owner-a'}, {action:'list'})).length,1);
});
test('rejects invalid writes and does not return internal ownership data', async () => {
  const {service, rows}=setup();
  await assert.rejects(() => service({uid:'owner-a'}, {action:'submit',category:'invalid',content:'x',appVersion:'1'}), /类型/);
  await assert.rejects(() => service({uid:'owner-a'}, {action:'submit',category:'problem',content:' '.repeat(3),appVersion:'1'}), /长度/);
  assert.equal(rows.size,0);
  const row=await service({uid:'owner-a'}, {action:'submit',category:'problem',content:'x',appVersion:'1'});
  assert.equal('owner_id' in row,false);
  await assert.rejects(() => service({uid:'administrator',isAnonymous:false}, {action:'status',id:row.id,status:'invented'}), /状态/);
  assert.equal((await service({uid:'owner-a'}, {action:'list'}))[0].status,'open');
});
