// Local, read-only batch preparation. Does not download URLs or write to a database.
// node --import ./tests/helpers/resolve-ts.mjs scripts/review-offline-po-pdfs.mjs manifest.json
// Manifest: {previous?: ImportPlan, documents:[{path,source:PoSource,sourceUrl,expectedPo,expectedSha256?}]}
import fs from 'node:fs';
import path from 'node:path';
import {bindOfflinePoDocument,offlineRecoveryDigest} from '../src/lib/server/po-offline-recovery.ts';
import {reconcileOfflineDocuments} from '../src/lib/po-offline-pdf.ts';
import {emptyImportPlan} from '../src/lib/po-evidence.ts';
const manifestPath=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Provide a local document manifest.');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
if(!Array.isArray(manifest.documents)||manifest.documents.length>1000)throw Error('Provide up to 1000 source documents.');
const documents=[],held=[],boundDocuments=[];
for(const source of manifest.documents){
 try{
  const file=path.resolve(path.dirname(manifestPath),source.path);
  const bound=await bindOfflinePoDocument(source.source,new Uint8Array(fs.readFileSync(file)),source);
  boundDocuments.push(bound);
  documents.push({account:bound.account,messageId:bound.sourceMessageId,messageAt:bound.sourceMessageAt,sha256:bound.documentSha256,order:bound.order});
 }catch(error){held.push({messageId:source.messageId,path:source.path,reason:error.message});}
}
console.log(JSON.stringify({persisted:0,held,reviewedDigest:offlineRecoveryDigest(boundDocuments),boundDocuments,plan:reconcileOfflineDocuments(manifest.previous||emptyImportPlan(),documents)},null,2));
