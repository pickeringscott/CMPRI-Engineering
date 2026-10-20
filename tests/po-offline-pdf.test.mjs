import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseOfflinePoPages,reconcileOfflineDocuments} from '../src/lib/po-offline-pdf.ts';
import {inspectPoPdf} from '../src/lib/po-pdf.ts';
import {emptyImportPlan,planPoBatch} from '../src/lib/po-evidence.ts';
import {offlinePoSourceLinks} from '../src/lib/po-source-links.ts';
import {parsePoSource} from '../src/lib/po-source-parser.ts';
const href='https://www.ibuyefficient.com/webhook/getemailpotransmission?data=opaque%2Bdata&token=opaque%2Ftoken';
const linkedSource={account:'buyer@example.test',id:'email-id',messageAt:'2026-10-16T22:00:00Z',from:'iBuyEfficientOrders@avendra.com',subject:'New PO Submitted',text:`Click here to accept and retrieve this purchase order <${href}>`,html:`<a href="${href.replace('&','&amp;')}">Click here to accept and retrieve this purchase order</a>`};
assert.deepEqual(offlinePoSourceLinks(linkedSource),[{url:href,status:'not-retrieved',kind:'ibuy-offline-pdf'}]);
assert.equal(parsePoSource(linkedSource).sourceDocumentLinks[0].url,href);
assert.equal(parsePoSource(linkedSource).externalPo,undefined); // Opaque tokens are never guessed as PO identities.
for(const url of [href.replace('www.ibuyefficient.com','www.ibuyefficient.com.evil.test'),href.replace('https:','http:'),href.replace('www.','user@www.'),href+'&token=other',href.replace('getemailpotransmission','accept')]){
 assert.deepEqual(offlinePoSourceLinks({text:url}),[]);
}
const cell=(text,x=52,y=700)=>({text,x,y});
function fixture(id='12345678901',name='Product NAME',description='https://www.amazon.com/dp/B000I1VF64?th=1'){
 return [[cell(`Purchase Order #${id}`),cell('Accepted 10/16/2026 2:58:44 PM'),cell('Supplier'),cell('HAWKEYE ORDERING'),cell('PO Type:'),cell('Offline'),cell('Subject:'),cell('Order title'),
 ...['#','Qty','UOM','Item #','Description','GL Code','Price','Total'].map((t,i)=>cell(t,[59.25,80.75,106.5,147.7,272.525,430.7625,500.775,534.875][i],568.25)),
 ...['1','2','EA',name,description,'113280 - Engineering','$23.99','$47.98'].map((t,i)=>cell(t,[59.75,85.25,112,134.5,191.6375,403.2125,501.5375,535.75][i],520)),
 ...['Subtotal','$47.98','Discount','$0.00','Taxes','$0.00','Shipping','$0.00','Grand Total','$47.98'].map(t=>cell(t,410,400))]];
}
const order=parseOfflinePoPages(fixture());assert.equal(order.lines[0].sku,'Product NAME');assert.equal(order.lines[0].quantity,2);
assert.equal(order.lines[0].description,'https://www.amazon.com/dp/B000I1VF64?th=1');
const multi=fixture(),start=multi[0].findIndex(c=>c.text==='Subtotal');
multi[0].splice(start,0,...['2','1','BX','Second product','Non-Amazon description','113280 - Engineering','$2.00','$2.00'].map((t,i)=>cell(t,[59.75,85.25,112,134.5,191.6375,403.2125,501.5375,535.75][i],470)));
for(const label of ['Subtotal','Grand Total'])multi[0][multi[0].findIndex(c=>c.text===label)+1].text='$49.98';
assert.equal(parseOfflinePoPages(multi).lines.length,2);
assert.equal(parseOfflinePoPages(multi).lines[1].uom,'BX');
assert.equal(parseOfflinePoPages(fixture('98765432101','Other product','plain description')).externalPo,'98765432101');
for(const replacement of [['$47.98','$47.97'],['UOM','Units'],['2','0']]){
 const bad=fixture();bad[0].find(c=>c.text===replacement[0]).text=replacement[1];assert.equal(parseOfflinePoPages(bad),null);
}
const source={account:'buyer@example.test',messageId:'source-message',messageAt:'2026-10-16T22:00:00Z',sha256:'a'.repeat(64),order};
const previous=planPoBatch([{account:source.account,messageId:'acceptance',messageAt:source.messageAt,kind:'company-accepted',externalPo:order.externalPo}]);
const recovered=reconcileOfflineDocuments(previous,[source,source]);
assert.equal(recovered.orders.length,1);assert.equal(recovered.orders[0].lines[0].quantity,2);assert.equal(recovered.orders[0].evidence.length,3);
assert.equal(previous.orders[0].lines.length,0);
assert.deepEqual(reconcileOfflineDocuments(recovered,[source]),recovered);
const conflict=structuredClone(source);conflict.messageId='different';conflict.sha256='b'.repeat(64);conflict.order.lines[0].quantity=3;
const held=reconcileOfflineDocuments(recovered,[conflict]);assert.equal(held.orders[0].lines[0].quantity,2);assert.equal(held.review.length,1);
const other={...source,messageId:'second',order:parseOfflinePoPages(fixture('98765432101'))};
assert.equal(reconcileOfflineDocuments(emptyImportPlan(),[source,other]).orders.length,2);
if(process.argv[2]){
 const actual=await inspectPoPdf(new Uint8Array(fs.readFileSync(process.argv[2])));
 assert.equal(actual.offlineOrder.externalPo,'37249725170');
 assert.deepEqual(actual.offlineOrder.lines,[{sku:'ROMAN 010001 PRO-732 1 GAL EXTRA STRENGTH WALLPAPER ADHESIVE',description:'https://www.amazon.com/dp/B000I1VF64?th=1',quantity:1,uom:'EA',unitPriceCents:2399}]);
 assert.equal(actual.offlineOrder.totalCents,2399);assert.equal(actual.persisted,0);
 console.log('PASS actual supplied offline PDF: exact PO, separate name/URL, quantity/UOM and price.');
}
console.log('PASS offline PDF layout, totals, multiple POs, acceptance-only recovery, duplicates and conflicting snapshots.');
