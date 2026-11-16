import assert from 'node:assert/strict';
import { FootballRules as R } from '../src/components/desktop/football/football-rules.js';
const rng=()=>.5;let checks=0;const check=(fn)=>{fn();checks++};
const state=(pos=25,down=1,lineToGain=35)=>({...R.initialState('ill'),pos,down,lineToGain});
check(()=>{const r=R.resolveSnap(state(),{type:'run',end:29},rng);assert.equal(r.state.pos,29);assert.equal(r.state.down,2);assert.equal(r.play.toGo,10);assert.equal(r.play.next.toGo,6)});
check(()=>{const r=R.resolveSnap(state(29,2,35),{type:'pass',end:38,outcome:'complete'},rng);assert.equal(r.state.down,1);assert.equal(r.state.lineToGain,48);assert.equal(r.play.next.reason,'retained')});
check(()=>{const r=R.resolveSnap(state(29,2,35),{type:'pass',end:24,outcome:'sack'},rng);assert.equal(r.state.down,3);assert.equal(r.play.next.toGo,11);assert.equal(r.play.gain,-5)});
check(()=>{const r=R.resolveSnap(state(29,2,35),{type:'pass',end:55,outcome:'incomplete'},rng);assert.equal(r.state.pos,29);assert.equal(r.play.end,29);assert.equal(r.state.down,3)});
check(()=>{const r=R.resolveSnap(state(42,4,45),{type:'pass',outcome:'incomplete'},rng);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,58);assert.equal(r.state.down,1);assert.equal(r.play.outcome,'turnover-on-downs')});
check(()=>{const r=R.resolveSnap(state(42,4,45),{type:'run',end:47},rng);assert.equal(r.state.team,'ill');assert.equal(r.state.pos,47);assert.equal(r.state.lineToGain,57);assert.equal(r.state.down,1)});
check(()=>{const r=R.resolveSnap(state(90,1,100),{type:'pass',end:98,outcome:'touchdown'},rng);assert.equal(r.play.td,false);assert.equal(r.state.score.ill,0);assert.equal(r.state.down,2)});
check(()=>{const r=R.resolveSnap(state(90,1,100),{type:'run',end:101,patGood:true},rng);assert.equal(r.play.end,100);assert.equal(r.state.score.ill,7);assert.equal(r.play.conversion.points,1);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,25)});
check(()=>{const r=R.resolveSnap(state(90,1,100),{type:'run',end:100,patGood:false},rng);assert.equal(r.state.score.ill,6)});
check(()=>{const r=R.resolveSnap(state(5,2,15),{type:'run',end:-1},rng);assert.equal(r.play.outcome,'safety');assert.equal(r.state.score.iowa,2);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,35)});
check(()=>{const r=R.resolveSnap(state(40,3,45),{type:'pass',end:60,outcome:'interception'},rng);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,40);assert.equal(r.state.lineToGain,50)});
check(()=>{const r=R.resolveSnap(state(40,3,45),{type:'pass',end:-1,outcome:'interception',patGood:true},rng);assert.equal(r.play.outcome,'defensive-touchdown');assert.equal(r.state.score.iowa,7);assert.equal(r.state.team,'ill');assert.equal(r.state.pos,25)});
check(()=>{const r=R.resolveSnap(state(75,4,80),{type:'fieldgoal',good:true},rng);assert.equal(r.play.kickDistance,42);assert.equal(r.state.score.ill,3);assert.equal(r.state.pos,25);assert.equal(r.state.team,'iowa')});
check(()=>{const r=R.resolveSnap(state(70,4,75),{type:'fieldgoal',good:false},rng);assert.equal(r.state.pos,30);assert.equal(r.state.score.ill,0)});
check(()=>{const r=R.resolveSnap(state(88,4,90),{type:'fieldgoal',good:false},rng);assert.equal(r.state.pos,20)});
check(()=>{const r=R.resolveSnap(state(35,4,45),{type:'punt',kickYards:45,returnYards:6},rng);assert.equal(r.state.pos,26);assert.equal(r.state.team,'iowa');assert.equal(r.play.end,74)});
check(()=>{const r=R.resolveSnap(state(60,4,70),{type:'punt',kickYards:45},rng);assert.equal(r.state.pos,20);assert.equal(r.play.outcome,'punt-touchback')});
check(()=>{const input={...state(50,2,55),clock:4};const r=R.resolveSnap(input,{type:'run',end:53,duration:12},rng);assert.equal(r.play.quarter,1);assert.equal(r.play.endClock,0);assert.equal(r.state.quarter,2);assert.equal(r.state.clock,900);assert.equal(r.state.pos,53);assert.equal(r.state.down,3)});
check(()=>{const input={...state(50,2,55),clock:4,quarter:2};const r=R.resolveSnap(input,{type:'run',end:53,duration:12},rng);assert.equal(r.state.quarter,3);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,25);assert.equal(r.state.down,1);assert.equal(r.play.next.reason,'halftime-kickoff')});
check(()=>{const input={...state(50,2,55),clock:4,quarter:4};const r=R.resolveSnap(input,{type:'run',end:53,duration:12},rng);assert.equal(r.state.finished,true)});

// v9 two-minute timeout and halftime event boundaries.
const qstate=(q,clock,opening='ill')=>({...R.initialState(opening),quarter:q,clock,pos:45,down:2,lineToGain:55});
for(const q of [2,4])check(()=>{
 const input=qstate(q,137),r=R.resolveSnap(input,{type:'run',end:49,duration:35},rng);
 assert.equal(r.play.startClock,137);assert.equal(r.play.endClock,120);assert.equal(r.state.clock,120);
 assert.equal(r.play.twoMinuteWarning,true);assert.equal(r.play.breakAfter.type,'two-minute-warning');
 assert.equal(r.play.breakAfter.clock,120);assert.equal(r.play.breakAfter.quarter,q);
 assert.equal(r.state.pos,49);assert.equal(r.state.down,3);assert.equal(r.state.lineToGain,55);
 assert.equal(r.state.team,input.team);assert.equal(input.twoMinuteWarnings[q],false);
 assert.equal(r.state.twoMinuteWarnings[q],true);assert.equal(r.play.next.twoMinuteWarnings[q],true);
 const n=R.resolveSnap(r.state,{type:'pass',end:49,outcome:'incomplete',duration:11},rng);
 assert.equal(n.play.startClock,120);assert.equal(n.play.endClock,109);assert.equal(n.play.twoMinuteWarning,false);
 assert.equal(n.play.breakAfter,null);assert.equal(n.state.down,4);
});
for(const q of [1,3])check(()=>{
 const r=R.resolveSnap(qstate(q,137),{type:'run',end:50,duration:35},rng);
 assert.equal(r.play.endClock,102);assert.equal(r.play.twoMinuteWarning,false);assert.equal(r.play.breakAfter,null);
});
for(const q of [2,4])check(()=>{
 const input=qstate(q,137);input.twoMinuteWarnings[q]=true;
 const r=R.resolveSnap(input,{type:'pass',end:50,outcome:'complete',duration:35},rng);
 assert.equal(r.play.endClock,102);assert.equal(r.play.twoMinuteWarning,false);assert.equal(r.play.breakAfter,null);
});
check(()=>{
 const r=R.resolveSnap(qstate(2,120),{type:'run',end:48,duration:20},rng);
 assert.equal(r.play.endClock,120);assert.equal(r.play.twoMinuteWarning,true);
 assert.equal(r.state.down,3);assert.equal(r.state.pos,48);
});
check(()=>{
 const r=R.resolveSnap(qstate(4,130),{type:'run',end:61,duration:30},rng);
 assert.equal(r.play.twoMinuteWarning,true);assert.equal(r.state.down,1);assert.equal(r.state.lineToGain,71);
 assert.equal(r.state.pos,61);assert.equal(r.state.score.ill,0);assert.equal(r.state.team,'ill');
});
check(()=>{
 const r=R.resolveSnap(qstate(2,130),{type:'pass',end:61,outcome:'interception',duration:30},rng);
 assert.equal(r.play.twoMinuteWarning,true);assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,39);
 assert.equal(r.play.breakAfter.possession,'iowa');assert.equal(r.state.down,1);
});
check(()=>{
 const input={...qstate(4,122),pos:96,lineToGain:100};
 const r=R.resolveSnap(input,{type:'run',end:101,patGood:true,duration:30},rng);
 assert.equal(r.play.twoMinuteWarning,true);assert.equal(r.play.td,true);assert.equal(r.state.score.ill,7);
 assert.equal(r.state.team,'iowa');assert.equal(r.state.pos,25);assert.equal(r.state.clock,120);
});
for(const opening of ['ill','iowa'])for(const endingTeam of ['ill','iowa'])check(()=>{
 const input={...qstate(2,3,opening),team:endingTeam};input.twoMinuteWarnings[2]=true;
 const r=R.resolveSnap(input,{type:'run',end:50,duration:12},rng);
 const receiving=opening==='ill'?'iowa':'ill';
 assert.equal(r.play.quarterBreak,'halftime');assert.equal(r.play.halftime,true);
 assert.equal(r.play.breakAfter.type,'halftime');assert.equal(r.play.breakAfter.receivingTeam,receiving);
 assert.equal(r.play.breakAfter.openingReceiver,opening);assert.equal(r.play.secondHalfReceiver,receiving);
 assert.equal(r.play.breakAfter.next.team,receiving);assert.equal(r.play.breakAfter.next.start,25);
 assert.equal(r.state.quarter,3);assert.equal(r.state.clock,900);assert.equal(r.state.team,receiving);
 assert.equal(r.state.pos,25);assert.equal(r.state.down,1);assert.equal(r.state.lineToGain,35);
 assert.equal(r.play.next.reason,'halftime-kickoff');assert.equal(r.play.next.team,receiving);
});
for(const q of [1,3])check(()=>{
 const r=R.resolveSnap(qstate(q,4),{type:'run',end:50,duration:20},rng);
 assert.equal(r.play.breakAfter.type,'quarter');assert.equal(r.state.quarter,q+1);
 assert.equal(r.state.team,'ill');assert.equal(r.state.pos,50);assert.equal(r.state.down,3);
 assert.equal(r.state.lineToGain,55);assert.equal(r.state.clock,900);
});
check(()=>{
 const input=qstate(4,4);input.twoMinuteWarnings[4]=true;
 const r=R.resolveSnap(input,{type:'pass',outcome:'incomplete',duration:12},rng);
 assert.equal(r.state.finished,true);assert.equal(r.play.breakAfter.type,'final');assert.equal(r.play.endClock,0);
});
let seed=92137;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
function snap(ctx,r){
 if(ctx.type==='punt')return{kickYards:35+r()*18,returnYards:r()*9};
 if(ctx.type==='fieldgoal')return{good:r()<.78};
 const roll=r();
 if(ctx.type==='pass'&&roll<.21)return{outcome:'incomplete',end:ctx.start};
 if(ctx.type==='pass'&&roll<.245)return{outcome:'interception',end:ctx.start+5+r()*20};
 if(ctx.type==='pass'&&roll<.31)return{outcome:'sack',gain:-2-r()*6};
 const gain=ctx.type==='run'?-2+r()*14:r()<.16?18+r()*35:1+r()*17;
 return{outcome:ctx.type==='run'?'tackle':'complete',gain};
}
const games=[];for(let i=0;i<100;i++){
 const game=R.buildGame(snap,{random,maxAttempts:300});games.push(game);
 assert.ok(game.result.leadChanges>=3);assert.ok(game.result.winner);
 const warnings=game.plays.filter(p=>p.twoMinuteWarning);assert.equal(warnings.length,2);assert.deepEqual(warnings.map(p=>p.quarter),[2,4]);warnings.forEach(p=>{assert.equal(p.endClock,120);assert.equal(p.breakAfter.type,'two-minute-warning')});
 const half=game.plays.filter(p=>p.halftime);assert.equal(half.length,1);assert.equal(half[0].next.team,half[0].secondHalfReceiver);assert.equal(half[0].secondHalfReceiver,half[0].openingReceiver==='ill'?'iowa':'ill');
 assert.equal(game.plays.filter(p=>p.breakAfter?.type==='final').length,1);assert.ok(game.plays.length>50&&game.plays.length<240);
 for(let i=0;i<game.plays.length;i++){
  const p=game.plays[i];assert.ok(p.downNum>=1&&p.downNum<=4);assert.ok(p.start>0&&p.start<100);assert.ok(p.endClock>=0&&p.endClock<=p.startClock);assert.equal(p.after.ill-p.before.ill,p.scoringTeam==='ill'?p.points:0);assert.equal(p.after.iowa-p.before.iowa,p.scoringTeam==='iowa'?p.points:0);
  if(i+1<game.plays.length){const n=game.plays[i+1];assert.equal(n.team,p.next.team);assert.equal(n.start,p.next.start);assert.equal(n.downNum,p.next.downNum);assert.equal(n.lineToGain,p.next.lineToGain);assert.equal(n.quarter,p.next.quarter);assert.equal(n.startClock,p.next.clock);assert.deepEqual(n.before,p.after)}
 }
}
assert.ok(games.some(g=>g.result.winner==='ill'));assert.ok(games.some(g=>g.result.winner==='iowa'));
console.log(JSON.stringify({unitChecks:checks,fullGames:games.length,illWins:games.filter(g=>g.result.winner==='ill').length,iowaWins:games.filter(g=>g.result.winner==='iowa').length,minLeadChanges:Math.min(...games.map(g=>g.result.leadChanges)),meanSnaps:games.reduce((a,g)=>a+g.plays.length,0)/games.length,maxAttempts:Math.max(...games.map(g=>g.attempts))}));
