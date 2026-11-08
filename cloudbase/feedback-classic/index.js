// Cloud function entry: no credentials or caller identity accepted from event.
const cloudbase = require('@cloudbase/node-sdk');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./store.cjs');
const { createFeedbackService } = require('./service.cjs');
const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const service = createFeedbackService(createStore(app.database()), randomUUID, () => new Date().toISOString());
exports.main = async event => {
  try {
    const { uid, isAnonymous } = app.auth().getUserInfo();
    return { ok:true, data:await service({ uid, isAnonymous }, event) };
  } catch (error) {
    // Never log feedback text, identity, tokens, or internal error details.
    const code = String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
    console.error('feedback-error-code:', code);
    const location = String(error?.stack || '').match(/(?:store|service)\.cjs:\d+:\d+/)?.[0];
    if (location) console.error('feedback-error-location:', location);
    return { ok:false, error:'反馈请求失败，请检查身份或稍后重试' };
  }
};
