import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const sql=readFileSync(new URL('../supabase/migrations/20261111051453_asset_manual_ocr_pages.sql',import.meta.url),'utf8');

test('OCR pages are private, source-scoped and claimed with a recoverable lease',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema cmpri_private; create function cmpri_private.signal_resource() returns trigger language plpgsql as $$begin return new; end$$;`);
  await db.exec(sql);
  await db.exec(`insert into public.cmpri_asset_manual_ocr_jobs(hotel_id,asset_id,source_path,source_sha256,total_pages) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','hotel/asset/manual.pdf',repeat('a',64),2)`);
  await db.exec(`insert into public.cmpri_asset_manual_ocr_jobs(hotel_id,asset_id,source_path,source_sha256,total_pages) values('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000002','other/manual.pdf',repeat('a',64),2)`);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from public.cmpri_asset_manual_ocr_pages'),/permission denied/i);
  await assert.rejects(db.query("select * from public.cmpri_claim_asset_manual_ocr_job('00000000-0000-4000-8000-000000000001')"),/permission denied/i);
  await db.exec('reset role; set role service_role');
  const first=await db.query("select * from public.cmpri_claim_asset_manual_ocr_job('00000000-0000-4000-8000-000000000001')");assert.equal(first.rows.length,1);assert.equal(first.rows[0].status,'processing');
  assert.equal((await db.query("select * from public.cmpri_claim_asset_manual_ocr_job('00000000-0000-4000-8000-000000000001')")).rows.length,0);
  await db.exec("update public.cmpri_asset_manual_ocr_jobs set lease_expires_at=now()-interval '1 minute'");
  const recovered=await db.query("select * from public.cmpri_claim_asset_manual_ocr_job('00000000-0000-4000-8000-000000000001')");assert.equal(recovered.rows.length,1);assert.notEqual(first.rows[0].lease_token,recovered.rows[0].lease_token);
  await db.exec("insert into public.cmpri_asset_manual_ocr_pages(hotel_id,asset_id,source_sha256,page_number,text,confidence) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',repeat('a',64),1,'Source page text',90)");
  await assert.rejects(db.exec("insert into public.cmpri_asset_manual_ocr_pages(hotel_id,asset_id,source_sha256,page_number,text,confidence) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',repeat('b',64),1,'Wrong source',90)"),/foreign key/i);
 }finally{await db.close();}
});
