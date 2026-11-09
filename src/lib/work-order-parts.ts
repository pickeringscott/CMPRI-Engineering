/** Local, deterministic suggestions only. No supplier, AI or web requests. */
export const PART_STATUSES = ["In-House", "Need to Order", "On Order", "Received"] as const;
export type PartStatus = typeof PART_STATUSES[number];
export type SupplyItem = { id: string; item_name: string; description?: string; quantity_on_hand: number; quantity_reserved: number; unit_of_measure: string };
export type TicketPart = { id: string; name: string; inventory_item_id: string | null; requested_status: "In-House" | "Need to Order"; po_line_id: string | null; order_idea_id: string | null; quantity: number; revision: number; status: PartStatus };
const aliases: Record<string,string> = { bulbs:"light", bulb:"light", lamp:"light", lamps:"light", lights:"light", lighting:"light", led:"light", faucet:"tap", faucets:"tap", taps:"tap", leaking:"leak", leaks:"leak", refrigerator:"fridge", filters:"filter", screws:"screw", batteries:"battery", hoses:"hose", toilets:"toilet", conditioners:"hvac", conditioner:"hvac", ac:"hvac", ptac:"hvac", vtac:"hvac" };
const ignored = new Set(["a","an","the","is","are","in","of","for","to","on","and","room","part","parts","replacement","replace","needed","need","used","order","ordered","not","out","working"]);
export function partWords(text: string) { return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>!ignored.has(w)).map(w=>aliases[w]||w))]; }
export function suggestedSupplies(items: SupplyItem[], issue: string, part = "") {
  const words = new Set(partWords(part || issue));
  return items.map(item=>({item,score:partWords(`${item.item_name} ${item.description||""}`).filter(w=>words.has(w)).length}))
    .filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.item.item_name.localeCompare(b.item.item_name)).map(row=>row.item);
}
export function exactSupply(items: SupplyItem[], name: string) {
  const normalized = (s:string)=>s.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g," ").trim();
  const matches=items.filter(item=>normalized(item.item_name)===normalized(name));
  return matches.length===1?matches[0]:undefined;
}
export function partsMentionedInNotes(notes: string): string[] {
  const found=new Set<string>();
  for(const raw of notes.split("\n")) {
    // Only note text, never attribution/role metadata. Generated ledger notes aren't new suggestions.
    const text=raw.startsWith("CMPRI")?raw.split("|").slice(raw.startsWith("CMPRI2|")?5:4).join("|"):raw;
    if(/\[Parts\]|\[Supply use\]|\[Order idea\]|\[PO\]/i.test(text)) continue;
    for(const clause of text.split(/[.;\n]/)) {
      if(/\b(?:do not|don.t|dont|never|avoid|no need to|not needed|no parts|no supplies|without)\b/i.test(clause))continue;
      const match=clause.match(/(?:\b(?:need(?:s)?|require(?:s)?|order(?:ed|ing)?|use(?:d)?|replac(?:e|ed|ing)|install(?:ed)?)\s+(?:to\s+order[:\s]+)?(?:a\s+|an\s+|the\s+|some\s+|\d+\s+)?(.+)|^\s*(.+?)\s+(?:is\s+|are\s+)?(?:needed|on order)\b)/i);
      const name=(match?.[1]||match?.[2]||"").replace(/\s+(?:for|in|from)\s+.*$/i,"").trim();
      if(name.length>=3&&name.length<=120&&!/\b(call|check|inspect|verify|return|repair|fix)\b/i.test(name))found.add(name);
    }
  }
  return [...found];
}
function stockUnits(value: number|string) {
  const [mantissa,exponent="0"]=String(value).toLowerCase().split("e");
  const [whole,fraction=""]=mantissa.split(".");
  const shift=24+Number(exponent)-fraction.length;
  const digits=BigInt(whole+fraction);
  return shift>=0?digits*BigInt(10)**BigInt(shift):digits/BigInt(10)**BigInt(-shift);
}
export function linkedPartStatus(part: {requested_status: "In-House"|"Need to Order";po_line_id: string|null;quantity?:number;inventory_item_id?:string|null}, line?: {order_id:string;inventory_item_id?:string|null}, order?:{acceptance:string;cancelled:boolean;origin?:string}, received:number|string=0): PartStatus {
  if(part.po_line_id&&line&&part.inventory_item_id!==undefined&&line.inventory_item_id!==undefined&&part.inventory_item_id!==line.inventory_item_id)return "Need to Order";
  if(part.po_line_id&&line&&order){
    if(stockUnits(received)>=stockUnits(part.quantity||1))return "Received";
    if(!order.cancelled&&(order.acceptance==="accepted"||order.origin==="manual"))return "On Order";
  }
  return part.po_line_id?"Need to Order":part.requested_status;
}
