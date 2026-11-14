"use client";
import type {NoteToken} from './GeneralNotesMentions';
import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
type Check={offset:number;left:number;top:number;width:number;height:number;checked:boolean;label:string};
/** Keep the native textarea/IME while making its saved checkbox markers clickable.
 * A hidden text mirror measures wrapping using the editor's actual font and width. */
export default function GeneralNotesChecks({field,text,fontSize,disabled,onToggle,tokens}:{field:RefObject<HTMLTextAreaElement|null>;text:string;fontSize:number;disabled:boolean;onToggle:(offset:number)=>void;tokens:NoteToken[]}){
 const rich=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),[checks,setChecks]=useState<Check[]>([]);
 useLayoutEffect(()=>{
  const editor=field.current;if(!editor)return;
  const mirror=document.createElement('div');mirror.setAttribute('aria-hidden','true');
  Object.assign(mirror.style,{position:'fixed',left:'0',top:'0',visibility:'hidden',pointerEvents:'none',height:'auto',minHeight:'0',border:'0',boxSizing:'border-box',whiteSpace:'pre-wrap',overflowWrap:'break-word'});
  document.body.append(mirror);
  function measure(){
   if(!editor)return;const style=getComputedStyle(editor);
   for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','textIndent','textAlign','direction','tabSize'] as const)mirror.style[key]=style[key];
   mirror.style.width=editor.clientWidth+'px';if(rich.current){for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','textIndent','textAlign','direction','tabSize'] as const)rich.current.style.setProperty(key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),style[key],'important');rich.current.style.width=editor.clientWidth+'px'}mirror.replaceChildren();
   let at=0;const markers:{node:HTMLSpanElement;offset:number;checked:boolean;label:string}[]=[];
   for(const match of text.matchAll(/^([ \t]*)([☐☑]) /gm)){
    const offset=match.index!+match[1].length;mirror.append(document.createTextNode(text.slice(at,offset)));
    const node=document.createElement('span');node.textContent=match[2];mirror.append(node);
    markers.push({node,offset,checked:match[2]==='☑',label:text.slice(offset+2).split('\n')[0].trim()||'List item'});at=offset+1;
   }
   mirror.append(document.createTextNode(text.slice(at)||'\u200b'));const box=mirror.getBoundingClientRect();
   setChecks(markers.map(({node,...check})=>{const rect=node.getBoundingClientRect();return{...check,left:rect.left-box.left,top:rect.top-box.top,width:rect.width,height:rect.height}}));
  }
  function scroll(){if(layer.current)layer.current.style.transform=`translate(${-editor!.scrollLeft}px,${-editor!.scrollTop}px)`}
  measure();scroll();const observer=new ResizeObserver(measure);observer.observe(editor);editor.addEventListener('scroll',scroll,{passive:true});document.fonts?.addEventListener('loadingdone',measure);
  return()=>{observer.disconnect();editor.removeEventListener('scroll',scroll);document.fonts?.removeEventListener('loadingdone',measure);mirror.remove()};
 },[field,text,fontSize]);
 const parts:React.ReactNode[]=[];let at=0;for(const token of tokens){if(token.start<at)continue;parts.push(text.slice(at,token.start));const label=text.slice(token.start,token.end);parts.push(token.href?<a key={token.start} href={token.href} target={token.external?'_blank':undefined} rel={token.external?'noopener noreferrer':undefined} tabIndex={disabled?-1:0} style={{pointerEvents:disabled?'none':undefined}}>{label}</a>:<span key={token.start} data-note-mention={token.kind}>{label}</span>);at=token.end}parts.push(text.slice(at));
 return <div className="general-notes-check-clip"><div ref={layer} className="general-notes-check-layer"><div ref={rich} className="general-notes-rich-layer">{parts}</div>{checks.map(check=><button key={check.offset} type="button" role="checkbox" aria-checked={check.checked} aria-label={check.label} disabled={disabled} style={{left:check.left,top:check.top,width:check.width,height:check.height,fontSize}} onPointerDown={event=>event.preventDefault()} onClick={()=>onToggle(check.offset)}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="2"/>{check.checked&&<path d="m5 10 3 3 7-7"/>}</svg></button>)}</div></div>;
}
