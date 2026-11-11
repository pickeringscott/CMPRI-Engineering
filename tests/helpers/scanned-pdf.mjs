import {createCanvas} from '@napi-rs/canvas';

export function scannedPdf(){
 const canvas=createCanvas(1400,400),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1400,400);ctx.fillStyle='black';ctx.font='bold 55px sans-serif';ctx.fillText('NO HOT WATER',40,90);ctx.font='40px sans-serif';ctx.fillText('1. Check the water supply valve.',40,170);ctx.fillText('2. Inspect the water filter.',40,245);const jpeg=canvas.toBuffer('image/jpeg');
 const content='q 700 0 0 200 0 0 cm /Im0 Do Q';
 const parts=[Buffer.from('%PDF-1.4\n')],offsets=[0];let size=parts[0].length;
 const add=(id,body)=>{offsets[id]=size;const head=Buffer.from(`${id} 0 obj\n`),tail=Buffer.from('\nendobj\n');parts.push(head,body,tail);size+=head.length+body.length+tail.length;};
 add(1,Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));add(2,Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));add(3,Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
 add(4,Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]));add(5,Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`));
 const xref=size;parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));return new Uint8Array(Buffer.concat(parts));
}
