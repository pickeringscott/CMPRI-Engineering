const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const person=(n,name,role,roles)=>({id:id(n),name,short:name.split(' ')[0],initials:name.split(' ').map(part=>part[0]).join(''),role,roles,active:true,taggable:true,recipientSelectable:true});
export const historyPeople=[
  person(701,'Avery Reed','Chief Engineer',['engineer']),
  person(702,'Morgan Ellis','Maintenance Technician',['technician']),
  person(703,'Taylor Quinn','Front Desk',['front_desk']),
  person(704,'Riley Chen','General Manager',['manager']),
];

const scenarios=[
  ['Boiler rounds','Boiler','ul','B-04', 'Gauge face was hard to read in low light.','The replacement gauge is clear. I recorded a second reading.'],
  ['Guest-floor inspections','Guest floor','ol','G-12','The room access schedule changed after lunch.','I moved the last three rooms to the afternoon route.'],
  ['Emergency light walk','Emergency light','letters','E-08','A lens was missing on the west stair landing.','The lens is installed. I added the west landing to tomorrow’s retest.'],
  ['Workshop parts count','Parts bin','checklist','W-16','The stock count excludes the parts arriving Friday.','The shipment arrived and I verified the receiving count.'],
  ['Pool equipment handoff','Pool equipment','ul','P-03','The next reading should be taken after the pump settles.','The follow-up reading is recorded in the handoff sheet.'],
];

const checks=[
  'Verify the inspection card is signed and dated.',
  'Check access, lighting, and housekeeping around the service area.',
  'Compare the identifying label to the latest asset list.',
  'Record a baseline reading before making an adjustment.',
  'Look for evidence of leaks, loose fittings, or damage.',
  'Confirm the spare part is available in the workshop.',
  'Walk the return route and note any access conflicts.',
  'Check that the escalation contact is listed on the handoff.',
  'Cross-check the reading against yesterday’s observations.',
  'Confirm the area can be opened on the next round.',
  'Write the follow-up task on the shift handoff board.',
  'Mark the item ready for the next scheduled inspection.',
  'Check that the replacement supplies are stocked.',
  'Record a second reading from a different position.',
  'Review the notes with the incoming technician.',
  'Return tools and verify the work area is clear.',
];

function makeList(kind,rows,itemId) {
  if(kind==='checklist')return rows.map((row,index)=>`<div class="note-check" contenteditable="false" data-item-id="${index===3?itemId:itemId+'-'+index}" data-task-id="${index===3?itemId:itemId+'-'+index}"><input type="checkbox"><span class="task-label" contenteditable="true">${row}</span></div>`).join('');
  const tag=kind==='ul'?'ul':'ol';
  const listAttrs=kind==='letters'?' type="a" data-format-list="letters"':'';
  return `<${tag}${listAttrs}>${rows.map((row,index)=>`<li data-item-id="${index===3?itemId:itemId+'-'+index}">${row}</li>`).join('')}</${tag}>`;
}

export const historyExamples=scenarios.map(([title,subject,kind,reference,firstReply,secondReply],index)=>{
  const [author,...otherUsers]=historyPeople;
  const firstEditor=otherUsers[index%otherUsers.length],secondEditor=otherUsers[(index+1)%otherUsers.length];
  const noteId=id(750+index),itemId=id(760+index);
  const step=checks.map((text,line)=>`${subject} ${String(line+1).padStart(2,'0')} — ${text}`);
  const finalStep=[...step];
  finalStep[3]=`${subject} 04 — Log the follow-up reading under ${reference} before leaving the area.`;
  finalStep.splice(10,1);
  finalStep.push(`${subject} 17 — Confirm ${reference} is on next shift’s handoff list.`);
  const oldContent=makeList(kind,step,itemId),content=makeList(kind,finalStep,itemId);
  const createdAt=`2026-11-2${index}T21:30:00.000Z`,firstAt=`2026-11-2${index}T22:40:00.000Z`,updatedAt=`2026-11-2${index}T23:50:00.000Z`;
  const earlier={id:id(780+index),authorId:firstEditor.id,authorName:firstEditor.name,at:firstAt,text:firstReply,replies:[]};
  const later={id:id(790+index),authorId:secondEditor.id,authorName:secondEditor.name,at:updatedAt,text:secondReply,replies:[]};
  const earlierThreads={[itemId]:[earlier]},itemThreads={[itemId]:[{...earlier,replies:[later]}]};
  const audience={all:false,roles:['technician'],people:[firstEditor.id,secondEditor.id]};
  const note={
    id:noteId,title:`Synthetic example — ${title}`,content,audience,itemThreads,priority:index===0?'Urgent':'Normal',
    fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Comic Sans MS',ink:[],attachments:[],
    authorId:author.id,authorName:author.name,createdAt,updatedAt,revision:3,
  };
  const version=(revision,actor,at,versionKind,before,after)=>({revision,actorId:actor.id,actorName:actor.name,at,kind:versionKind,before,after});
  return {note,entries:[
    version(3,secondEditor,updatedAt,'updated',{content:oldContent,itemThreads:earlierThreads},{content,itemThreads}),
    version(2,firstEditor,firstAt,'updated',{itemThreads:{}},{itemThreads:earlierThreads}),
    version(1,author,createdAt,'created',{},{title:note.title,content:oldContent,priority:note.priority,audience}),
  ]};
});
