import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {api,users,out,admin,ok,report} from './client.mjs';
const results=[],drafts=[];
try{
 for(const user of users){
  const response=await api(user,'/api/work-orders/drafts','POST',{location_id:user.fixtures[0].location_id,issue:'Own draft '+user.role,notes:'Borrador privado — sin traducir.'});
  assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.body.draft.created_by,user.id);
  drafts.push(response.body.draft);
 }
 writeFileSync(new URL('draft-fixtures.json',out),JSON.stringify(drafts));
 for(const user of users){
  try{
   const own=drafts.find(d=>d.created_by===user.id),other=drafts.find(d=>d.created_by!==user.id);
   for(const suffix of ['', '?scope=own']){
    const r=await api(user,'/api/work-orders/drafts'+suffix);
    assert.equal(r.status,200);assert.deepEqual(r.body.drafts.map(d=>d.id),[own.id]);
   }
   const reviewer=user.role==='chief_engineer';
   const review=await api(user,'/api/work-orders/drafts?scope=review');
   assert.equal(review.status,reviewer?200:403);
   if(reviewer)assert.deepEqual(new Set(review.body.drafts.map(d=>d.id)),new Set(drafts.map(d=>d.id)));
   const explicit=await api(user,'/api/work-orders/drafts?scope=own&review_draft_id='+other.id);
   assert.equal(explicit.status,reviewer?200:403);
   if(reviewer){assert.equal(explicit.body.review_draft.id,other.id);assert.equal(explicit.body.review_draft.notes,other.notes);assert.deepEqual(explicit.body.drafts.map(d=>d.id),[own.id]);}
   if(!reviewer){
    const denied=await api(user,'/api/work-orders/drafts','PATCH',{id:other.id,expected_revision:other.revision,notes:'Unauthorized edit'});
    assert.equal(denied.status,403);
    const persisted=await ok(admin.from('cmpri_work_order_drafts').select('notes').eq('id',other.id).single());assert.equal(persisted.notes,other.notes);
   }
   results.push({role:user.label,ownOnly:true,explicitReview:reviewer,otherDraftEditDenied:!reviewer,passed:true});
  }catch(e){results.push({role:user.label,passed:false,error:String(e)});}
 }
}catch(e){results.push({phase:'create synthetic drafts',passed:false,error:String(e)});}
report('draft-results.json',results);
