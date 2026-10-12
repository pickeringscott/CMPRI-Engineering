import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {api,users,admin,ok,report,clientFor,hotel,out} from './client.mjs';
const fixtures=JSON.parse(readFileSync(new URL('./photo-fixtures.json',import.meta.url)));
const expected=Buffer.from(fixtures.right,'base64'),wrong=Buffer.from(fixtures.wrong,'base64');
const hash=data=>createHash('sha256').update(data).digest('hex');
const results=[],chief=users.find(u=>u.role==='chief_engineer');
const submissions=JSON.parse(readFileSync(new URL('e2e-results.json',out)));
for(const user of users.filter(u=>['housekeeping','front_desk'].includes(u.role))){
 try{
  const submission=submissions.find(s=>s.storedRole===user.role&&s.scenario==='lamp');
  assert.ok(submission?.passed,'Browser photo submission is prerequisite');
  const order=submission.rows[0],prefix=`${hotel}/work-orders/${order.id}`;
  const persisted=await ok(admin.from('work_orders').select('id,created_by,status').eq('id',order.id).single());
  assert.equal(persisted.created_by,user.id);assert.equal(persisted.status,'Pending Verification');
  const files=await ok(admin.storage.from('asset-documentation').list(prefix));
  assert.equal(files.length,1,'Only the retained photo may persist at the work-order path');
  const path=prefix+'/'+files[0].name;
  const object=await ok(admin.storage.from('asset-documentation').download(path));
  const bytes=Buffer.from(await object.arrayBuffer());assert.equal(hash(bytes),hash(expected));assert.notEqual(hash(bytes),hash(wrong));
  const readback=await api(chief,`/api/work-orders/${order.id}/attachments`);
  assert.equal(readback.status,200);assert.equal(readback.body.images.length,1);
  const signed=new URL(readback.body.images[0].url);assert.equal(signed.hostname,'127.0.0.1');
  const downloaded=await fetch(signed);assert.equal(downloaded.status,200);assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())),hash(expected));
  const ownGet=await api(user,`/api/work-orders/${order.id}/attachments`);assert.equal(ownGet.status,403,'Own Pending upload must not broaden GET');
  const other=users.find(u=>['housekeeping','front_desk'].includes(u.role)&&u.id!==user.id);
  const upload=new FormData();upload.set('photo',new Blob([wrong],{type:'image/png'}),'denied.png');
  const denied=await api(other,`/api/work-orders/${order.id}/attachments`,'POST',upload);assert.equal(denied.status,403);
  const {client}=await clientFor(user);
  const direct=await client.storage.from('asset-documentation').download(path);assert.ok(direct.error,'Direct authenticated Storage read must not bypass app signing');
  const directUpload=await client.storage.from('asset-documentation').upload(prefix+'/'+randomUUID()+'.png',wrong,{contentType:'image/png'});assert.ok(directUpload.error,'Direct Storage write must be denied');
  assert.equal((await ok(admin.storage.from('asset-documentation').list(prefix))).length,1);
  results.push({role:user.label,workOrderId:order.id,status:persisted.status,storageObject:path,sha256:hash(bytes),actualBytes:bytes.length,engineeringSignedReadback:true,wrongPhotoAbsent:true,ownPendingGetDenied:true,otherPendingPostDenied:true,directStorageReadWriteDenied:true,passed:true});
 }catch(e){results.push({role:user.label,passed:false,error:String(e)});}
}
// Assert the entire isolated bucket contains exactly the two retained browser uploads.
try{
 const {execFileSync}=await import('node:child_process');
 const count=Number(execFileSync('docker',['exec','supabase_db_cmpri-seven-role-isolated-qa','psql','-U','postgres','-d','postgres','-At','-c',"select count(*) from storage.objects where bucket_id='asset-documentation'"],{encoding:'utf8'}).trim());
 assert.equal(count,2);results.push({phase:'bucket inventory excludes removed and cancelled photos',actualObjects:count,passed:true});
}catch(e){results.push({phase:'bucket inventory',passed:false,error:String(e)});}
report('storage-results.json',results);
