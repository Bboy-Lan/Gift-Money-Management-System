// CloudBase Node SDK adapter. Collections must deny direct client access.
const COLLECTIONS = Object.freeze({ feedback:'lijin_feedback_v1', replies:'lijin_feedback_replies_v1', admins:'lijin_feedback_admins_v1', announcements:'lijin_announcements_v1', drafts:'lijin_announcement_drafts_v1' });
const checked = result => { if (!result || result.code) throw new Error('数据库操作失败'); return result; };
const rowOf = result => Array.isArray(result.data) ? result.data[0] : result.data;
const transactionRow = result => {
  const data = typeof result?.data === 'function' ? result.data() : result?.data;
  return Array.isArray(data) ? data[0] : data;
};
function createStore(db) {
  const collection = name => db.collection(COLLECTIONS[name]);
  const transactionGet = async (tx, name, id) => typeof tx.collection === 'function'
    ? transactionRow(await tx.collection(COLLECTIONS[name]).doc(id).get())
    : transactionRow(await tx.get(collection(name).doc(id)));
  const transactionSet = (tx, name, id, value) => typeof tx.collection === 'function'
    ? tx.collection(COLLECTIONS[name]).doc(id).set(value)
    : tx.set(collection(name).doc(id), value);
  const transactionUpdate = (tx, name, id, value) => typeof tx.collection === 'function'
    ? tx.collection(COLLECTIONS[name]).doc(id).update(value)
    : tx.update(collection(name).doc(id), value);
  const get = async (name, id) => rowOf(checked(await collection(name).doc(id).get())) || null;
  const pages = async query => {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const result = checked(await query.skip(offset).limit(100).get());
      if (!Array.isArray(result.data)) throw new Error('数据库返回结果无效');
      rows.push(...result.data);
      if (result.data.length < 100) return rows;
      if (rows.length >= 10000) throw new Error('反馈数量过多，请联系管理员');
    }
  };
  return {
    async isAdmin(uid) { const row=await get('admins',uid); return row?.enabled === true; },
    async create(row) { checked(await collection('feedback').add({...row,_id:row.id})); },
    async get(id) { return get('feedback',id); },
    async list(uid, recycled) {
      const filter = {deleted_at:recycled ? db.command.neq(null) : null};
      if (uid) filter.owner_id=uid;
      return pages(collection('feedback').where(filter).orderBy('created_at','desc'));
    },
    async update(id, patch) {
      const tx=await db.startTransaction();
      try {
        const current=await transactionGet(tx,'feedback',id);
        if (!current) throw new Error('反馈不存在');
        if ('status' in patch && current.deleted_at) throw new Error('反馈已删除');
        if ('deleted_at' in patch && Boolean(current.deleted_at) === Boolean(patch.deleted_at)) throw new Error('反馈状态已变化');
        const actual={...patch};
        if ('status' in actual) actual.status_changed_at = current.status === actual.status ? current.status_changed_at : actual.updated_at;
        await transactionUpdate(tx,'feedback',id,actual); await tx.commit();
      } catch(error) { await tx.rollback(); throw error; }
    },
    async replies(id) { return pages(collection('replies').where({feedback_id:id}).orderBy('created_at','asc')); },
    async reply(id, reply, patch) {
      const tx = await db.startTransaction();
      try {
        const current = await transactionGet(tx,'feedback',id);
        if (!current || current.deleted_at) throw new Error('反馈不存在或已删除');
        const actualPatch={...patch};
        actualPatch.status_changed_at = current.status === patch.status ? current.status_changed_at : patch.updated_at;
        await transactionSet(tx,'replies',reply.id,reply);
        await transactionUpdate(tx,'feedback',id,actualPatch);
        await tx.commit();
      } catch (error) { await tx.rollback(); throw error; }
    },
    async listAnnouncements() { return pages(collection('announcements').orderBy('published_at','desc')); },
    async listDrafts() { return pages(collection('drafts').orderBy('updated_at','desc')); },
    async saveDraft(draft) { checked(await collection('drafts').doc(draft.id).set(draft)); },
    async publish(id, date) {
      const tx = await db.startTransaction();
      try {
        const draft = await transactionGet(tx,'drafts',id);
        if (!draft) throw new Error('公告草稿不存在');
        const previous=await transactionGet(tx,'announcements',id);
        const row={id,title:draft.title,body:draft.body,revision:(previous?.revision || 0)+1,published_at:date};
        await transactionSet(tx,'announcements',id,row); await tx.commit(); return row;
      } catch (error) { await tx.rollback(); throw error; }
    },
  };
}
module.exports = { createStore, COLLECTIONS };
