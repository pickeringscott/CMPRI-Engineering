export type ManualPageQuality = { page: number; text: string; needs_ocr: boolean; reason?: string; printed_label?: string };

/** Text presence alone cannot establish readable coverage. No measurements are inferred. */
export function manualTextQuality(text: string, hasImage = false) {
  const clean=text.trim();
  if(!clean)return {needs_ocr:hasImage,reason:hasImage?'Image-only page':'Blank page'};
  const damaged=(clean.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]/g)||[]).length;
  const replacement=(clean.match(/\uFFFD/g)||[]).length;
  if((damaged>12&&damaged/clean.length>.04)||replacement>2)return {needs_ocr:true,reason:'Damaged character mapping'};
  if(hasImage && clean.length<150)return {needs_ocr:true,reason:'Page image has little searchable text'};
  return {needs_ocr:false};
}
