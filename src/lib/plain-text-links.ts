export type PlainTextPart={text:string;href?:string;start:number;end:number};
/** Returns text tokens only. Never parses or renders supplied HTML. */
export function plainTextParts(text:string):PlainTextPart[]{
 const result:PlainTextPart[]=[];let at=0;
 for(const match of text.matchAll(/(?<![\w:/])https?:\/\/[^\s<>"'`\u0000-\u0020\u007f-\u009f]+/gi)){
  let url=match[0].replace(/[.,;:!?]+$/g,'');
  for(const [open,close]of [['(',')'],['[',']'],['{','}']])while(url.endsWith(close)&&url.split(close).length>url.split(open).length)url=url.slice(0,-1);
  url=url.replace(/[.,;:!?]+$/g,'');
  try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname||url.includes('\\'))continue;}catch{continue;}
  const start=match.index!,end=start+url.length;
  if(start>at)result.push({text:text.slice(at,start),start:at,end:start});
  result.push({text:url,href:url,start,end});at=end;
 }
 if(at<text.length)result.push({text:text.slice(at),start:at,end:text.length});
 return result;
}
