import {plainTextParts} from '@/lib/plain-text-links';
/** Inputs remain native input/textarea controls; only the read view gets anchors. */
export default function PlainTextLinks({text}:{text:string}){
 return <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{plainTextParts(text).map(part=>part.href?<a key={part.start} href={part.href} target="_blank" rel="noopener noreferrer" style={{color:'#60a5fa',textDecoration:'underline',textUnderlineOffset:'2px'}}>{part.text}</a>:part.text)}</span>;
}
