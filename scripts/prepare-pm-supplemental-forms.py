"""Build six PM definitions from the verified source texts; never insert completions."""
import json, pathlib, re, sys
docs=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
out=[]
for doc in docs:
 name=doc['title']; text=doc['content']; lines=[s.strip() for s in text.splitlines() if s.strip()]
 slug=re.sub(r'[^a-z0-9]+','-',name[:-4].lower()).strip('-')
 fields=[]; rows=[]; items=[]; scope='equipment'; cadence='monthly'; months=None
 instructions=text
 if name=='Tool Inventory.pdf':
  scope='property'
  fields=[{'id':'inventoryType','label':'Inventory scope','type':'select','options':['Monthly major tools','Semiannual total inventory','New manager inventory'],'required':True},
          {'id':'manager','label':'Maintenance manager / supervisor','type':'text'}, {'id':'generalManager','label':'General manager','type':'text'}]
  rows=[{'id':k,'label':label,'type':typ,'required':k in ['quantity','item']} for k,label,typ in [('quantity','Quantity','number'),('item','Item','text'),('make','Make','text'),('model','Model','text'),('location','Location','text')]]
  instructions='Inventory major/high-value tools monthly. Total inventory is due by the end of January and June and within two weeks of hiring a maintenance manager. Submit to the GM, retain a copy, and upload to the Facilities drive. Record the actual inventory type and date; no automatic upload is performed.'
 elif name=='Shuttle.pdf':
  cadence='quarterly'; months=[3,6,9,12]
  items=lines[lines.index('Ensure vehicle is clean and inviting for guests, interior and exterior'):lines.index('NOTES')]
 elif name=='RTU Monthly.pdf':
  items=['Turn off all power before performing maintenance on rooftop HVAC units.']
  a=next(i for i,s in enumerate(lines) if s.startswith('Replace all air filters'))
  b=next(i for i,s in enumerate(lines) if s.startswith('Utilize water'))
  items+=lines[a:b]
  items.append('Clean with low-pressure water from inside out; if needed use non-acidic coil cleaner and rinse after five minutes. Never leave cleaner on coils longer than five minutes.')
 elif name=='Monthly Air Handler.pdf':
  a=next(i for i,s in enumerate(lines) if s.startswith('Turn off the power:'))
  items=lines[a:lines.index('NOTES')]
 elif name=='Split Unit.pdf':
  a=lines.index('INDOOR HEAD UNIT')+1; b=lines.index('OUTDOOR CONDENSING UNIT')
  items=lines[a:b]+['Turn off all power before maintaining the outdoor condensing unit.']
  a=next(i for i,s in enumerate(lines) if s.startswith('Remove any vegetation'))
  items+=lines[a:a+2]
  items.append('Clean coils with low-pressure water; if needed use non-acidic cleaner and rinse after five minutes. Never leave coil cleaner on longer than five minutes.')
 elif name=='2025 Winter Preparedness Checklist.pdf':
  scope='property'
  # Source paragraph boundaries, including the continued lines printed on the PDF.
  starts=('Training on','Make sure all stairwell','Make sure there is adequate','Ensure all buildings','Insulating piping','Verify all roof','Ensure any extended','If you have','Check Fire Pumps','Ensure continuous','Ensure automatic','Make sure fire panel','Make sure PIC','Discuss who','Flush and winterize','Have wet floor','Talk to staff','Service and tune','Ensure Storm','Have the following','Ensure Snow','Mark curbs','Post snow','It is imperative')
  for line in lines[4:]:
   if line.startswith(starts): items.append(line)
   elif items: items[-1]+=' '+line
  # Workbook placement controls when this annual checklist is due.
  cat=json.loads(pathlib.Path('src/lib/pm/source-catalog.json').read_text(encoding='utf-8'))
  months=[i+1 for i,m in enumerate(cat['months']) if any(name in t.get('references',[]) for t in m['tasks'])]
  assert months, 'Winter checklist must have verified workbook placement'
 else: raise ValueError(name)
 if scope=='equipment': fields=[{'id':'unitIdentifier','label':'Unit / vehicle identifier or location','type':'text','required':True}]
 out.append({'id':'pdf:'+slug,'title':name[:-4], 'sourceFile':name,'sourceReference':doc['url'],
  'cadence':cadence,'scope':scope,'kind':'log' if rows else 'inspection',
  **({'months':months} if months else {}),'instructions':instructions,
  'fields':[{'id':'inspectionDate','label':'Inspection date','type':'date'},*fields,{'id':'notes','label':'Inspection notes','type':'textarea'}],
  'checklist':[{'id':slug+'-item-'+str(i+1),'label':label,'source':doc['url']} for i,label in enumerate(items)],
  **({'repeatableFields':rows,'repeatableLabel':'Inventory items'} if rows else {}),
  'sourceMetadata':{'drive_id':doc['id'],'source_text':text}})
pathlib.Path('src/lib/pm/supplemental-forms.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({x['sourceFile']:len(x['checklist']) for x in out}))
