type ReviewLine={order_id:string;description:string;ordered:number;inventory_item_id:string|null;units_per_order_unit:number|null};
type ReviewItem={id:string;active:boolean};
export function poLineNeedsReview(line:ReviewLine,items:ReviewItem[]) {
 const name=line.description.trim();
 const missingName=!name||/^https?:\/\/\S+$/i.test(name)||/^\d+(?:\.\d+)?\s*(?:in(?:ch(?:es)?)?|ft|feet|mm|cm|m|["′″'])?$/i.test(name);
 return missingName||!Number.isFinite(Number(line.ordered))||Number(line.ordered)<=0||!line.inventory_item_id||!items.some(i=>i.id===line.inventory_item_id&&i.active)||!Number.isFinite(Number(line.units_per_order_unit))||Number(line.units_per_order_unit)<=0;
}
export function poHasUnresolvedLines(orderId:string,lines:ReviewLine[],items:ReviewItem[]) {
 return lines.some(line=>line.order_id===orderId&&poLineNeedsReview(line,items));
}
