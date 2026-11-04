import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
test('mail is before workspace search and feedback is beside settings categories',async()=>{
 const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.ok(/<MessageCenterButton \/><div className="global-search-wrap"/.test(app),'Mail must precede search');
 const settings=app.slice(app.indexOf('function SettingsView('),app.indexOf('function TableStyleSettings('));
 assert.match(settings,/打赏支持<\/button><FeedbackButton \/><\/nav>/);
 assert.doesNotMatch(app,/CloudFeedbackPanel/);
 const main=await readFile(new URL('../src/main.tsx',import.meta.url),'utf8');assert.match(main,/<MessageCenterProvider>[\s\S]*?<App \/>[\s\S]*?<MessageOverlays \/>/);
});
