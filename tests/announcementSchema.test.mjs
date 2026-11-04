import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('announcement drafts are separate from published snapshots and publishing checks the server administrator',async()=>{
 const sql=await readFile(new URL('../cloudbase/feedback/004_announcements.sql',import.meta.url),'utf8');
 assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.announcements/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.announcement_drafts/);
 for(const name of ['save_announcement_draft','publish_announcement']){
  const body=sql.slice(sql.indexOf('FUNCTION public.'+name));
  assert.match(body,/IF NOT public\.is_feedback_admin\(\) THEN/);
  assert.match(body,/SECURITY DEFINER[\s\S]*?SET search_path = public, pg_temp/);
 }
 assert.match(sql,/revision = published\.revision \+ 1/);
 assert.match(sql,/GRANT SELECT ON public\.announcements TO anon, authenticated/);
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
 assert.doesNotMatch(sql,/GRANT (?:ALL|INSERT|UPDATE|DELETE).* TO anon/);
 assert.match(sql,/AFTER INSERT ON public\.feedback_replies/);
 assert.match(sql,/NEW\.created_at/);
});
