import {readFileSync} from 'node:fs';

export function scannedPdf(){
 const jpeg=readFileSync(new URL('./scanned-page.jpg',import.meta.url));
 const content='q 700 0 0 200 0 0 cm /Im0 Do Q';
 const parts=[Buffer.from('%PDF-1.4\n')],offsets=[0];let size=parts[0].length;
 const add=(id,body)=>{offsets[id]=size;const head=Buffer.from(`${id} 0 obj\n`),tail=Buffer.from('\nendobj\n');parts.push(head,body,tail);size+=head.length+body.length+tail.length;};
 add(1,Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));add(2,Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));add(3,Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
 add(4,Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]));add(5,Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`));
 const xref=size;parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));return new Uint8Array(Buffer.concat(parts));
}
