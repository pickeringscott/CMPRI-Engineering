import {createHash} from 'node:crypto';
export async function inspectPoPdf(bytes:Uint8Array){
 if(bytes.length>10*1024*1024||Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw Error('Choose a PDF up to 10 MB.');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:bytes.slice()});
 try{const pdf=await task.promise;if(pdf.numPages>50)throw Error('PO PDF exceeds 50 pages.');const pages:{page:number;text:string}[]=[];let length=0;
 for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('');length+=text.length;if(length>300000)throw Error('PO PDF text exceeds limit.');pages.push({page:i,text});page.cleanup();}
 return {sha256:createHash('sha256').update(bytes).digest('hex'),pages,reviewRequired:true,reason:pages.some(p=>p.text.trim())?'Review the original PDF and line quantities before import.':'Image-only PDF: source review/OCR required; no quantities inferred.',persisted:0};
 }finally{await task.destroy();}
}

