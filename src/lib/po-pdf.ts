import {createHash} from 'node:crypto';
import {parseOfflinePoPages,type PdfCell} from './po-offline-pdf';
export async function inspectPoPdf(bytes:Uint8Array){
 if(bytes.length>100*1024*1024||Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw Error('Choose a PDF up to 100 MB.');
 const original=await extractPoPdf(bytes);
 if(original.offlineOrder)return original;
 // Some iBuy printers place complete columns outside the Letter MediaBox.
 // Widen only the in-memory extraction bounds, never text or original bytes.
 // Equal-length replacement preserves PDF cross-reference offsets.
 const raw=Buffer.from(bytes).toString('latin1');
 const expanded=raw.replace(/\/MediaBox \[0 0 612 792\]/g,'/MediaBox [0 0 999 792]');
 if(expanded!==raw){
  const recovered=await extractPoPdf(new Uint8Array(Buffer.from(expanded,'latin1')));
  if(recovered.offlineOrder)return {...recovered,sha256:original.sha256,extraction:'expanded-page-bounds' as const};
 }
 return original;
}
async function extractPoPdf(bytes:Uint8Array){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:bytes.slice(),verbosity:0});
 try{const pdf=await task.promise;if(pdf.numPages>50)throw Error('PO PDF exceeds 50 pages.');const pages:{page:number;text:string}[]=[],cells:PdfCell[][]=[];let length=0;
 for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('');length+=text.length;if(length>300000)throw Error('PO PDF text exceeds limit.');pages.push({page:i,text});page.cleanup();}
 for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();cells.push(content.items.flatMap(item=>'str' in item&&item.str.trim()?[{text:item.str.trim(),x:item.transform[4],y:item.transform[5],width:item.width}]:[]));page.cleanup();}
 return {sha256:createHash('sha256').update(bytes).digest('hex'),pages,offlineOrder:parseOfflinePoPages(cells),reviewRequired:true,reason:pages.some(p=>p.text.trim())?'Review the original PDF and line quantities before import.':'Image-only PDF: source review/OCR required; no quantities inferred.',persisted:0};
 }finally{await task.destroy();}
}

