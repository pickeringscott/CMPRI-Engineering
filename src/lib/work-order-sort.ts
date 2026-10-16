export type WorkOrderSort = 'created-newest' | 'created-oldest' | 'due-earliest' | 'due-latest';
type DatedOrder = {id:string;created_at?:string|null;due_by?:string|null};
const timestamp=(value?:string|null)=>{const n=value?Date.parse(value):NaN;return Number.isFinite(n)?n:null;};
/** Missing dates stay last in both directions; IDs make equal timestamps deterministic. */
export function sortWorkOrders<T extends DatedOrder>(orders:readonly T[],sort:WorkOrderSort):T[]{
 const field=sort.startsWith('due-')?'due_by':'created_at';
 const direction=sort==='created-newest'||sort==='due-latest'?-1:1;
 return [...orders].sort((a,b)=>{
  const left=timestamp(a[field]),right=timestamp(b[field]);
  if(left===null&&right!==null)return 1;if(right===null&&left!==null)return -1;
  if(left!==null&&right!==null&&left!==right)return (left-right)*direction;
  return a.id<b.id?-1:a.id>b.id?1:0;
 });
}
