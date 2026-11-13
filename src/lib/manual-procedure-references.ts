import type { ManualSymptomRule } from './manual-knowledge';
import type { ManualHtmlPage } from './manual-document-html';

/** Resolve explicit named references using source text only; ambiguous targets stay source references. */
export function resolveManualProcedureReferences(rules: ManualSymptomRule[], pages: ManualHtmlPage[]): ManualSymptomRule[] {
  return rules.map(rule=>{
    const sourcePages=new Set(rule.source_pages), steps:string[]=[];
    let unresolved=false;
    for(const step of rule.steps){
      const references=[...step.matchAll(/\b(?:[Pp]erform|[Ff]ollow|[Uu]se)\s+(?:(?:a|the)\s+)?([A-Z][a-z]+(?:[ -][A-Z][a-z]+){1,3})(?=[.!;,]|$)/g)];
      let expanded=step;
      for(const reference of references){
        const name=reference[1], targets:{page:number;text:string}[]=[];
        for(const page of pages){
          const lines=page.text.split('\n').map(line=>line.trim()).filter(Boolean);
          for(let index=0;index<lines.length;index++){
            if(!/^1[.)]\s+/.test(lines[index]))continue;
            const preamble=lines.slice(Math.max(0,index-5),index).join('\n');
            if(!preamble.toLowerCase().includes(name.toLowerCase()))continue;
            const body:string[]=[];let ordinal=1;
            for(let next=index;next<lines.length;next++){
              const line=lines[next], numbered=line.match(/^(\d+)[.)]\s+/);
              if(numbered){if(Number(numbered[1])!==ordinal)break;ordinal++;body.push(line);}
              else if(body.length && (!/[.!?]$/.test(body.at(-1)!) || /^[a-z]/.test(line)))body[body.length-1]+=' '+line;
              else break;
            }
            if(ordinal>=3 && body.every(line=>/[.!?]$/.test(line)))targets.push({page:page.page,text:body.join('\n')});
          }
        }
        const unique=[...new Map(targets.map(t=>[`${t.page}:${t.text}`,t])).values()];
        if(unique.length===1){sourcePages.add(unique[0].page);expanded+=`\nSource procedure: ${name} (PDF page ${unique[0].page})\n${unique[0].text}`;}
        else unresolved=true;
      }
      steps.push(expanded);
    }
    return {...rule,steps,source_pages:[...sourcePages].sort((a,b)=>a-b),...(unresolved?{reference_only:true}:{})};
  });
}
