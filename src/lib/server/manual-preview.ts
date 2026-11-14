/** Opt-in guard for captured/read-only reviews; ordinary previews use live behavior. */
export function manualPreviewReadOnly() {
  return process.env.CMPRI_MANUAL_PREVIEW_READ_ONLY === '1';
}

const readRpcs=new Set(['cmpri_consolidation_ready','cmpri_list_asset_files','cmpri_import_stored_pdfs','cmpri_inventory_snapshot','cmpri_work_order_dashboard_counts']);
export function manualPreviewFetch(native: typeof fetch = fetch): typeof fetch {
  return async (input,init)=>{
    const request=new Request(input,init), url=new URL(request.url);
    const rpc=url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/);
    const signed=url.pathname.startsWith('/storage/v1/object/sign/');
    const allowed=rpc ? readRpcs.has(rpc[1]) : ['GET','HEAD'].includes(request.method) || (signed&&request.method==='POST');
    if(!allowed)return Response.json({error:'This preview is read-only. No live record was changed.',code:'PREVIEW_READ_ONLY'},{status:403});
    return native(request);
  };
}
