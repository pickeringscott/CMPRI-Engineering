// Local, checksum-verified packaging only. No network or database access.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {planPurchasingHistory,canonicalHistory} from '../src/lib/purchasing-history.ts';
const [directory,destination]=process.argv.slice(2);
if(!directory||!destination)throw Error('Usage: node --experimental-strip-types scripts/prepare-purchasing-history.mjs SOURCE_DIRECTORY OUTPUT_JSON');
const hashes=JSON.parse(fs.readFileSync(path.join(directory,'checksums.json'),'utf8'));
const names=['supplier_order_history','other_supplier_receipts','source_index','ibuy_acceptances','cassie_order_evidence','amazon_historical_catalog'];
const prose={reconciliation_notes:'reconciliation_notes.md',readme:'README.md',supplier_findings:'supplier_findings.txt'};
function read(name){if(path.basename(name)!==name||!hashes[name])throw Error('Missing expected checksum');const bytes=fs.readFileSync(path.join(directory,name));if(createHash('sha256').update(bytes).digest('hex')!==hashes[name])throw Error(`Checksum mismatch: ${name}`);return bytes.toString('utf8');}
const bundle=Object.fromEntries(names.map(n=>[n,JSON.parse(read(n+'.json'))]));for(const [k,file]of Object.entries(prose))bundle[k]=read(file);
const plan=planPurchasingHistory(bundle);fs.writeFileSync(destination,JSON.stringify(bundle));
console.log(JSON.stringify({sources:plan.sources.length,records:plan.records.length,digest:createHash('sha256').update(canonicalHistory(plan)).digest('hex'),inventoryChanged:false}));
