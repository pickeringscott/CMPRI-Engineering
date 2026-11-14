"use client";
import {useEffect,useRef,type PointerEvent as ReactPointerEvent} from 'react';
import type {InkPoint,InkStroke} from '@/lib/general-notes';
const NS='http://www.w3.org/2000/svg';
function segment(stroke:InkStroke,index:number){
 const a=stroke.points[Math.max(0,index-1)],b=stroke.points[index],line=document.createElementNS(NS,'line');
 for(const [key,value]of Object.entries({x1:a.x,y1:a.y,x2:b.x+(index===0?.01:0),y2:b.y,stroke:stroke.color,'stroke-width':stroke.size*(.5+b.p),'stroke-linecap':'round'}))line.setAttribute(key,String(value));
 return line;
}
function group(stroke:InkStroke){const g=document.createElementNS(NS,'g');g.dataset.stroke=stroke.id;const fragment=document.createDocumentFragment();stroke.points.forEach((_,i)=>fragment.append(segment(stroke,i)));g.append(fragment);return g}
type Active={id:number;rect:DOMRect;stroke?:InkStroke;group?:SVGGElement;before:InkStroke[]};
export default function GeneralNotesInk({strokes,mode,color,width,scroller,onChange,onType}:{strokes:InkStroke[];mode:'text'|'pen'|'eraser';color:string;width:number;scroller:React.RefObject<HTMLDivElement|null>;onChange:(strokes:InkStroke[])=>void;onType:()=>void}){
 const svg=useRef<SVGSVGElement>(null),data=useRef(strokes),active=useRef<Active|null>(null),finger=useRef<{id:number;x:number;y:number;lastY:number;moved:boolean}|null>(null);
 useEffect(()=>{data.current=strokes;const fragment=document.createDocumentFragment();strokes.forEach(stroke=>fragment.append(group(stroke)));svg.current?.replaceChildren(fragment)},[strokes]);
 function point(event:PointerEvent,rect:DOMRect):InkPoint{return{x:Math.max(0,Math.min(800,(event.clientX-rect.left)*800/rect.width)),y:Math.max(0,Math.min(1100,(event.clientY-rect.top)*1100/rect.height)),p:event.pointerType==='pen'?(event.pressure||.3):.5}}
 function erase(event:PointerEvent){const current=active.current;if(!current)return;const p=point(event,current.rect),radius=18*800/current.rect.width;
  const ids=new Set(data.current.filter(stroke=>stroke.points.some((b,i)=>{const a=stroke.points[Math.max(0,i-1)],dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<radius})).map(stroke=>stroke.id));
  if(!ids.size)return;data.current=data.current.filter(stroke=>!ids.has(stroke.id));for(const child of Array.from(svg.current?.children||[]))if(ids.has((child as SVGGElement).dataset.stroke||''))child.remove();
 }
 function append(event:PointerEvent){const current=active.current;if(!current?.stroke||!current.group)return;const samples=event.getCoalescedEvents?.(),fragment=document.createDocumentFragment();for(const sample of samples?.length?samples:[event]){const p=point(sample,current.rect),last=current.stroke.points.at(-1);if(last?.x===p.x&&last?.y===p.y)continue;current.stroke.points.push(p);fragment.append(segment(current.stroke,current.stroke.points.length-1))}current.group.append(fragment)}
 function down(event:ReactPointerEvent<SVGSVGElement>){if(mode==='text'||active.current||event.button!==0)return;
  if(event.pointerType==='touch'){if(finger.current)return;finger.current={id:event.pointerId,x:event.clientX,y:event.clientY,lastY:event.clientY,moved:false};event.currentTarget.setPointerCapture(event.pointerId);return}
  finger.current=null;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const rect=event.currentTarget.getBoundingClientRect();active.current={id:event.pointerId,rect,before:data.current};
  if(mode==='eraser'){erase(event.nativeEvent);return}
  // Resolve a palette token once. Original ink does not change when the app theme changes.
  const marker=document.createElementNS(NS,'g');marker.style.color=color;event.currentTarget.append(marker);const resolved=getComputedStyle(marker).color;marker.remove();
  const stroke:InkStroke={id:crypto.randomUUID(),color:resolved,size:width,points:[point(event.nativeEvent,rect)]},g=group(stroke);data.current=[...data.current,stroke];active.current.stroke=stroke;active.current.group=g;event.currentTarget.append(g);
 }
 function move(event:ReactPointerEvent<SVGSVGElement>){const touch=finger.current;
  if(touch?.id===event.pointerId){if(Math.hypot(event.clientX-touch.x,event.clientY-touch.y)>10)touch.moved=true;if(touch.moved&&scroller.current)scroller.current.scrollBy({top:touch.lastY-event.clientY});touch.lastY=event.clientY;return}
  if(active.current?.id!==event.pointerId)return;event.preventDefault();if(mode==='eraser')erase(event.nativeEvent);else append(event.nativeEvent);
 }
 function end(event:ReactPointerEvent<SVGSVGElement>){const touch=finger.current;
  if(touch?.id===event.pointerId){const tap=event.type==='pointerup'&&!touch.moved&&Math.hypot(event.clientX-touch.x,event.clientY-touch.y)<=10;finger.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(tap)onType();return}
  const current=active.current;if(current?.id!==event.pointerId)return;if(event.type==='pointerup'&&current.stroke)append(event.nativeEvent);active.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(current.before!==data.current)onChange(data.current);
 }
 return <svg ref={svg} className="general-notes-ink" data-ink-layer="true" style={{pointerEvents:mode==='text'?'none':'auto'}} viewBox="0 0 800 1100" role="img" aria-label="Handwriting. In pen mode, fingers scroll or tap to type." onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}/>;
}
