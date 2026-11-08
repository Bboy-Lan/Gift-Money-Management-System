import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://local.test',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
globalThis.IntersectionObserver=class { constructor(callback){this.callback=callback;this.targets=[];globalThis.__observer=this;} observe(target){this.targets.push(target);} disconnect(){} };
const {createRoot}=await import('react-dom/client');
const bundled=await build({stdin:{contents:'export * from "./src/hooks/useMessages";export * from "./src/components/MessageCenter";',resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'message-cloud-boundary',setup(b){
 b.onResolve({filter:/^[^./]/},args=>({path:import.meta.resolve(args.path),external:true}));
 b.onLoad({filter:/[\\/]lib[\\/]cloudFeedback\.ts$/},()=>({loader:'js',contents:`
 export const ensureFeedbackUserSession=async()=>({isAdminSession:globalThis.__admin});
 export const switchToAnonymousFeedback=async()=>({isAdminSession:false});
 export const listAnnouncements=async()=>{globalThis.__checks++;if(globalThis.__hold)await globalThis.__hold;if(globalThis.__offline)throw Error('offline');return globalThis.__announcements;};
 export const listFeedbackReplyStatus=async()=>globalThis.__replyStatus;
 export const listAnnouncementDrafts=async()=>globalThis.__drafts;
 export const saveAnnouncementDraft=async input=>{globalThis.__saves++;const row={...input,id:input.id||'draft-new',updated_at:'2026-11-04T10:00:00Z'};globalThis.__drafts=[row];return row;};
 export const publishAnnouncement=async id=>{globalThis.__publishes++;const row={...globalThis.__drafts.find(d=>d.id===id),revision:2,published_at:'2026-11-04T10:01:00Z'};globalThis.__announcements=[row];return row;};
 export const listFeedback=async()=>globalThis.__feedback;
 export const listFeedbackReplies=async id=>globalThis.__repliesById?.[id] ?? globalThis.__replies;
 export const feedbackCategoryLabel=()=>"问题反馈";export const feedbackStatusLabel=()=>"待处理";
 export const submitFeedback=async()=>{};export const replyToFeedback=async(id,content,status)=>{globalThis.__sent={id,content,status};};export const updateFeedbackStatus=async(id,status)=>{globalThis.__statusSaved={id,status};};export const requestFeedbackAdminCode=async()=>({verify:async()=>{}});
 export const deleteFeedback=async id=>{globalThis.__deleted=id;globalThis.__feedback=globalThis.__feedback.filter(item=>item.id!==id);};
 export const listRecycledFeedback=async()=>globalThis.__recycled||[];
 export const restoreFeedback=async id=>{globalThis.__restored=id;globalThis.__feedback=[...globalThis.__feedback,...globalThis.__recycled.filter(item=>item.id===id)];globalThis.__recycled=globalThis.__recycled.filter(item=>item.id!==id);};
 `}));
}}]});
const path=new URL(`./.messages-${process.pid}.mjs`,import.meta.url);await writeFile(path,bundled.outputFiles[0].text);
let api;try{api=await import(path.href);}finally{await unlink(path);}after(()=>dom.window.close());
function reset(){window.localStorage.clear();Object.assign(globalThis,{__admin:false,__announcements:[],__drafts:[],__replyStatus:[],__feedback:[],__replies:[],__repliesById:null,__checks:0,__saves:0,__publishes:0,__offline:false,__hold:null});}
async function mount(){const node=document.createElement('div');document.body.append(node);const root=createRoot(node);await act(async()=>root.render(React.createElement(api.MessageCenterProvider,null,React.createElement(api.MessageCenterButton),React.createElement(api.FeedbackButton),React.createElement(api.MessageOverlays),React.createElement(api.FeedbackWorkbench))));return{node,async close(){await act(async()=>root.unmount());node.remove();}};}
const button=(node,text)=>[...node.querySelectorAll('button')].find(x=>x.textContent.includes(text)||x.getAttribute('aria-label')?.includes(text));
async function click(b){assert.ok(b);await act(async()=>b.dispatchEvent(new window.MouseEvent('click',{bubbles:true})));}
async function input(el,value){assert.ok(el);await act(async()=>{Object.getOwnPropertyDescriptor(window[el.tagName==='TEXTAREA'?'HTMLTextAreaElement':'HTMLInputElement'].prototype,'value').set.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));});}
function guideRead(){window.localStorage.setItem('lijinbook.messages.read.v1',JSON.stringify({announcements:{'software-guide':1},replies:{}}));}

test('first announcement opens once, closing retains unread and explicit read survives restart',async()=>{
 reset();let view=await mount();try{assert.ok(view.node.querySelector('[aria-label="消息中心"]'));assert.match(view.node.textContent,/欢迎使用礼金簿/);await click(button(view.node,'关闭消息中心'));assert.equal(view.node.querySelector('[data-unread="true"]')!==null,true);await click(button(view.node,'打开消息中心'));await click(button(view.node,'已读并收起'));assert.equal(view.node.querySelector('[aria-label="消息中心"]'),null);assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();}
 view=await mount();try{assert.equal(view.node.querySelector('[aria-label="消息中心"]'),null);}finally{await view.close();}
 globalThis.__announcements=[{id:'software-guide',title:'新的运行说明',body:'说明已更新',revision:2,published_at:'2026-11-04T10:00:00Z'}];
 view=await mount();try{assert.match(view.node.textContent,/新的运行说明/);assert.ok(view.node.querySelector('[data-unread="true"]'));}finally{await view.close();}
});
test('replies are visible immediately and unread clears only when the reply becomes visible',async()=>{
 reset();guideRead();globalThis.__replyStatus=[{id:'f1',last_replied_at:'2026-11-04T10:00:00Z'}];
 globalThis.__feedback=[{id:'f1',category:'problem',content:'示例问题',status:'open',app_version:'test',created_at:'2026-11-04T09:00:00Z',last_replied_at:'2026-11-04T10:00:00Z'}];
 globalThis.__replies=[{id:'r1',feedback_id:'f1',content:'管理员已回复',created_at:'2026-11-04T10:00:00Z'}];
 const view=await mount();try{assert.match(view.node.textContent,/收到管理员新回复/);await click(button(view.node,'问题反馈'));assert.ok(view.node.querySelector('.feedback-workbench'));assert.equal(view.node.querySelector('.modal-backdrop'),null);assert.ok(view.node.querySelector('[data-unread="true"]'));assert.match(view.node.textContent,/管理员已回复/);assert.equal(button(view.node,'查看回复'),undefined);await act(async()=>globalThis.__observer.callback(globalThis.__observer.targets.map(target=>({target,isIntersecting:true}))));assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();}
});
test('administrator saves drafts without publishing and publishes only through the explicit action',async()=>{
 reset();globalThis.__admin=true;const view=await mount();try{await click(button(view.node,'管理公告'));await input(view.node.querySelector('input[name="announcement-title"]'),'运行说明');await input(view.node.querySelector('textarea[name="announcement-body"]'),'这是新的公告内容');await click(button(view.node,'保存草稿'));assert.equal(globalThis.__saves,1);assert.equal(globalThis.__publishes,0);assert.equal(globalThis.__announcements.length,0);await click(button(view.node,'发布公告'));assert.equal(globalThis.__publishes,1);assert.equal(globalThis.__announcements[0].body,'这是新的公告内容');assert.equal(JSON.parse(window.localStorage.getItem('lijinbook.messages.read.v1')).announcements['draft-new'],2);}finally{await view.close();}
});
test('a reply remains unread while the application is hidden',async()=>{
 reset();guideRead();const stamp='2026-11-07T10:00:00Z';globalThis.__replyStatus=[{id:'f1',last_replied_at:stamp}];
 globalThis.__feedback=[{id:'f1',category:'problem',content:'问题',status:'open',created_at:stamp,last_replied_at:stamp}];
 globalThis.__replies=[{id:'r1',feedback_id:'f1',content:'答复',created_at:stamp}];
 const view=await mount();try{await click(button(view.node,'问题反馈'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});await act(async()=>globalThis.__observer.callback(globalThis.__observer.targets.map(target=>({target,isIntersecting:true}))));assert.ok(view.node.querySelector('[data-unread="true"]'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await act(async()=>{document.dispatchEvent(new window.Event('visibilitychange'));globalThis.__observer.callback(globalThis.__observer.targets.map(target=>({target,isIntersecting:true})));});assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{delete document.visibilityState;await view.close();}
});
test('a status change notifies its owner until the changed status is visible',async()=>{
 reset();guideRead();const stamp='2026-11-07T12:00:00Z';globalThis.__replyStatus=[{id:'f1',last_replied_at:null,status:'resolved',status_changed_at:stamp}];
 globalThis.__feedback=[{id:'f1',category:'problem',content:'问题',status:'resolved',status_changed_at:stamp,created_at:stamp,last_replied_at:null}];
 const view=await mount();try{assert.match(view.node.textContent,/反馈处理状态已更新/);await click(button(view.node,'查看状态'));assert.ok(view.node.querySelector('[data-unread="true"]'));await act(async()=>globalThis.__observer.callback(globalThis.__observer.targets.map(target=>({target,isIntersecting:true}))));assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();}
});
test('a reply reminder scrolls directly to the older feedback reply before clearing unread',async()=>{
 reset();guideRead();const stamp='2026-11-04T10:00:00Z';globalThis.__replyStatus=[{id:'older',last_replied_at:stamp}];
 globalThis.__feedback=[{id:'newer',category:'problem',content:'较新问题',status:'open',created_at:stamp,last_replied_at:null},{id:'older',category:'problem',content:'较早问题',status:'open',created_at:'2026-10-01T10:00:00Z',last_replied_at:stamp}];
 globalThis.__replies=[{id:'r1',content:'较早问题的新回复',created_at:stamp}];
 const previous=window.HTMLElement.prototype.scrollIntoView;const positioned=[];window.HTMLElement.prototype.scrollIntoView=function(){positioned.push(this.closest('[data-feedback-id]')?.dataset.feedbackId);};
 const view=await mount();try{await click(button(view.node,'查看新回复'));assert.deepEqual(positioned,['older']);assert.match(view.node.textContent,/较早问题的新回复/);assert.ok(view.node.querySelector('[data-unread="true"]'));await act(async()=>globalThis.__observer.callback(globalThis.__observer.targets.map(target=>({target,isIntersecting:true}))));assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();window.HTMLElement.prototype.scrollIntoView=previous;}
});
test('administrator sees earlier replies and keeps the chosen issue status when replying',async()=>{
 reset();guideRead();globalThis.__admin=true;globalThis.__sent=null;
 globalThis.__feedback=[{id:'f1',category:'problem',content:'问题内容',status:'open',app_version:'0.4.56',created_at:'2026-11-07T09:00:00Z',last_replied_at:'2026-11-07T10:00:00Z'}];
 globalThis.__replies=[{id:'r1',feedback_id:'f1',content:'之前的答复',created_at:'2026-11-07T10:00:00Z'}];
 const view=await mount();try{await click(button(view.node,'问题反馈'));assert.match(view.node.textContent,/之前的答复/);assert.match(view.node.textContent,/已回复/);assert.doesNotMatch(view.node.textContent,/查看回复/);const row=view.node.querySelector('.feedback-item');assert.ok(row.querySelector('.feedback-user-content').compareDocumentPosition(row.querySelector('.feedback-version')) & window.Node.DOCUMENT_POSITION_FOLLOWING);assert.match(row.querySelector('.feedback-version').textContent,/版本 0\.4\.56/);assert.doesNotMatch(row.querySelector('.feedback-reply').textContent,/版本/);await click(button(view.node,'回复并更新状态'));const picker=view.node.querySelector('.feedback-status-picker');assert.equal(button(picker,'待处理').getAttribute('aria-pressed'),'true');assert.equal(button(picker,'处理中').disabled,true);await click(button(picker,'待处理'));assert.equal(button(view.node,'发送回复').disabled,true);await click(button(picker,'处理中'));await input(view.node.querySelector('.feedback-reply-actions textarea'),'新的答复');await click(button(view.node,'发送回复'));assert.equal(globalThis.__sent.status,'in_progress');await click(button(view.node,'修改状态'));const picker2=view.node.querySelector('.feedback-status-picker');await click(button(picker2,'待处理'));await click(button(picker2,'已处理'));await click(button(view.node,'保存状态'));assert.deepEqual(globalThis.__statusSaved,{id:'f1',status:'resolved'});}finally{await view.close();}
});
test('administrator overview, collapse, and confirmed deletion operate on feedback',async()=>{
 reset();guideRead();globalThis.__admin=true;globalThis.__deleted=null;
 globalThis.__feedback=[{id:'f1',category:'problem',content:'用户反馈内容',status:'open',app_version:'0.4.58',created_at:'2026-11-07T09:00:00Z',last_replied_at:'2026-11-07T10:00:00Z'}];
 globalThis.__replies=[{id:'r1',feedback_id:'f1',content:'管理员答复',created_at:'2026-11-07T10:00:00Z'}];
 const view=await mount();try{await click(button(view.node,'问题反馈'));assert.match(view.node.textContent,/反馈总览/);const row=view.node.querySelector('.feedback-item');const card=row.querySelector('.feedback-user-card');assert.ok(card);assert.match(card.textContent,/用户反馈内容/);assert.match(card.querySelector('.feedback-version').textContent,/版本 0\.4\.58/);assert.equal(card.getAttribute('aria-expanded'),'true');assert.ok(row.querySelector('.feedback-footer .feedback-delete'));await click(card);assert.equal(card.getAttribute('aria-expanded'),'false');assert.match(card.textContent,/用户反馈内容/);assert.doesNotMatch(row.textContent,/管理员答复/);await click(card);assert.equal(card.getAttribute('aria-expanded'),'true');assert.match(row.textContent,/管理员答复/);await click(button(row,'删除反馈'));assert.match(row.textContent,/确认删除/);assert.equal(globalThis.__deleted,null);await click(button(row,'确认删除'));assert.equal(globalThis.__deleted,'f1');assert.doesNotMatch(view.node.textContent,/用户反馈内容/);}finally{await view.close();}
});
test('feedback recycle bin restores a deleted item and is unavailable to ordinary users',async()=>{
 reset();guideRead();globalThis.__admin=true;globalThis.__restored=null;globalThis.__recycled=[{id:'f2',category:'problem',content:'误删的反馈',status:'open',created_at:'2026-11-07T09:00:00Z',deleted_at:'2026-11-08T09:00:00Z'}];
 let view=await mount();try{await click(button(view.node,'问题反馈'));await click(button(view.node,'反馈回收站'));assert.match(view.node.textContent,/误删的反馈/);await click(button(view.node,'恢复反馈'));assert.equal(globalThis.__restored,'f2');assert.match(view.node.querySelector('.feedback-list').textContent,/误删的反馈/);}finally{await view.close();}
 reset();guideRead();view=await mount();try{await click(button(view.node,'问题反馈'));assert.equal(button(view.node,'反馈回收站'),undefined);assert.equal(button(view.node,'删除反馈'),undefined);}finally{await view.close();}
});
test('administrator overview counts feedback and reply status independently',async()=>{
 reset();guideRead();globalThis.__admin=true;globalThis.__feedback=['open','in_progress','resolved'].map((status,index)=>({id:`f${index}`,category:'problem',content:`反馈${index}`,status,created_at:'2026-11-07T09:00:00Z'}));globalThis.__repliesById={f0:[{id:'r1',content:'答复',created_at:'2026-11-07T10:00:00Z'}],f1:[],f2:[]};
 const view=await mount();try{await click(button(view.node,'问题反馈'));const cells=[...view.node.querySelectorAll('.feedback-overview-grid > div')].map(el=>el.textContent);assert.deepEqual(cells,['全部反馈3','已回复1','待处理1','处理中1','已处理1']);}finally{await view.close();}
});
test('announcement administrator entry opens email verification without granting permissions',async()=>{
 reset();const view=await mount();try{await click(button(view.node,'管理员登录'));assert.ok(view.node.querySelector('input[type="email"]'));assert.equal(view.node.querySelector('input[type="password"]'),null);assert.doesNotMatch(view.node.textContent,/保存草稿/);}finally{await view.close();}
});
test('a new announcement while working adds unread without interrupting with another automatic panel',async()=>{
 reset();guideRead();const view=await mount();try{
  globalThis.__announcements=[{id:'software-guide',title:'运行中的新公告',body:'新的内容',revision:2,published_at:'2026-11-04T10:00:00Z'}];
  await act(async()=>window.dispatchEvent(new window.Event('focus')));
  assert.ok(view.node.querySelector('[data-unread="true"]'));
  assert.equal(view.node.querySelector('[aria-label="消息中心"]'),null);
  await click(button(view.node,'打开消息中心'));assert.match(view.node.textContent,/运行中的新公告/);
 }finally{await view.close();}
});
test('polling is single-flight, offline retains unread state and unmount clears its timer',async()=>{
 reset();guideRead();globalThis.__replyStatus=[{id:'f1',last_replied_at:'2026-11-04T10:00:00Z'}];
 const originalSet=window.setInterval,originalClear=window.clearInterval;let tick,cleared=0;
 window.setInterval=callback=>{tick=callback;return 1234;};window.clearInterval=id=>{if(id===1234)cleared++;};
 let view;try{view=await mount();let release;globalThis.__hold=new Promise(r=>release=r);const before=globalThis.__checks;await act(async()=>{tick();window.dispatchEvent(new window.Event('focus'));});assert.equal(globalThis.__checks,before+1);globalThis.__offline=true;await act(async()=>{release();await Promise.resolve();});assert.ok(view.node.querySelector('[data-unread="true"]'));await view.close();view=null;assert.equal(cleared,1);}finally{if(view)await view.close();window.setInterval=originalSet;window.clearInterval=originalClear;}
});
