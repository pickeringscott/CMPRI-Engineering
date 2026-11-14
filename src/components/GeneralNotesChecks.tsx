"use client";
import type {NoteToken} from './GeneralNotesMentions';
import {noteTextRange,type NoteEditorHandle} from './GeneralNotesText';
import {useLayoutEffect,useRef,useState,type RefObject,type CSSProperties} from 'react';
type Mark={offset:number;left:number;top:number;width:number;height:number;size:number;color:string;checked?:boolean;label:string;token?:NoteToken};
/** Measure the actual rich editor so mixed font sizes, wrapping and hit targets agree. */
export default function GeneralNotesChecks({field,text,fontSize,disabled,onToggle,tokens,stylesKey}:{field:RefObject<NoteEditorHandle|null>;text:string;fontSize:number;disabled:boolean;onToggle:(offset:number)=>void;tokens:NoteToken[];stylesKey:string}){
 const layer=useRef<HTMLDivElement>(null),[marks,setMarks]=useState<Mark[]>([]),tokenKey=JSON.stringify(tokens);
 useLayoutEffect(()=>{const editor=field.current?.element;if(!editor)return;
  function measure(){if(!editor)return;const box=editor.getBoundingClientRect(),next:Mark[]=[];
   function mark(start:number,end:number,label:string,token?:NoteToken,checked?:boolean){const range=noteTextRange(editor!,start,end),style=getComputedStyle(range.startContainer.parentElement||editor!);for(const rect of Array.from(range.getClientRects()))if(rect.width)next.push({offset:start,left:rect.left-box.left+editor!.scrollLeft,top:rect.top-box.top+editor!.scrollTop,width:rect.width,height:rect.height,size:parseFloat(style.fontSize),color:style.color,label,token,checked})}
   for(const match of text.matchAll(/^([ \t]*)([☐☑]) /gm)){const offset=match.index!+match[1].length;mark(offset,offset+1,text.slice(offset+2).split('\n')[0].trim()||'List item',undefined,match[2]==='☑')}
   for(const token of JSON.parse(tokenKey) as NoteToken[])if(token.href)mark(token.start,token.end,text.slice(token.start,token.end),token);
   setMarks(next);
  }
  function scroll(){if(layer.current)layer.current.style.transform=`translate(${-editor!.scrollLeft}px,${-editor!.scrollTop}px)`}
  measure();scroll();const observer=new ResizeObserver(measure);observer.observe(editor);editor.addEventListener('scroll',scroll,{passive:true});document.fonts?.addEventListener('loadingdone',measure);return()=>{observer.disconnect();editor.removeEventListener('scroll',scroll);document.fonts?.removeEventListener('loadingdone',measure)};
 },[field,text,fontSize,tokenKey,stylesKey]);
 return <div className="general-notes-check-clip"><div ref={layer} className="general-notes-check-layer general-notes-rich-layer">{marks.map((mark,i)=>mark.token?<a key={'link-'+i} href={mark.token.href} target={mark.token.external?'_blank':undefined} rel={mark.token.external?'noopener noreferrer':undefined} aria-label={mark.label} tabIndex={disabled?-1:0} style={{position:'absolute',left:mark.left,top:mark.top,width:mark.width,height:mark.height,pointerEvents:disabled?'none':'auto'}}/>:<button key={'check-'+i} type="button" role="checkbox" aria-checked={mark.checked} aria-label={mark.label} disabled={disabled} style={{left:mark.left,top:mark.top,width:mark.width,height:mark.height,'--note-font-size':mark.size+'px',color:mark.color} as CSSProperties} onPointerDown={event=>event.preventDefault()} onClick={()=>onToggle(mark.offset)}><svg viewBox="0 0 20 20" aria-hidden="true" style={{width:mark.size*.9,height:mark.size*.9,minWidth:mark.size*.9,minHeight:mark.size*.9}}><rect x="2" y="2" width="16" height="16" rx="2"/>{mark.checked&&<path d="m5 10 3 3 7-7"/>}</svg></button>)}</div></div>;
}
