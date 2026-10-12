export class Blocked extends Error {}
export class HardStop extends Error {}
export function requirePrerequisite(condition,message) { if(!condition) throw new Blocked(message); }
export function failed(error,fields={}) {
 return {...fields,status:error instanceof Blocked?'BLOCKED':'FAIL',passed:false,errorType:error.constructor.name,error:String(error)};
}
export function classified(results) {
 return results.map(row=>({...row,...(!['PASS','FAIL','BLOCKED'].includes(row.status)?{httpStatus:typeof row.status==='number'?row.status:undefined,workOrderStatus:typeof row.status==='string'?row.status:undefined,status:row.passed===true?'PASS':'FAIL'}:{})}));
}
