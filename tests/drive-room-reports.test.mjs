import './helpers/resolve-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { newerDriveRoomReports, driveRoomReportName } from '../src/lib/room-report-drive.ts';
import { fetchNewerDriveRoomReports } from '../src/lib/server/drive-room-reports.ts';
import { DRIVE_PO_FOLDER, DRIVE_PO_ACCOUNT } from '../src/lib/server/drive-po-api.ts';

const today='2026-11-08';
const labels={guests:'In House Guest List Details',arrivals:'Housekeeping Arrivals',departures:'Housekeeping Departures'};
const file=(kind,time='10-00-00',extra={})=>({id:kind+time.replaceAll('-',''),name:`${labels[kind]}_CMPRI_${today}_${time}.csv`,mimeType:'text/csv',version:'1',parents:[DRIVE_PO_FOLDER],size:'4',...extra});
const accepted=(kind,time)=>({name:file(kind,time).name,kind,date:today,time:time.replaceAll('-',':'),rows:[]});

test('selects newest filename timestamp separately for each report type and ignores unrelated attachments',()=>{
 const files=[file('guests','10-01-00'),file('guests','09-00-00',{modifiedTime:'2099-01-01'}),file('arrivals','09-59-00'),file('departures','10-00-00'),file('guests','10-02-00'),{...file('guests'),name:'PO_2026-11-08_11-00-00.csv'}, {...file('guests'),name:'Notes.csv'},file('guests','11-00-00',{mimeType:'application/pdf'}),file('guests','10-03-00',{name:'In House Guest List Details_CMPRI_2026-11-09_10-03-00.csv'})];
 assert.deepEqual(newerDriveRoomReports(files,{guests:accepted('guests','10-00-00'),departures:accepted('departures','10-00-00')},today).map(x=>x.name),[file('guests','10-02-00').name,file('arrivals','09-59-00').name]);
 assert.deepEqual(newerDriveRoomReports([file('guests')],{guests:accepted('guests','10-00-00')},today),[]);
 assert.equal(driveRoomReportName({...file('guests'),name:'In House Guest List Details_CMPRI_2026-11-08_25-00-00.csv'}),null);
});
test('does not choose between conflicting latest copies; identical copies are fetched once',()=>{
 const a=file('guests'),b={...a,id:'copy'};
 assert.throws(()=>newerDriveRoomReports([a,b],{},today),/same newest/);
 assert.equal(newerDriveRoomReports([{...a,md5Checksum:'same'},{...b,md5Checksum:'same'}],{},today).length,1);
});

async function transport(mode='success',previous={}){
 const old=globalThis.fetch,requests=[];let pages=0;
 process.env.CMPRI_GMAIL_CLIENT_ID='fixture';process.env.CMPRI_GMAIL_CLIENT_SECRET='fixture';process.env.CMPRI_GMAIL_REFRESH_TOKEN='fixture';
 const guest=file('guests'),arrival=file('arrivals');
 globalThis.fetch=async(url,init={})=>{
  requests.push({url,method:init.method||'GET'});
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture-token'});
  if(url.includes('about?'))return Response.json({user:{emailAddress:mode==='wrong-account'?'other@example.invalid':DRIVE_PO_ACCOUNT}});
  if(url.includes(`/files/${DRIVE_PO_FOLDER}?`))return Response.json({id:DRIVE_PO_FOLDER,mimeType:'application/vnd.google-apps.folder'});
  if(url.includes('/files?')){
   pages++;
   return Response.json({files:[pages===1?guest:arrival],...(mode==='incomplete'?{incompleteSearch:true}:{}),...(pages===1?{nextPageToken:'next'}:{})});
  }
  if(url.includes('alt=media'))return new Response(mode==='oversize'?'12345':'a,b\n');
  const current=url.includes('/files/'+guest.id+'?')?guest:arrival;
  return Response.json({...current,...(mode==='wrong-file'?{id:'another-file'}:mode==='changed'?{version:'2'}:mode==='moved'?{parents:['elsewhere']}:mode==='renamed'?{name:'PO.csv'}:{})});
 };
 try {return {files:await fetchNewerDriveRoomReports(previous,today),requests};} finally {globalThis.fetch=old;}
}
test('existing account/folder grant fetches only newer CSVs across all inventory pages and rechecks identity',async()=>{
 const result=await transport('success',{arrivals:accepted('arrivals','10-00-00')});
 assert.deepEqual(result.files,[{name:file('guests').name,text:'a,b\n'}]);
 assert.equal(result.requests.filter(r=>r.url.includes('/files?')).length,2);
 assert.equal(result.requests.filter(r=>r.url.includes('alt=media')).length,1);
 assert.equal(result.requests.filter(r=>r.method!=='GET').length,1); // Existing OAuth refresh only.
});
for(const mode of ['wrong-account','incomplete','wrong-file','changed','moved','renamed','oversize'])test(`read-only acquisition rejects ${mode}`,async()=>{await assert.rejects(transport(mode));});
