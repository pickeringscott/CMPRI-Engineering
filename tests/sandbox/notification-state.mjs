import {failed,requirePrerequisite} from './outcomes.mjs';
import assert from 'node:assert/strict';
import {api,users,admin,ok,report,hotel} from './client.mjs';
const results=[];
for(const user of users){
 try{
  const eligible=['chief_engineer','technician'].includes(user.role);
  const r=await api(user,'/api/dashboard/notifications');
  if(['housekeeping','front_desk'].includes(user.role)){assert.equal(r.status,403);}
  else{
   assert.equal(r.status,200);
   if(!eligible)assert.ok(r.body.notifications.every(n=>!n.work_order_id),'Manager roles must not receive ordinary work-order notifications');
   else assert.ok(r.body.notifications.some(n=>n.work_order_id),'Real submitted ticket events must reach technical inboxes');
  }
  results.push({phase:'dashboard notification eligibility and event generation',role:user.label,status:r.status,ordinaryCount:r.body.notifications?.filter(n=>n.work_order_id).length??0,passed:true});
 }catch(e){results.push({role:user.label,phase:'inbox eligibility',passed:false,error:String(e)});}
}
try{
 const technical=users.filter(u=>['chief_engineer','technician'].includes(u.role));
 const order=(await ok(admin.from('work_orders').select('id').limit(1)))[0];
 requirePrerequisite(order,'At least one persisted work order required for read/clear isolation');
 const key='synthetic-read-clear-isolation';
 await ok(admin.from('cmpri_dashboard_notifications').insert(technical.map(u=>({hotel_id:hotel,recipient_user_id:u.id,notification_key:key,work_order_id:order.id,message:'Synthetic read/clear boundary',recorded_at:new Date().toISOString()}))));
 const chief=technical.find(u=>u.role==='chief_engineer'),tech=technical.find(u=>u.role==='technician');
 for(const action of ['read','clear']){
  const r=await api(chief,'/api/dashboard/notifications','POST',{action,ids:[key]});assert.equal(r.status,200);
  const rows=await ok(admin.from('cmpri_dashboard_notifications').select('recipient_user_id,read_at,cleared_at').eq('notification_key',key));
  assert.ok(rows.find(r=>r.recipient_user_id===chief.id)[action==='read'?'read_at':'cleared_at']);
  const other=rows.find(r=>r.recipient_user_id===tech.id);assert.equal(other.read_at,null);assert.equal(other.cleared_at,null);
 }
 const reload=await api(chief,'/api/dashboard/notifications');assert.equal(reload.status,200);assert.ok(!reload.body.notifications.some(n=>n.id===key));
 results.push({phase:'persisted read/clear, recipient isolation and reload',passed:true});
}catch(e){results.push(failed(e,{phase:'read/clear persistence'}));}
report('notification-state-results.json',results);
