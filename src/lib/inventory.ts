/** Inventory rules and matching are deterministic and run without AI or external services. */
export const INVENTORY_TYPES = ['Chemical','Part','Supply'] as const;
export const STOCK_UNITS = ['EA','LB','OZ','G','KG','GAL','L','ML','FLOZ'] as const;
export type InventoryType = typeof INVENTORY_TYPES[number];
export type InventoryItem = {id:string;item_name:string;item_type:InventoryType;inventory_revision:number;storage_location_id:string|null;storage_location:string;preferred_vendor_id?:string|null;manufacturer?:string;vendor_sku?:string;description?:string;unit_of_measure:string;quantity_on_hand:number;quantity_reserved:number;reorder_level?:number|null;suggested_order_quantity?:number|null;current_unit_cost?:number|null;active?:boolean;unit_locked?:boolean};
export type InventoryLocation = {id:string;name:string;room_number?:string|null;area?:string|null;active?:boolean};
export type StockNote = {id:string;inventory_item_id:string;recorded_at:string;actor_name:string;actor_role:string;kind:string;message:string;quantity_before:number|null;quantity_after:number|null;reserved_before:number|null;reserved_after:number|null;unit:string|null;work_order_id:string|null;pool_log_id:string|null;po_order_id:string|null;source_date:string|null};
export type InventoryIdea = {id:string;inventory_item_id?:string|null;asset_id?:string|null;work_order_id?:string|null;item_text:string;quantity?:number|null;status:string;source:string;created_at:string;po_line_id?:string|null;notes?:string};
export type PoOption = {id:string;order_id:string;inventory_item_id:string;label:string};
export type InventoryResult = {inventory_item?:InventoryItem;idea?:InventoryIdea;compatibility?:{asset_id:string;inventory_item_id:string}|null;note?:StockNote|null;replayed?:boolean};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const normalizedUnit=(value:string)=>value.toUpperCase()==='EACH'?'EA':value.toUpperCase();
export const normalizeInventoryText=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g,' ');
export function matchingInventory(items:InventoryItem[],draft:Partial<InventoryItem>) {
 return items.find(item=>item.id!==draft.id&&normalizeInventoryText(item.item_name)===normalizeInventoryText(draft.item_name||'')
  &&normalizeInventoryText(item.manufacturer||'')===normalizeInventoryText(draft.manufacturer||'')
  &&normalizeInventoryText(item.vendor_sku||'')===normalizeInventoryText(draft.vendor_sku||'')
  &&(item.preferred_vendor_id||null)===(draft.preferred_vendor_id||null)&&normalizedUnit(item.unit_of_measure)===normalizedUnit(draft.unit_of_measure||''));
}
export function validStockCount(value:unknown,unit:string) {
 return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=999999999&&Math.abs(value*1000-Math.round(value*1000))<0.0001&&(normalizedUnit(unit)!=='EA'||Number.isInteger(value));
}
export function inventoryUnitOptions(unit:string) {
 const base=normalizedUnit(unit);return ['LB','OZ','G','KG'].includes(base)?['LB','OZ','G','KG']:['GAL','L','ML','FLOZ'].includes(base)?['GAL','L','ML','FLOZ']:[base];
}
export function inventoryRequest(body:Record<string,unknown>,method:'POST'|'PATCH') {
 if(typeof body.request_id!=='string'||!uuid.test(body.request_id))throw Error('A stable inventory save ID is required. Reload the updated inventory form.');
 const action=method==='POST'?'create':String(body.action||'edit');
 if(!['create','edit','adjust','return'].includes(action))throw Error('Invalid inventory action.');
 const item=action==='create'?null:body.id;
 if(item!==null&&(typeof item!=='string'||!uuid.test(item)))throw Error('Choose an inventory item.');
 if(action!=='create'&&(!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<1))throw Error('Refresh the item before saving.');
 const data:Record<string,unknown>={reason:body.reason??''};
 if(typeof data.reason!=='string'||data.reason.length>2000)throw Error('Enter a reason up to 2000 characters.');
 if(action==='adjust'||action==='return') {
  if(typeof body.quantity!=='number'||!Number.isFinite(body.quantity)||body.quantity<0||body.quantity>999999999||(action==='return'&&body.quantity<=0)||!data.reason.trim())throw Error('Enter the physical quantity and a reason.');
  data.quantity=body.quantity;
 }else{
  if(typeof body.item_name!=='string'||!body.item_name.trim()||body.item_name.length>300||!INVENTORY_TYPES.includes(body.item_type as InventoryType))throw Error('Enter item name and type.');
  if(typeof body.unit_of_measure!=='string'||!STOCK_UNITS.includes(normalizedUnit(body.unit_of_measure) as typeof STOCK_UNITS[number]))throw Error('Choose the stock unit.');
  if(typeof body.storage_location_id!=='string'||!uuid.test(body.storage_location_id))throw Error('Choose a managed Storage Location.');
  for(const key of ['manufacturer','vendor_sku','description'])if(body[key]!=null&&(typeof body[key]!=='string'||String(body[key]).length>(key==='description'?3000:200)))throw Error('Item details are too long.');
  for(const key of ['preferred_vendor_id','compatible_asset_id'])if(body[key]!=null&&(typeof body[key]!=='string'||!uuid.test(String(body[key]))))throw Error('Choose valid vendor/equipment references.');
  for(const key of ['reorder_level','suggested_order_quantity','current_unit_cost'])if(body[key]!=null&&(typeof body[key]!=='number'||!Number.isFinite(body[key])||Number(body[key])<0||Number(body[key])>999999999||(key==='suggested_order_quantity'&&body[key]===0)))throw Error('Enter valid cost and reorder quantities.');
  for(const key of ['item_name','item_type','storage_location_id','preferred_vendor_id','manufacturer','vendor_sku','description','compatible_asset_id','reorder_level','suggested_order_quantity','current_unit_cost'])data[key]=body[key]??null;
  data.unit_of_measure=normalizedUnit(body.unit_of_measure);
  if(action==='create'){
   if(!validStockCount(body.quantity_on_hand,String(data.unit_of_measure))||(Number(body.quantity_on_hand)>0&&!data.reason.trim()))throw Error('Enter a valid opening count and its count note. Each requires whole counts.');
   data.quantity_on_hand=body.quantity_on_hand;
  }
 }
 return {requestId:body.request_id,action,item:item as string|null,data,expected:action==='create'?null:Number(body.expected_revision)};
}

/** A slower snapshot cannot replace a locally confirmed newer inventory revision. */
export function mergeInventorySnapshot(current:InventoryItem[],incoming:InventoryItem[]) {
 const known=new Map(current.map(item=>[item.id,item]));
 const ids=new Set(incoming.map(item=>item.id));
 return [...incoming.map(item=>{const previous=known.get(item.id);return previous&&Number(previous.inventory_revision)>Number(item.inventory_revision)?previous:item;}),...current.filter(item=>!ids.has(item.id))];
}
