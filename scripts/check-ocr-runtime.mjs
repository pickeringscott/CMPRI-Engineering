// Run after build in an isolated directory containing only traced dependencies.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tracePath=path.resolve('.next/server/app/api/assets/documentation/ocr/dispatch/route.js.nft.json');
const trace=JSON.parse(await readFile(tracePath,'utf8'));
const files=trace.files.map(file=>path.resolve(path.dirname(tracePath),file)).filter(file=>file.includes(`${path.sep}node_modules${path.sep}`));
for(const required of ['tesseract.js/src/worker-script/node/index.js','tesseract-core-simd-lstm.wasm.js','eng.traineddata.gz']) assert(files.some(file=>file.includes(required)),`OCR runtime missing ${required}`);
const isolated=await mkdtemp(path.join(tmpdir(),'cmpri-ocr-runtime-'));
try{
 for(const file of files){const relative=path.relative(process.cwd(),file);assert(!relative.startsWith('..')&&!path.isAbsolute(relative));const target=path.join(isolated,relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(file,target);}
 await copyFile('tests/helpers/scanned-page.jpg',path.join(isolated,'scanned-page.jpg'));
 const probe=`import {readFile} from 'node:fs/promises';
 import {createWorker,OEM} from './node_modules/tesseract.js/src/index.js';
 import path from 'node:path';
 const worker=await createWorker('eng',OEM.LSTM_ONLY,{langPath:path.resolve('node_modules/@tesseract.js-data/eng/4.0.0_best_int'),corePath:path.resolve('node_modules/tesseract.js-core'),cacheMethod:'none',gzip:true});
 try{const result=await worker.recognize(await readFile('scanned-page.jpg'));if(!/NO HOT WATER/i.test(result.data.text)||!/water supply valve/i.test(result.data.text))throw Error('OCR text not recognized');console.log('OCR runtime recognized source text');}finally{await worker.terminate();}`;
 await writeFile(path.join(isolated,'probe.mjs'),probe);const result=spawnSync(process.execPath,['probe.mjs'],{cwd:isolated,encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr||result.stdout);console.log(result.stdout.trim());
}finally{await rm(isolated,{recursive:true,force:true});}
