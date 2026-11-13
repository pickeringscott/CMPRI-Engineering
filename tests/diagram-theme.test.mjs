import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument,OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {themeSourceDiagram} from '../src/lib/work-orders/diagram-theme.ts';

const palette={surface:[25,27,36],ink:[240,241,246]};
function artwork(){
  const canvas=createCanvas(500,300),ctx=canvas.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,500,300);
  ctx.fillStyle='#e5e7eb';ctx.fillRect(60,60,150,110);
  ctx.strokeStyle='rgb(30,40,50)';ctx.lineWidth=3;ctx.strokeRect(60,60,150,110);
  ctx.fillStyle='#ef4444';ctx.fillRect(260,60,100,80);
  ctx.fillStyle='#fbbf24';ctx.fillRect(260,160,100,40);
  return ctx.getImageData(0,0,500,300);
}

test('flat diagram paper and tinted neutral nodes inherit native surface while semantic colors stay exact',()=>{
  const image=artwork(),original=new Uint8ClampedArray(image.data),result=themeSourceDiagram(image,palette,'Figure 1: Circuit diagram.');
  assert.equal(result.adapted,true);assert.equal(result.reason,'flat-diagram');
  const at=(x,y)=>(y*image.width+x)*4;
  assert.deepEqual([...result.data.slice(at(5,5),at(5,5)+3)],palette.surface);
  assert.deepEqual([...result.data.slice(at(100,100),at(100,100)+3)],palette.surface);
  assert.deepEqual([...result.data.slice(at(60,100),at(60,100)+3)],palette.ink);
  for(let i=0;i<original.length;i+=4)if(Math.max(...original.slice(i,i+3))-Math.min(...original.slice(i,i+3))>=60)assert.deepEqual(result.data.slice(i,i+4),original.slice(i,i+4));
  assert.deepEqual(image.data,original,'the authenticated decoded source is never mutated');
});

test('continuous-tone grayscale, colored and high-key photographs remain byte-for-byte original',()=>{
  for(const mode of ['grayscale','color','high-key']){
    const canvas=createCanvas(500,300),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,500,300);
    const gradient=ctx.createLinearGradient(80,60,400,240);
    gradient.addColorStop(0,mode==='color'?'#364253':'#333333');gradient.addColorStop(.5,mode==='high-key'?'#f2f0ed':'#999999');gradient.addColorStop(1,mode==='color'?'#e6a3b7':'#eeeeee');
    ctx.fillStyle=gradient;ctx.fillRect(80,60,320,180);
    const image=ctx.getImageData(0,0,500,300),result=themeSourceDiagram(image,palette,'Figure 7: Equipment source illustration.');
    assert.equal(result.adapted,false,mode);assert.equal(result.data,image.data,mode);
  }
  assert.equal(themeSourceDiagram(artwork(),palette,'Figure 2: Equipment photograph.').adapted,false);
});

test('blank, transparent, complex and unbounded images do not receive a guessed theme',()=>{
  const image=artwork();image.data[3]=0;assert.equal(themeSourceDiagram(image,palette).reason,'transparency');
  assert.equal(themeSourceDiagram({width:10,height:10,data:new Uint8ClampedArray(400)},palette).reason,'bounds');
  const blank={width:100,height:100,data:new Uint8ClampedArray(40_000).fill(255)};
  assert.equal(themeSourceDiagram(blank,palette).adapted,false);
});

test('known vector PDF pages follow the palette even when almost entirely paper',()=>{
  const data=new Uint8ClampedArray(100*100*4).fill(255);
  data[404]=data[405]=data[406]=0;
  const result=themeSourceDiagram({width:100,height:100,data},palette,'Source PDF page',true);
  assert.equal(result.adapted,true);
  assert.deepEqual([...result.data.slice(0,3)],palette.surface);
  assert.deepEqual([...result.data.slice(404,407)],palette.ink);
});

test('sparse binary halftone texture on white remains original rather than being mistaken for flat artwork',()=>{
  const width=500,height=300,data=new Uint8ClampedArray(width*height*4).fill(255);
  // Ordered halftone shading: the same kind of hard dot edges used in printed/scanned photographs.
  const pattern=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
  for(let y=60;y<240;y++)for(let x=80;x<420;x++)if(pattern[y%4][x%4]<(x-80)/340*12+2){const at=(y*width+x)*4;data[at]=data[at+1]=data[at+2]=0;}
  const result=themeSourceDiagram({width,height,data},palette,'Figure 7: Equipment.');
  assert.equal(result.adapted,false);assert.equal(result.reason,'halftone-texture');assert.equal(result.data,data);
});

test('full PDF vector pages use proven vector geometry for theming while embedded raster pages remain original',async()=>{
  const output=mkdtempSync(path.join(tmpdir(),'cmpri-diagram-theme-'));
  const task=getDocument({data:new Uint8Array(readFileSync('tests/fixtures/uploaded-guide-diagrams.pdf'))});
  try{
    execFileSync(process.execPath,['--import','./tests/helpers/resolve-ts.mjs','--experimental-strip-types','tests/helpers/uploaded-guide-media-preview.mjs',output],{cwd:process.cwd(),stdio:'pipe'});
    const manifest=JSON.parse(readFileSync(path.join(output,'manifest.json'),'utf8'));
    const variant=manifest.variants[0];
    const selected=[variant.knowledge.step_media.find(item=>/vector diagram/.test(item.caption)),variant.knowledge.step_media.find(item=>/Figure 1/.test(item.caption))];
    const pdf=await task.promise;
    const raster=new Set(Object.entries(OPS).filter(([name])=>/paint.*Image|shadingFill|setFillColorN|setStrokeColorN/.test(name)).map(([,op])=>op));
    for(const descriptor of selected){
      assert.ok(descriptor);const {data,info}=await sharp(variant.mediaFiles[descriptor.id]).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const page=await pdf.getPage(descriptor.sourcePage),operators=await page.getOperatorList();
      const vectorOnly=!operators.fnArray.some(op=>raster.has(op));
      for(const current of[palette,{surface:[23,28,35],ink:[242,246,250]}]){
        const pixels={width:info.width,height:info.height,data:new Uint8ClampedArray(data)};
        const result=themeSourceDiagram(pixels,current,descriptor.caption,vectorOnly);
        if(!vectorOnly){assert.equal(result.adapted,false);assert.equal(result.data,pixels.data);continue;}
        assert.equal(result.adapted,true,descriptor.caption);let paper=0,colors=0;
        for(let i=0;i<data.length;i+=4){
          if(data[i]===255&&data[i+1]===255&&data[i+2]===255){paper++;assert.deepEqual([...result.data.slice(i,i+3)],current.surface);}
          if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>=60){colors++;assert.deepEqual([...result.data.slice(i,i+4)],[...data.slice(i,i+4)]);}
        }
        assert.ok(paper>1000);assert.ok(colors>100);
      }
    }
  }finally{await task.destroy();rmSync(output,{recursive:true,force:true});}
});
