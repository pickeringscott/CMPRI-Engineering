const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const LEVELS = ['Personally performed','Assisted','Not done'];
function text(value, max, optional=false) {
  return typeof value==='string' && (optional || value.trim().length>0) && value.length<=max;
}
function uniqueAllowed(value, allowed) {
  return Array.isArray(value) && value.length>0 && value.length<=allowed.length && new Set(value).size===value.length && value.every(v=>allowed.includes(v));
}
export function validateEmployment(body) {
  if(!body || typeof body!=='object' || Array.isArray(body)) return {ok:false};
  body={...body,department:body.department??'maintenance'};
  if(!['maintenance','front'].includes(body.department)) return {ok:false};
  if(!body || typeof body!=='object' || Array.isArray(body)) return {ok:false};
  if(!text(body.name,120)||!text(body.email,180)||!/^\S+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())||!text(body.phone,30,true)||!(body.phone===''||/^\(\d{3}\) \d{3}-\d{4}$/.test(body.phone))||!text(body.history,1500)||!text(body.example,1500)||!uniqueAllowed(body.workingDays,DAYS))return {ok:false};
  if(!body.skills || Object.keys(body.skills).length!==(body.department==='front'?3:4) || !(body.department==='front'?['guests','systems','payments']:['hvac','plumbing','electrical','appliances']).every(key=>LEVELS.includes(body.skills[key]))) return {ok:false};
  if(!body.interview || typeof body.interview!=='object'||Array.isArray(body.interview)||!uniqueAllowed(Object.keys(body.interview),DAYS)||!Object.values(body.interview).every(v=>uniqueAllowed(v,['AM','PM'])))return {ok:false};
  return {ok:true,value:{department:body.department,name:body.name.trim(),email:body.email.trim(),phone:body.phone,history:body.history.trim(),example:body.example.trim(),workingDays:[...body.workingDays],skills:{...body.skills},interview:Object.fromEntries(Object.entries(body.interview).map(([day,periods])=>[day,[...periods]]))}};
}
