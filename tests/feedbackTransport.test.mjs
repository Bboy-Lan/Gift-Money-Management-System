import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {transform} from "esbuild";

async function run(assertions) {
  const source = await readFile(new URL('../src/lib/feedbackTransport.ts', import.meta.url), 'utf8');
  const compiled = (await transform(source, {loader:'ts',format:'esm'})).code.replace(/import \{[^}]+\} from "@tauri-apps\/api\/core";/, `
    let native = false, installed;
    const calls=[];
    const invoke=async (command,args)=>{calls.push({command,args});return {status:200,headers:{'content-type':'application/json'},body:'{"ok":true}'};};
    const isTauri=()=>native;
    globalThis.window={localStorage:{},sessionStorage:{},WebSocket:class {}};
    const sdk={useAdapters(adapter){installed=adapter;}};
  `);
  const child=spawnSync(process.execPath,['--input-type=module','-e',compiled+'\nimport assert from "node:assert/strict";\n'+assertions],{encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(child.error,undefined);
  assert.equal(child.status,0,child.stderr);
}

test('desktop feedback adapter is installed only inside Tauri and preserves local session storage',async()=>{
  await run(`
    installFeedbackTransport(sdk); assert.equal(installed,undefined);
    native=true;installFeedbackTransport(sdk);
    assert.equal(installed.runtime,'web');assert.equal(installed.isMatch(),true);
    const adapter=installed.genAdapter();
    assert.equal(adapter.localStorage,window.localStorage);
    assert.equal(adapter.type,'lijin-desktop');
  `);
});

test('authentication and database requests use the bounded native command and retain HTTP results',async()=>{
  await run(`
    native=true;installFeedbackTransport(sdk);
    const request=new (installed.genAdapter().reqClass)();
    const url='https://cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com/auth/v1/token';
    const result=await request.post({url,data:{grant_type:'refresh_token'},headers:{'content-type':'application/json'}});
    assert.deepEqual(result.data,{ok:true});assert.equal(result.statusCode,200);
    assert.deepEqual(calls[0],{command:'feedback_http_request',args:{request:{url,method:'POST',headers:{'content-type':'application/json'},body:'{"grant_type":"refresh_token"}'}}});
    await request.fetch({url:'https://cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com/v1/rdb/rest/feedback',method:'GET',headers:new Headers({authorization:'Bearer test-token'})});
    assert.equal(calls[1].args.request.headers.authorization,'Bearer test-token');
    assert.equal(calls[1].args.request.body,null);
    await assert.rejects(request.upload({}),/不支持/);
    await assert.rejects(request.download({}),/不支持/);
  `);
});
