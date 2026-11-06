import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { staffManagement, staffRecipients, staffTicketReferences, resolveStaffMentions } from "@/lib/staff-notes";
import { fetchAllPages } from "@/lib/server/paginated-query";
import { staffNoteDirectory } from "@/lib/server/staff-note-directory";
import { selectedStaffMentions, type StaffMentionRange } from "@/lib/staff-note-targets";
import { staffNoteFlagCutoff, staffNoteFlagWindows } from "@/lib/staff-note-flags";
import { workOrderNumber } from "@/lib/work-order-reference.js";
import { profileHasRole } from "@/lib/server/roles";
import { isWithinNotificationSchedule, normalizeNotificationSettings } from "@/lib/notifications/schedule";
import { STAFF_ATTACHMENT_LIMIT, STAFF_FILE_BUCKET, staffHashtags, staffInlineMedia } from '@/lib/staff-note-media';
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";

const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  try {
    const hotel = auth.principal.hotelId, user = auth.principal.identity.id;
    const inboxOnly = request.nextUrl.searchParams.get("inbox") === "1";
    const [inbox, schedule] = await Promise.all([
      auth.admin.from("cmpri_dashboard_notifications").select("notification_key", { count: "exact" })
        .eq("hotel_id", hotel).eq("recipient_user_id", user).like("notification_key", "staff-note:%").is("read_at", null).is("cleared_at", null).order("recorded_at", { ascending: false }).limit(100),
      auth.admin.from("cmpri_user_notification_schedules").select("timezone,schedule").eq("hotel_id", hotel).eq("user_id", user).maybeSingle(),
    ]);
    if (inbox.error || schedule.error) throw new Error("Unread notes could not be loaded.");
    const settings = normalizeNotificationSettings(schedule.data);
    const frontDesk = profileHasRole(auth.principal.profile, "front_desk");
    const now=new Date();
    const flags=frontDesk?await fetchAllPages<{created_at:string}>((from,to)=>auth.admin.from('cmpri_staff_notes').select('created_at').eq('hotel_id',hotel).gte('created_at',staffNoteFlagCutoff(now)).order('created_at',{ascending:true}).order('id').range(from,to)):null;
    if(flags?.error)throw Error('Note flag could not be loaded.');
    const flagWindows=frontDesk?staffNoteFlagWindows(flags?.data||[],now):[];
    const summary = { flagCount:frontDesk?flagWindows.reduce((sum,w)=>sum+w.count,0):(inbox.count||0), flagWindows, nextFlagChangeAt:flagWindows[0]?.expiresAt||null, unread: inbox.count || 0, unreadKeys: (inbox.data || []).map(r => r.notification_key), frontDesk,
      alertNow: frontDesk || !!(settings && isWithinNotificationSchedule(settings)), userId: user, hotelId: hotel,
      management: staffManagement(auth.principal.profile) };
    if (inboxOnly) return NextResponse.json(summary, { headers });
    const directory = await staffNoteDirectory(auth.admin,hotel);
    const before = request.nextUrl.searchParams.get("before");
    let query = auth.admin.from("cmpri_staff_notes").select("id,author_user_id,author_name,author_name_id,body,parent_id,created_at,attachments,gif_ids,hashtags,mentions")
      .eq("hotel_id", hotel).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
    if (before) {
      const [date, id] = before.split("|");
      if (!uuid.test(id || "") || !Number.isFinite(Date.parse(date))) return NextResponse.json({ error: "Invalid cursor." }, { status: 400, headers });
      const timestamp = new Date(date).toISOString();
      query = query.or(`created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`);
    }
    const tag = request.nextUrl.searchParams.get('tag');
    if (tag) { if (!/^#[\p{L}][\p{L}\p{N}_-]{0,79}$/u.test(tag)) return NextResponse.json({error:'Invalid tag.'},{status:400,headers}); query=query.contains('hashtags',[tag.toLowerCase()]); }
    const result = await query;
    if (result.error) throw new Error("Staff Notes could not be loaded.");
    const notes = result.data || [];
    const parentIds = [...new Set(notes.map(n => n.parent_id).filter(Boolean))];
    const parents = parentIds.length ? await auth.admin.from("cmpri_staff_notes").select("id,author_user_id,author_name,author_name_id,body,parent_id,created_at,attachments,gif_ids,hashtags,mentions").eq("hotel_id", hotel).in("id", parentIds) : { data: [], error: null };
    if (parents.error) throw new Error("Reply context could not be loaded.");
    const all=[...notes,...(parents.data||[])];
    const numbers=[...new Set(all.flatMap(note=>staffTicketReferences(note.body).filter(r=>!(note.mentions||[]).some((m:StaffMentionRange)=>m.start<r.end&&m.end>r.start)).map(r=>r.number)))];
    const selectedIds=[...new Set(all.flatMap(note=>(note.mentions||[]).filter((m:StaffMentionRange)=>m.kind==='work_order').map((m:StaffMentionRange)=>m.id)))];
    const tickets:Record<string,{href:string;preview:string}>={},targets:Record<string,{href:string;preview:string}>={};
    const reader=workOrderReader(auth.principal),ticketCandidates=new Map<string,Map<string,{href:string;preview:string}>>();
    if(reader.canRead&&(numbers.length||selectedIds.length)){
      const columns='id,display_id,hotel_id,status,room,issue';
      const batches=[];
      const values=numbers.flatMap(n=>[n,`workorder_${n}`,`WO-${n}`,`WO#${n}`]);
      for(let at=0;at<values.length;at+=200)batches.push(auth.admin.from('work_orders').select(columns).eq('hotel_id',hotel).in('display_id',values.slice(at,at+200)));
      for(let at=0;at<selectedIds.length;at+=200)batches.push(auth.admin.from('work_orders').select(columns).eq('hotel_id',hotel).in('id',selectedIds.slice(at,at+200)));
      for(const orders of await Promise.all(batches)){
        if(orders.error)throw Error('Ticket access could not be verified.');
        for(const order of orders.data||[])if(canReadWorkOrder(reader,order)){
          const target={href:`/work-orders/${encodeURIComponent(order.id)}`,preview:`${order.room||''} · ${order.issue||''} · ${order.status}`};
          targets[order.id]=target;const number=workOrderNumber(order.display_id);if(number){const matches=ticketCandidates.get(number)||new Map();matches.set(order.id,target);ticketCandidates.set(number,matches)}
        }
      }
    }
    for(const [number,matches]of ticketCandidates)if(matches.size===1)tickets[number]=[...matches.values()][0];
    const ids = [...notes,...(parents.data || [])].filter(n=>Array.isArray(n.attachments)&&n.attachments.length).map(n=>n.id);
    const urls = new Map<string,string>();
    if (ids.length) {
      const files=await auth.admin.from('cmpri_staff_note_uploads').select('id,note_id,storage_path,name,media_type').eq('hotel_id',hotel).eq('ready',true).in('note_id',ids);
      if(files.error)throw Error('Attachments could not be loaded.');
      for(let at=0;at<(files.data||[]).length;at+=200){
        const batch=(files.data||[]).slice(at,at+200);
        const signed=await auth.admin.storage.from(STAFF_FILE_BUCKET).createSignedUrls(batch.map(f=>f.storage_path),3600);
        if(signed.error)throw Error('Attachments could not be opened.');
        for(const file of batch){const url=signed.data?.find(u=>u.path===file.storage_path)?.signedUrl;if(url)urls.set(file.note_id+':'+file.id,staffInlineMedia(file.media_type)?url:url+'&download='+encodeURIComponent(file.name));}
      }
    }
    const project=(note:typeof notes[number])=>({...note,attachments:(Array.isArray(note.attachments)?note.attachments:[]).map((file:{id:string})=>({...file,url:urls.get(note.id+':'+file.id)}))});
    const tags=await auth.admin.rpc('cmpri_staff_note_tags',{p_hotel:hotel});
    if(tags.error)throw Error('Tags could not be loaded.');
    const last = notes.at(-1);
    return NextResponse.json({ ...summary, userId:user, notes:notes.map(project), parents:(parents.data||[]).map(project), tickets, targets, tags:Array.isArray(tags.data)?tags.data:[],
      mentions: directory.mentions.map(m=>({id:m.id,kind:m.kind,label:m.label,description:m.description,userIds:[]})),
      next: notes.length === 100 && last ? `${last.created_at}|${last.id}` : null }, { headers });
  } catch { return NextResponse.json({ error: "Staff Notes could not be loaded. Try again." }, { status: 503, headers }); }
}
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  const input = await request.json().catch(() => null);
  const uploads=input?.uploadIds ?? [], gifs=input?.gifIds ?? [];
  if (!input || typeof input.body !== 'string' || input.body.length>4000 || !uuid.test(input.requestId||'') || (input.parentId!=null&&!uuid.test(input.parentId))
    || !Array.isArray(uploads)||!Array.isArray(gifs)||uploads.length+gifs.length>STAFF_ATTACHMENT_LIMIT
    || uploads.some((id:unknown)=>typeof id!=='string'||!uuid.test(id))||new Set(uploads).size!==uploads.length
    || gifs.some((id:unknown)=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(id))||new Set(gifs).size!==gifs.length
    || (!input.body.trim()&&!uploads.length&&!gifs.length)) return NextResponse.json({error:'Enter a comment of up to 4,000 characters or attach media (20 maximum).'},{status:400,headers});
  const frontDesk = profileHasRole(auth.principal.profile,'front_desk');
  // Shared Front Desk names are captured display names, never account/profile assignments.
  const name=typeof input.staffName==='string'?input.staffName.trim().replace(/\s+/g,' '):'';
  if(frontDesk&&(!name||name.length>80||/^(front\s*desk|staff)$/i.test(name)||/[\x00-\x1f\x7f]/.test(name)))return NextResponse.json({error:'Enter your name.'},{status:400,headers});
  let nameId:string|null=null;
  let author=frontDesk?name:(auth.principal.profile.full_name?.trim().split(/\s+/)[0]||'Staff');
  try {
    const {profiles,mentions:directory}=await staffNoteDirectory(auth.admin,auth.principal.hotelId);
    const selected=selectedStaffMentions(input.body,input.mentions);
    if(!selected)return NextResponse.json({error:'A mention was edited or is invalid. Reselect it before posting.'},{status:400,headers});
    const ticketSelections=selected.filter(m=>m.kind==='work_order'),ticketTargets=[];
    if(ticketSelections.length){
      if(ticketSelections.some(m=>!uuid.test(m.id)))return NextResponse.json({error:'Invalid work-order reference.'},{status:400,headers});
      const orders=await auth.admin.from('work_orders').select('id,display_id,hotel_id').eq('hotel_id',auth.principal.hotelId).in('id',ticketSelections.map(m=>m.id));
      if(orders.error)throw Error('Ticket access could not be verified.');
      const reader=workOrderReader(auth.principal);
      for(const order of orders.data||[])if(canReadWorkOrder(reader,order)){const number=workOrderNumber(order.display_id);if(number)ticketTargets.push({id:order.id,kind:'work_order' as const,label:'WO#'+number,userIds:[]})}
    }
    let mentions:StaffMentionRange[];
    try{mentions=resolveStaffMentions(input.body,selected,[...directory,...ticketTargets])}catch{return NextResponse.json({error:'A selected mention is no longer available. Reselect it before posting.'},{status:400,headers})}
    // Retain established #number / @number / WO#number references as ticket identities too.
    const references=staffTicketReferences(input.body).filter(r=>!mentions.some(m=>m.start<r.end&&m.end>r.start));
    if(references.length){
      const numbers=[...new Set(references.map(r=>r.number))];
      if(numbers.length>100)return NextResponse.json({error:'Use up to 100 references per note.'},{status:400,headers});
      const orders=await auth.admin.from('work_orders').select('id,display_id,hotel_id').eq('hotel_id',auth.principal.hotelId).in('display_id',numbers.flatMap(n=>[n,`workorder_${n}`,`WO-${n}`,`WO#${n}`]));
      if(orders.error)throw Error('Ticket access could not be verified.');
      const reader=workOrderReader(auth.principal);
      for(const ref of references){const candidates=(orders.data||[]).filter(o=>canReadWorkOrder(reader,o)&&workOrderNumber(o.display_id)===ref.number);if(candidates.length===1)mentions.push({start:ref.start,end:ref.end,id:candidates[0].id,kind:'work_order',label:ref.label})}
    }
    if(mentions.length>100)return NextResponse.json({error:'Use up to 100 mentions/references per note.'},{status:400,headers});
    const trimmed=input.body.trim(),offset=input.body.length-input.body.trimStart().length;
    mentions=mentions.map(m=>({...m,start:m.start-offset,end:m.end-offset})).sort((a,b)=>a.start-b.start);
    const recipients=staffRecipients(trimmed,profiles,mentions);
    if(frontDesk){
      const capture=await auth.admin.rpc('cmpri_capture_staff_note_name',{p_hotel:auth.principal.hotelId,p_actor:auth.principal.identity.id,p_name:name});
      const saved=Array.isArray(capture.data)?capture.data[0]:null;
      if(capture.error||!saved)throw Error('Name could not be saved.');nameId=saved.id;
      // An existing canonical display name is reused; no profile is changed.
      author=saved.name;
    }
    const result = await auth.admin.rpc("cmpri_post_staff_note_with_mentions", { p_hotel: auth.principal.hotelId, p_author: auth.principal.identity.id,
      p_name: author, p_body: trimmed, p_parent: input.parentId || null, p_request: input.requestId, p_recipients: recipients, p_uploads:uploads, p_hashtags:staffHashtags(input.body), p_gifs:gifs, p_mentions:mentions, p_name_id:nameId });
    if (result.error) throw new Error("Post failed");
    // Durable delivery intents are committed by the same transaction as the post.
    // The existing scheduled dispatcher retries any provider failures.
    after(async () => { await Promise.allSettled(recipients.filter(r => r.push).map(recipient => dispatchWebPushNotifications(auth.admin, recipient.user_id,
      profiles.find(p => p.id === recipient.user_id)!, [{ id: `staff-note:${result.data}`, message: `${author} posted in Staff Notes.`, target_path: `/staff-notes#note-${result.data}` }]))); });
    return NextResponse.json({ id: result.data }, { headers });
  } catch { return NextResponse.json({ error: "Not confirmed saved. Retry keeps the same request and will not duplicate your post." }, { status: 503, headers }); }
}
export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  const input = await request.json().catch(() => null);
  if (!Array.isArray(input?.ids) || input.ids.length > 500 || input.ids.some((id: unknown) => typeof id !== "string" || !uuid.test(id))) return NextResponse.json({ error: "Invalid notes." }, { status: 400, headers });
  if (input.ids.length) {
    const result = await auth.admin.from("cmpri_dashboard_notifications").update({ read_at: new Date().toISOString() })
      .eq("hotel_id", auth.principal.hotelId).eq("recipient_user_id", auth.principal.identity.id)
      .in("notification_key", input.ids.map((id: string) => `staff-note:${id}`)).is("read_at", null);
    if (result.error) return NextResponse.json({ error: "Read status could not be saved." }, { status: 503, headers });
  }
  return NextResponse.json({ ok: true }, { headers });
}
