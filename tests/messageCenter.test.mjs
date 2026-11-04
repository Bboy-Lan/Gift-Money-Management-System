import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://local.test',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
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
 export const listFeedbackReplies=async()=>globalThis.__replies;
 export const feedbackCategoryLabel=()=>"问题反馈";export const feedbackStatusLabel=()=>"待处理";
 export const submitFeedback=async()=>{};export const replyToFeedback=async()=>{};export const requestFeedbackAdminCode=async()=>({verify:async()=>{}});
 `}));
}}]});
const path=new URL(`./.messages-${process.pid}.mjs`,import.meta.url);await writeFile(path,bundled.outputFiles[0].text);
let api;try{api=await import(path.href);}finally{await unlink(path);}after(()=>dom.window.close());
function reset(){window.localStorage.clear();Object.assign(globalThis,{__admin:false,__announcements:[],__drafts:[],__replyStatus:[],__feedback:[],__replies:[],__checks:0,__saves:0,__publishes:0,__offline:false,__hold:null});}
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
test('reply unread survives opening feedback and clears only when the actual reply is expanded',async()=>{
 reset();guideRead();globalThis.__replyStatus=[{id:'f1',last_replied_at:'2026-11-04T10:00:00Z'}];
 globalThis.__feedback=[{id:'f1',category:'problem',content:'示例问题',status:'open',app_version:'test',created_at:'2026-11-04T09:00:00Z',last_replied_at:'2026-11-04T10:00:00Z'}];
 globalThis.__replies=[{id:'r1',feedback_id:'f1',content:'管理员已回复',created_at:'2026-11-04T10:00:00Z'}];
 const view=await mount();try{assert.match(view.node.textContent,/收到管理员新回复/);await click(button(view.node,'问题反馈'));assert.ok(view.node.querySelector('.feedback-workbench'));assert.equal(view.node.querySelector('.modal-backdrop'),null);assert.ok(view.node.querySelector('[data-unread="true"]'));assert.doesNotMatch(view.node.textContent,/管理员已回复/);await click(button(view.node,'查看回复'));assert.match(view.node.textContent,/管理员已回复/);assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();}
});
test('administrator saves drafts without publishing and publishes only through the explicit action',async()=>{
 reset();globalThis.__admin=true;const view=await mount();try{await click(button(view.node,'管理公告'));await input(view.node.querySelector('input[name="announcement-title"]'),'运行说明');await input(view.node.querySelector('textarea[name="announcement-body"]'),'这是新的公告内容');await click(button(view.node,'保存草稿'));assert.equal(globalThis.__saves,1);assert.equal(globalThis.__publishes,0);assert.equal(globalThis.__announcements.length,0);await click(button(view.node,'发布公告'));assert.equal(globalThis.__publishes,1);assert.equal(globalThis.__announcements[0].body,'这是新的公告内容');assert.equal(JSON.parse(window.localStorage.getItem('lijinbook.messages.read.v1')).announcements['draft-new'],2);}finally{await view.close();}
});
test('a reply reminder scrolls directly to the older feedback reply before clearing unread',async()=>{
 reset();guideRead();const stamp='2026-11-04T10:00:00Z';globalThis.__replyStatus=[{id:'older',last_replied_at:stamp}];
 globalThis.__feedback=[{id:'newer',category:'problem',content:'较新问题',status:'open',created_at:stamp,last_replied_at:null},{id:'older',category:'problem',content:'较早问题',status:'open',created_at:'2026-10-01T10:00:00Z',last_replied_at:stamp}];
 globalThis.__replies=[{id:'r1',content:'较早问题的新回复',created_at:stamp}];
 const previous=window.HTMLElement.prototype.scrollIntoView;const positioned=[];window.HTMLElement.prototype.scrollIntoView=function(){positioned.push(this.closest('[data-feedback-id]')?.dataset.feedbackId);};
 const view=await mount();try{await click(button(view.node,'查看新回复'));assert.deepEqual(positioned,['older']);assert.match(view.node.textContent,/较早问题的新回复/);assert.equal(view.node.querySelector('[data-unread="true"]'),null);}finally{await view.close();window.HTMLElement.prototype.scrollIntoView=previous;}
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
