/* Football rules for the standalone Illinois/Iowa simulation.
   Coordinates are yards from the possessing team's own goal line (0..100).
   The callback supplies physical snap results; this module manages the game. */
export const FootballRules = (() => {
  'use strict';
  const other = team => team === 'ill' ? 'iowa' : 'ill';
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const round = v => Math.round(v*10)/10;
  function secureRandom(){
    if(typeof crypto !== 'undefined' && crypto.getRandomValues){
      const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]/4294967296;
    }
    return Math.random();
  }
  const between=(random,a,b)=>a+random()*(b-a);
  const copyScore=score=>({ill:score.ill,iowa:score.iowa});
  function chooseType(state,random){
    const distance=Math.max(0,state.lineToGain-state.pos);
    const behind=state.score[state.team]<state.score[other(state.team)];
    const late=state.quarter===4&&state.clock<180;
    if(state.down===4){
      const kickDistance=117-state.pos;
      const needsTD=late&&behind&&state.score[other(state.team)]-state.score[state.team]>3;
      const goShort=distance<=2&&state.pos>=40&&random()<.43;
      if(!needsTD&&!goShort&&kickDistance<=55&&random()<.9)return 'fieldgoal';
      if(!needsTD&&!goShort&&state.pos<66)return 'punt';
    }
    const passRate=state.down>=3&&distance>3?.76:distance>12?.74:late&&behind?.78:.54;
    return random()<passRate?'pass':'run';
  }
  function initialState(openingReceiver='ill'){
    return{team:openingReceiver,pos:25,down:1,lineToGain:35,quarter:1,clock:900,
      score:{ill:0,iowa:0},leadChanges:0,leader:null,drive:1,openingReceiver,
      secondHalfReceiver:other(openingReceiver),twoMinuteWarnings:{2:false,4:false},finished:false};
  }
  function updateLeader(state){
    const leader=state.score.ill===state.score.iowa?null:state.score.ill>state.score.iowa?'ill':'iowa';
    if(leader&&state.leader&&leader!==state.leader)state.leadChanges++;
    if(leader)state.leader=leader;
  }
  function resolveSnap(input,raw={},random=secureRandom){
    const state={...input,score:copyScore(input.score),twoMinuteWarnings:{2:Boolean(input.twoMinuteWarnings?.[2]),4:Boolean(input.twoMinuteWarnings?.[4])}};
    const openingReceiver=input.openingReceiver||'ill',secondHalfReceiver=other(openingReceiver);
    state.openingReceiver=openingReceiver;state.secondHalfReceiver=secondHalfReceiver;
    const team=state.team,defense=other(team),start=state.pos;
    const type=raw.type||'run';
    let outcome=raw.outcome||(type==='pass'?'complete':'tackle');
    let end=Number.isFinite(raw.end)?raw.end:start+(Number.isFinite(raw.gain)?raw.gain:0);
    end=round(clamp(end,-10,110));
    const before=copyScore(state.score);
    const downNum=state.down,toGo=round(state.lineToGain-start),lineToGain=state.lineToGain;
    let points=0,scoringTeam=null,conversion=null,reason='retained',touchdown=false,defensiveTD=false;
    const changePossession=(pos,why)=>{
      state.team=defense;state.pos=round(clamp(pos,1,99));state.down=1;
      state.lineToGain=Math.min(100,round(state.pos+10));state.drive++;reason=why;
    };
    const touchdownFor=(scorer,why)=>{
      // NCAA kick conversion from the three-yard line: approximately 20 yards.
      const good=typeof raw.patGood==='boolean'?raw.patGood:random()<.965;
      conversion={type:'pat',good,points:good?1:0,distance:20};
      points=6+conversion.points;scoringTeam=scorer;state.score[scorer]+=points;
      touchdown=true;defensiveTD=scorer!==team;outcome=why;
      state.team=other(scorer);state.pos=25;state.down=1;state.lineToGain=35;state.drive++;
      reason='kickoff-touchback';
    };
    if(type==='fieldgoal'){
      const distance=117-start;
      const accuracy=clamp(.995-Math.max(0,distance-25)*.0105,.28,.995);
      const good=typeof raw.good==='boolean'?raw.good:raw.outcome==='fieldgoal-good'?true:raw.outcome==='fieldgoal-missed'?false:random()<accuracy;
      outcome=good?'fieldgoal-good':'fieldgoal-missed';
      if(good){points=3;scoringTeam=team;state.score[team]+=3;changePossession(25,'kickoff-touchback');}
      // NCAA missed kick: previous spot, or the defending team's 20, whichever is farther out.
      else changePossession(Math.max(20,100-start),'missed-fieldgoal');
      end=start;
    }else if(type==='punt'){
      const distance=Number.isFinite(raw.kickYards)?raw.kickYards:Number.isFinite(raw.gain)?raw.gain:between(random,35,51);
      const physicalEnd=Number.isFinite(raw.end);
      const landing=Number.isFinite(raw.landingSpot)?raw.landingSpot:physicalEnd?raw.end:start+distance;
      const touchback=raw.touchback===true||landing>=100;
      const returnYards=touchback||physicalEnd?0:Number.isFinite(raw.returnYards)?raw.returnYards:between(random,0,9);
      end=round(clamp(physicalEnd?raw.end:landing-returnYards,0,100));
      if(!touchback&&end<=0&&raw.outcome==='punt-return-touchdown')touchdownFor(defense,'punt-return-touchdown');
      else{
        outcome=touchback?'punt-touchback':raw.puntEndReason||'punt';
        changePossession(touchback?20:100-end,'punt');
      }
    }else if(outcome==='incomplete'){
      // An uncaught forward pass does not advance the official ball spot.
      end=start;state.down++;
    }else if(outcome==='interception'||outcome==='fumble'){
      if(end<=0)touchdownFor(defense,'defensive-touchdown');
      else changePossession(end>=100?20:100-end,outcome);
    }else if(end>=100){
      end=100;touchdownFor(team,'touchdown');
    }else if(end<=0){
      points=2;scoringTeam=defense;state.score[defense]+=2;outcome='safety';
      changePossession(35,'safety-free-kick');
    }else{
      state.pos=end;
      // A touchdown label cannot score unless the actual carrier crossed the goal.
      if(outcome==='touchdown')outcome=type==='pass'?'complete':'tackle';
      if(end>=state.lineToGain-.001){state.down=1;state.lineToGain=Math.min(100,round(end+10));}
      else state.down++;
    }
    const liveEndReason=outcome;
    if(state.team===team&&state.down>4){
      changePossession(100-state.pos,'turnover-on-downs');outcome='turnover-on-downs';
    }
    const duration=clamp(Number.isFinite(raw.duration)?raw.duration:between(random,18,38),5,45);
    let endClock=Math.max(0,round(input.clock-duration));
    // Game-clock durations include the accelerated dead-ball/runoff interval.
    // Stop that interval at 2:00 rather than skipping the visible warning. The
    // already simulated live snap still resolves normally (gain/down/score).
    const warningQuarter=input.quarter===2||input.quarter===4;
    const twoMinuteWarning=warningQuarter&&!state.twoMinuteWarnings[input.quarter]&&input.clock>=120&&endClock<=120;
    let breakAfter=null;
    if(twoMinuteWarning){
      endClock=120;state.twoMinuteWarnings[input.quarter]=true;
      breakAfter={type:'two-minute-warning',title:'TWO-MINUTE WARNING',quarter:input.quarter,clock:120,
        displayPeriod:'Q'+input.quarter,possession:state.team,seconds:4,
        message:'Two-minute timeout before '+(input.quarter===2?'halftime.':'the end of regulation.')};
    }
    state.clock=endClock;
    updateLeader(state);
    let quarterBreak=null;
    if(state.clock<=0){
      if(state.quarter===4){
        state.finished=true;
        breakAfter={type:'final',title:'FINAL',quarter:4,clock:0,displayPeriod:'FINAL',seconds:0,
          message:'End of regulation.'};
      }else{
        state.quarter++;state.clock=900;
        if(state.quarter===3){
          state.team=secondHalfReceiver;state.pos=25;state.down=1;state.lineToGain=35;state.drive++;
          reason='halftime-kickoff';quarterBreak='halftime';
          const name=secondHalfReceiver==='ill'?'Illinois':'Iowa';
          breakAfter={type:'halftime',title:'HALFTIME',quarter:2,clock:0,displayPeriod:'HALFTIME',
            nextQuarter:3,receivingTeam:secondHalfReceiver,openingReceiver,possession:secondHalfReceiver,seconds:6,
            next:{team:secondHalfReceiver,start:25,downNum:1,toGo:10,lineToGain:35,quarter:3,clock:900},
            message:name+' receives the second-half kickoff. First and 10 at its 25.'};
        }else{
          quarterBreak='quarter';
          breakAfter={type:'quarter',title:'END OF '+(input.quarter===1?'1ST':'3RD')+' QUARTER',
            quarter:input.quarter,clock:0,displayPeriod:'END Q'+input.quarter,nextQuarter:state.quarter,
            possession:state.team,seconds:3,message:'Teams change ends; possession and the series carry over.'};
        }
      }
    }
    const play={...raw,team,type,start,end,gain:round(end-start),downNum,toGo,lineToGain,
      down:['','1ST','2ND','3RD','4TH'][downNum]+' & '+(lineToGain===100?'GOAL':Math.ceil(toGo)),
      drive:input.drive,quarter:input.quarter,startClock:input.clock,endClock,before,after:copyScore(state.score),
      outcome,liveEndReason,snapOutcome:raw.outcome||liveEndReason,points,scoringTeam,conversion,td:touchdown,defensiveTD,leadChanges:state.leadChanges,
      duration,clockElapsed:round(input.clock-endClock),twoMinuteWarning,breakAfter,
      openingReceiver,secondHalfReceiver,halftime:quarterBreak==='halftime',quarterBreak,attackDirection:(team==='ill'?1:-1)*(input.quarter%2===1?1:-1),
      target:Number.isInteger(raw.target)?raw.target:type==='run'?6:8,
      lane:Number.isFinite(raw.lane)?raw.lane:26.6,
      kickDistance:type==='fieldgoal'?117-start:undefined,
      next:{team:state.team,start:state.pos,downNum:state.down,lineToGain:state.lineToGain,
        toGo:round(state.lineToGain-state.pos),quarter:state.quarter,clock:state.clock,reason,finished:state.finished,
        twoMinuteWarnings:{...state.twoMinuteWarnings}}}
    return{play,state};
  }
  function* sampleGameSteps(simulateSnap,options={}){
    if(typeof simulateSnap!=='function')throw new TypeError('simulateSnap callback required');
    const random=options.random||secureRandom;
    let state=initialState(random()<.5?'ill':'iowa');const plays=[];
    const maxPlays=options.maxPlays||400;
    while(!state.finished&&plays.length<maxPlays){
      const type=chooseType(state,random);
      const context={team:state.team,type,start:state.pos,downNum:state.down,
        toGo:round(state.lineToGain-state.pos),lineToGain:state.lineToGain,
        quarter:state.quarter,clock:state.clock,score:copyScore(state.score),
        drive:state.drive,kickDistance:type==='fieldgoal'?117-state.pos:undefined,
        attackDirection:(state.team==='ill'?1:-1)*(state.quarter%2===1?1:-1)};
      const raw=simulateSnap(context,random)||{};
      const resolved=resolveSnap(state,{...raw,type},random);
      plays.push(resolved.play);state=resolved.state;yield resolved.play;
    }
    if(!state.finished)throw new Error('Game exceeded snap limit before regulation ended');
    return{plays,result:{ill:state.score.ill,iowa:state.score.iowa,leadChanges:state.leadChanges,
      winner:state.score.ill===state.score.iowa?null:state.score.ill>state.score.iowa?'ill':'iowa',
      snaps:plays.length},state};
  }
  function sampleGame(simulateSnap,options={}){const steps=sampleGameSteps(simulateSnap,options);let r;do{r=steps.next()}while(!r.done);return r.value;}
  function buildGame(simulateSnap,options={}){
    const minLeadChanges=options.minLeadChanges===undefined?3:options.minLeadChanges;
    const maxAttempts=options.maxAttempts||300;
    for(let attempts=1;attempts<=maxAttempts;attempts++){
      const sample=sampleGame(simulateSnap,options);
      if(sample.result.winner&&sample.result.leadChanges>=minLeadChanges)return{...sample,attempts};
    }
    throw new Error('No competitive regulation game sampled within '+maxAttempts+' attempts');
  }
  return Object.freeze({buildGame,sampleGame,sampleGameSteps,resolveSnap,initialState,chooseType});
})();
