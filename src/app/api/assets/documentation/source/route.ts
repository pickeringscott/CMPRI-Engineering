import {NextResponse,type NextRequest} from 'next/server';
import {createHash} from 'node:crypto';
import {requireUser} from '@/lib/server/auth';
import {allows} from '@/lib/server/access';
import {HOTEL_ID} from '@/lib/constants';
import {isUuid} from '@/lib/uuid';
import {listRegisteredAssetFiles} from '@/lib/server/asset-file-register';
import {eligibleManualLinks} from '@/lib/manual-applicability';
import {withStoredPdfStatus} from '@/lib/server/stored-pdf-status';

export const runtime='nodejs';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store',Vary:'Authorization'};
export async function GET(request:NextRequest){
  const auth=await requireUser(request);
  if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
  if(auth.principal.hotelId!==HOTEL_ID || !['view_work_orders','view_dashboard','view_pm'].every(c=>allows(auth.principal,c as 'view_pm')))return NextResponse.json({error:'Manual reference access is required.'},{status:403,headers});
  const assetId=request.nextUrl.searchParams.get('assetId')||'',fileId=request.nextUrl.searchParams.get('fileId')||'',sha=request.nextUrl.searchParams.get('sha256')||'';
  if(!isUuid(assetId)||!isUuid(fileId)||!/^[a-f0-9]{64}$/.test(sha))return NextResponse.json({error:'A current asset, registered file, and fingerprint are required.'},{status:400,headers});
  try{
    const readAsset=()=>auth.admin.from('assets').select('id,hotel_id,active,manufacturer,model_family,model_number,serial_number,pdf_import_links').eq('hotel_id',HOTEL_ID).eq('id',assetId).maybeSingle();
    const asset=await readAsset(),files=await listRegisteredAssetFiles(auth.admin,assetId);
    if(asset.error||files.error)throw Error('Manual source could not be checked.');
    if(!asset.data||asset.data.active===false)return NextResponse.json({error:'The asset is unavailable.'},{status:404,headers});
    const file=files.data.find(f=>f.id===fileId),eligible=eligibleManualLinks(asset.data,asset.data.pdf_import_links||[]).eligible;
    const link=file&&eligible.find(l=>l.object_id===file.id&&l.storage_path===file.storage_path&&l.sha256===sha);
    if(!file||!link||!/\.pdf$/i.test(file.name))return NextResponse.json({error:'The manual association changed. Reload the guide.'},{status:409,headers});
    const status=(await withStoredPdfStatus(auth.admin,[file]))[0];
    if(status.catalog_status==='content_mismatch'&&!link.quarantine_acknowledged)return NextResponse.json({error:'The source requires review.'},{status:409,headers});
    if(file.storage_path.includes('://')||file.storage_path.split('/').includes('..')||!(file.storage_path.startsWith(HOTEL_ID+'/')||/^Asset Docs\//i.test(file.storage_path)))throw Error('Invalid source path.');
    const stored=await auth.admin.storage.from('asset-documentation').download(file.storage_path);
    if(stored.error||!stored.data||stored.data.size>100*1024*1024)throw Error('The original source is unavailable.');
    const bytes=new Uint8Array(await stored.data.arrayBuffer());
    if(bytes.length<5||Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-'||createHash('sha256').update(bytes).digest('hex')!==sha)return NextResponse.json({error:'The original changed. Reload the guide.'},{status:409,headers});
    const after=await readAsset(),registered=await listRegisteredAssetFiles(auth.admin,assetId);
    if(after.error||registered.error||JSON.stringify(after.data)!==JSON.stringify(asset.data)||JSON.stringify(registered.data)!==JSON.stringify(files.data))return NextResponse.json({error:'The source changed while opening. Reload the guide.'},{status:409,headers});
    if(request.nextUrl.searchParams.get('format')==='pdf'){
      // Stream only after the fingerprint and current association are checked.
      // Original manuals can exceed the hosting platform's buffered-body limit.
      let offset=0;
      const stream=new ReadableStream<Uint8Array>({pull(controller){
        if(request.signal?.aborted){controller.error(new Error('The source request was cancelled.'));return;}
        const end=Math.min(offset+64*1024,bytes.length);
        controller.enqueue(bytes.subarray(offset,end));offset=end;
        if(offset===bytes.length)controller.close();
      }});
      return new Response(stream,{headers:{...headers,'Content-Type':'application/pdf','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
    }
    const signed=await auth.admin.storage.from('asset-documentation').createSignedUrl(file.storage_path,120);
    if(signed.error||!signed.data?.signedUrl)throw Error('The original could not be opened.');
    return NextResponse.json({url:signed.data.signedUrl},{headers});
  }catch{return NextResponse.json({error:'The original source could not be checked. Retry opening it.'},{status:503,headers});}
}
