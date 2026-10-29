import {validateGssSourceRows,type GssSourceRow} from './provider-event-contracts';
export type GssRanking = {period:'MTD'|'Wave to Date';rows:GssSourceRow[]};
export type GssReport = {date:string;rankings:GssRanking[]};
/** Only complete, independently agreeing transcriptions can become saved report data. */
export function validateGssReport(value:unknown,date:string):GssReport {
 if(!value||typeof value!=='object')throw Error('GSS extraction missing');
 const v=value as {date?:unknown;complete?:unknown;uncertainties?:unknown;rankings?:unknown};
 if(v.date!==date||v.complete!==true||!Array.isArray(v.uncertainties)||v.uncertainties.length||!Array.isArray(v.rankings)||v.rankings.length!==2)throw Error('GSS source coverage is not verified');
 const rankings=v.rankings as GssRanking[];
 if(rankings[0].period!=='MTD'||rankings[1].period!=='Wave to Date')throw Error('GSS source periods not verified');
 for(const ranking of rankings)validateGssSourceRows(ranking.rows);
 const normalize=(rows:GssSourceRow[])=>rows.map(r=>({property:r.property.trim(),sampleSize:r.sampleSize,scores:[...r.scores],color:r.color,trend:r.trend}));
 return {date,rankings:rankings.map(r=>({period:r.period,rows:normalize(r.rows)}))};
}
export async function extractAgreedGss(date:string,extract:(pass:number)=>Promise<unknown>) {
 const first=validateGssReport(await extract(1),date),second=validateGssReport(await extract(2),date);
 if(JSON.stringify(first)!==JSON.stringify(second))throw Error('Independent GSS transcriptions disagree; previous report retained');
 return first;
}
