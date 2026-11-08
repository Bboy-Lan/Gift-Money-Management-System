// Pure authorization and validation layer. The runtime must obtain uid from
// trusted CloudBase context, and implement atomic store.reply in a transaction.
function createFeedbackService(store, newId, now) {
  const statusValues = new Set(['open', 'in_progress', 'resolved']);
  const categories = new Set(['problem', 'suggestion', 'other']);
  const content = (value, max) => {
    if (typeof value !== 'string') throw new Error('内容无效');
    const result = value.trim().replace(/\r\n/g, '\n');
    if (!result || result.length > max) throw new Error('内容长度无效');
    return result;
  };
  const publicRow = ({id,category,content,app_version,status,created_at,updated_at,last_replied_at,status_changed_at}) => ({id,category,content,app_version,status,created_at,updated_at,last_replied_at,status_changed_at});
  return async (identity, event) => {
    const uid = identity?.uid;
    if (typeof uid !== 'string' || !uid) throw new Error('缺少身份');
    if (!event || typeof event !== 'object') throw new Error('请求无效');
    const admin = identity.isAnonymous === false && await store.isAdmin(uid);
    const requireAdmin = () => { if (!admin) throw new Error('没有管理员权限'); };
    if (event.action === 'adminStatus') return { is_admin: admin };
    if (event.action === 'announcements') return store.listAnnouncements();
    if (event.action === 'drafts') { requireAdmin(); return store.listDrafts(); }
    if (event.action === 'saveDraft') {
      requireAdmin();
      const id = event.id == null ? newId() : content(event.id,128);
      const draft = {id, title:content(event.title,120), body:content(event.body,8000), updated_at:now()};
      await store.saveDraft(draft); return draft;
    }
    if (event.action === 'publish') {
      requireAdmin();
      const id = content(event.id,128);
      // Atomic revision increment and snapshot creation are the store's responsibility.
      return store.publish(id, now());
    }
    if (event.action === 'submit') {
      if (!categories.has(event.category)) throw new Error('类型无效');
      const date = now();
      const row = {id:newId(), owner_id:uid, category:event.category, content:content(event.content,4000), app_version:content(event.appVersion,32), status:'open', created_at:date, updated_at:date, last_replied_at:null, status_changed_at:null, deleted_at:null};
      await store.create(row); return publicRow(row);
    }
    if (event.action === 'list') return (await store.list(admin ? null : uid, false)).filter(row => !row.deleted_at && (admin || row.owner_id === uid)).map(publicRow);
    if (event.action === 'recycled') { requireAdmin(); return (await store.list(null, true)).filter(row => row.deleted_at).map(({id,category,content,deleted_at}) => ({id,category,content,deleted_at})); }
    if (typeof event.id !== 'string' || !event.id || event.id.length > 128) throw new Error('反馈标识无效');
    const row = await store.get(event.id);
    if (!row || (!admin && (row.owner_id !== uid || row.deleted_at))) throw new Error('没有查看权限');
    if (event.action === 'replies') {
      if (row.deleted_at) throw new Error('没有查看权限');
      return (await store.replies(row.id)).map(({id,feedback_id,content,created_at}) => ({id,feedback_id,content,created_at}));
    }
    requireAdmin();
    if (event.action === 'recycle' || event.action === 'restore') {
      if ((event.action === 'recycle') === Boolean(row.deleted_at)) throw new Error('反馈状态已变化');
      await store.update(row.id, {deleted_at:event.action === 'recycle' ? now() : null, updated_at:now()}); return {success:true};
    }
    if (row.deleted_at) throw new Error('反馈已删除');
    if (event.action === 'status' || event.action === 'reply') {
      if (!statusValues.has(event.status)) throw new Error('处理状态无效');
      const date=now(); const patch={status:event.status, updated_at:date, status_changed_at:row.status !== event.status ? date : row.status_changed_at};
      if (event.action === 'status') await store.update(row.id, patch);
      else {
        patch.last_replied_at=date;
        await store.reply(row.id, {id:newId(), feedback_id:row.id, content:content(event.content,4000), created_at:date}, patch);
      }
      return {success:true};
    }
    throw new Error('操作无效');
  };
}
module.exports = { createFeedbackService };
