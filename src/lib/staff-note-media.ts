export const STAFF_FILE_LIMIT = 100 * 1024 * 1024;
export const STAFF_ATTACHMENT_LIMIT = 20;
export const STAFF_FILE_BUCKET = 'staff-note-files';
export type StaffAttachment = {id:string;name:string;type:string;size:number;url?:string};
export function staffFileInput(input: unknown): {id:string;name:string;type:string;size:number} | null {
 if (!input || typeof input !== 'object') return null;
 const value = input as Record<string,unknown>;
 if (Object.keys(value).some(key=>!['id','name','type','size'].includes(key))) return null;
 if (typeof value.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) return null;
 if (typeof value.name!=='string'||!value.name.trim()||value.name.length>255||/[\x00-\x1f\x7f]/.test(value.name)) return null;
 if (typeof value.size!=='number'||!Number.isSafeInteger(value.size)||value.size<1||value.size>STAFF_FILE_LIMIT) return null;
 if (typeof value.type!=='string'||value.type.length>120||!/^[-\w.+]+\/[-\w.+]+$/.test(value.type)) return null;
 return {id:value.id,name:value.name.trim(),type:value.type.toLowerCase(),size:value.size};
}
export function staffInlineMedia(type:string) { return /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/[-\w.+]+)$/.test(type); }
export function staffHashtags(body:string) { return [...new Set((body.match(/#[\p{L}][\p{L}\p{N}_-]{0,79}/gu)||[]).map(tag=>tag.toLowerCase()))].slice(0,100); }
