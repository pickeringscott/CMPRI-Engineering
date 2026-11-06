import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {headerActionStyle,modalThemeStyle,modalTitleStyle} from '../src/lib/ui/header-palette.ts';
test('every action retains the actual approved Coral Glow mapping, including numbered Feedback labels',()=>{
 const html=readFileSync('.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html','utf8');
 const inventory=JSON.parse(html.match(/const inventories=(\{[^\n]+\});/)[1]);const palettes=JSON.parse(html.match(/const previewPalettes=(\[[^\n]+\]);/)[1]);
 const names=[...new Set(Object.values(inventory).flatMap(groups=>groups.flatMap(g=>g.slice(1))))],colors=palettes[5][1];
 for(const name of names){
  if(name==='Sign Out')continue;
  const hex=name.includes('Maintenance')?'#00D492':colors[names.indexOf(name)%colors.length];const rgb=hex.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16));
  assert.equal(headerActionStyle(name)['--action-rgb'],rgb.join(','),name);
  const theme=modalThemeStyle(name);assert.equal(theme['--cmpri-modal-base'],'#0f172a');assert.equal(theme['--cmpri-modal-text'],headerActionStyle(name).color);assert.equal(theme['--cmpri-outline'],`rgba(${rgb},.42)`);assert.equal(theme['--cmpri-scroll-thumb'],`rgba(${rgb},.28)`);assert.equal(modalTitleStyle(name).backgroundColor,headerActionStyle(name)['background-color']);
 }
 assert.deepEqual(headerActionStyle('Feedback (7)'),headerActionStyle('Feedback'));
});
