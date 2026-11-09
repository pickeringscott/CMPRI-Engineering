import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";
import { HOTEL_ID } from "@/lib/constants";
import { isUuid } from "@/lib/uuid";
import { fetchAllPages } from "@/lib/server/paginated-query";

export async function GET(request: NextRequest, {params}: {params: Promise<{id:string}>}) {
  const auth=await requireCapability(request,"manage_assets");
  if(!auth)return NextResponse.json({error:"Parts-management permission required."},{status:403});
  if(process.env.CMPRI_PO_ENABLED!=="true")return NextResponse.json({error:"Supply receiving and usage are not enabled."},{status:409});
  const {id}=await params;
  if(!isUuid(id))return NextResponse.json({error:"Invalid work order."},{status:400});
  const job=await auth.admin.from("work_orders").select("id").eq("hotel_id",HOTEL_ID).eq("id",id).maybeSingle();
  if(job.error)return NextResponse.json({error:"Work order could not be checked."},{status:503});
  if(!job.data)return NextResponse.json({error:"Work order unavailable."},{status:404});
  const [items,context,lines,orders]=await Promise.all([
    fetchAllPages((from,to)=>auth.admin.from("cmpri_inventory_items").select("id,item_name,description,quantity_on_hand,quantity_reserved,unit_of_measure").eq("hotel_id",HOTEL_ID).eq("active",true).order("id").range(from,to)),
    auth.admin.rpc("cmpri_read_ticket_parts",{p_hotel:HOTEL_ID,p_job:id}),
    fetchAllPages((from,to)=>auth.admin.from("cmpri_po_lines").select("id,order_id,description,inventory_item_id,ordered,uom").eq("hotel_id",HOTEL_ID).order("id").range(from,to)),
    fetchAllPages((from,to)=>auth.admin.from("cmpri_po_orders").select("id,supplier,external_reference,acceptance,cancelled,origin").eq("hotel_id",HOTEL_ID).order("id").range(from,to)),
  ]);
  if([items,context,lines,orders].some(r=>r.error))return NextResponse.json({error:"Parts or purchasing records could not be loaded completely."},{status:503});
  const totals=(context.data?.receiptTotals||[]) as Array<{line_id:string;received:string}>;
  const poLines=(lines.data||[]).map(line=>({...line,order:orders.data?.find(order=>order.id===line.order_id),received:totals.find(total=>total.line_id===line.id)?.received||"0"}));
  return NextResponse.json({items:items.data,parts:context.data?.parts||[],poLines},{headers:{"Cache-Control":"private, no-store"}});
}

export async function POST(request: NextRequest, {params}: {params: Promise<{id:string}>}) {
  const auth=await requireCapability(request,"manage_assets");
  if(!auth)return NextResponse.json({error:"Parts-management permission required."},{status:403});
  if(process.env.CMPRI_PO_ENABLED!=="true")return NextResponse.json({error:"Supply receiving and usage are not enabled."},{status:409});
  const {id}=await params; const body=await request.json().catch(()=>null);
  if(!isUuid(id)||!body||!isUuid(body.id)||typeof body.name!=="string"||!body.name.trim()||body.name.length>500
    ||(body.item!==null&&!isUuid(body.item))||(body.po_line!==null&&!isUuid(body.po_line))
    ||!["In-House","Need to Order"].includes(body.status)||typeof body.quantity!=="number"||!Number.isFinite(body.quantity)||body.quantity<=0||body.quantity>999999
    ||!Number.isSafeInteger(body.expected_revision)||body.expected_revision<0){
    return NextResponse.json({error:"Select a part, quantity and status. On Order and Received follow linked PO records."},{status:400});
  }
  const result=await auth.admin.rpc("cmpri_save_ticket_part",{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_id:body.id,p_job:id,p_name:body.name.trim(),p_item:body.item,p_status:body.status,p_quantity:body.quantity,p_line:body.po_line,p_revision:body.expected_revision});
  if(result.error)return NextResponse.json({error:result.error.message},{status:/^(P0001|22|23)/.test(result.error.code||"")?409:503});
  return NextResponse.json({id:result.data},{headers:{"Cache-Control":"no-store"}});
}
