import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
test('legacy endpoints return Gone without loading provider code or touching data',()=>{
 for(const file of ['src/app/api/room-ranker/route.ts','src/app/api/integrations/room-ranker/sync/route.ts']){
 const loadedModule={exports:{}};vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:loadedModule.exports,require:name=>{assert.equal(name,'next/server');return {NextResponse:{json:(body,{status})=>({body,status})}}}});
 for(const method of ['GET','POST','PATCH'])assert.equal(loadedModule.exports[method]().status,410);
 }
});
test('legacy background producer and consumers are retired while current ranker stays present',()=>{
 const crons=JSON.parse(read('vercel.json')).crons;assert.ok(!crons.some(c=>c.path==='/api/integrations/room-ranker/sync'));
 for(const file of ['src/app/api/work-orders/route.ts','src/app/api/work-orders/[id]/route.ts'])assert.doesNotMatch(read(file),/processRoomRankerSyncForWorkOrder/);
 for(const file of ['src/lib/server/cmpri-mcp-reads.ts','src/lib/server/cmpri-mcp-writes.ts'])assert.doesNotMatch(read(file),/case "room_ranker|case "integrations.room_ranker/);
 assert.match(read('supabase/migrations/20261106112635_retire_legacy_room_ranker.sql'),/DROP TRIGGER IF EXISTS cmpri_room_ranker_sync_enqueue ON public.work_orders/);
 assert.doesNotMatch(read('supabase/migrations/20261106112635_retire_legacy_room_ranker.sql'),/DROP TABLE|DELETE FROM/i);
 assert.ok(existsSync(new URL('../src/app/api/ticket-room-ranker/route.ts',import.meta.url)));
 assert.match(read('src/app/engineering/room-ranking/page.tsx'),/\/api\/ticket-room-ranker/);
});
