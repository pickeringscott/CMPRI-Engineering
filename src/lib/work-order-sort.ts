import {loyaltyRank} from "./loyalty-tier";
export type WorkOrderSort = 'default' | 'tier-high' | 'tier-low' | 'created-newest' | 'created-oldest' | 'due-earliest' | 'due-latest';
type DatedOrder = {id:string;status?:string|null;loyalty_tier?:unknown;created_at?:string|null;due_by?:string|null};
const timestamp=(value?:string|null)=>{const n=value?Date.parse(value):NaN;return Number.isFinite(n)?n:null;};
/** Missing dates stay last in both directions; IDs make equal timestamps deterministic. */
export function sortWorkOrders<T extends DatedOrder>(orders:readonly T[],sort:WorkOrderSort):T[]{
 if(sort==='default'||sort.startsWith('tier-'))return [...orders].sort((a,b)=>{
  if(sort==='default'){
   const rank=(status?:string|null)=>{const n=['Pending Verification','Open','In Progress','Completed','Closed','Will Not Do'].indexOf(status==='Done'?'Completed':String(status));return n<0?99:n};
   const delta=rank(a.status)-rank(b.status);if(delta)return delta;
  }else{const x=loyaltyRank(a.loyalty_tier),y=loyaltyRank(b.loyalty_tier);if(!x||!y){if(x!==y)return x?-1:1}else if(x!==y)return (x-y)*(sort==='tier-high'?-1:1);}
  const d=(timestamp(b.created_at)||0)-(timestamp(a.created_at)||0);return d||a.id.localeCompare(b.id);
 });
 const field=sort.startsWith('due-')?'due_by':'created_at';
 const direction=sort==='created-newest'||sort==='due-latest'?-1:1;
 return [...orders].sort((a,b)=>{
  const left=timestamp(a[field]),right=timestamp(b[field]);
  if(left===null&&right!==null)return 1;if(right===null&&left!==null)return -1;
  if(left!==null&&right!==null&&left!==right)return (left-right)*direction;
  return a.id<b.id?-1:a.id>b.id?1:0;
 });
}
