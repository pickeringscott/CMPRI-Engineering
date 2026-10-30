"""Read retained workbook extraction; prepare evidence only, never execute imports."""
import pathlib,json,csv,io,re,datetime,sys
root=pathlib.Path(sys.argv[1]);text=(root/'workbook-library-extracted-text.txt').read_text(encoding='utf-8')
parts=re.split(r'<PARSED TEXT FOR SHEET:.*?\nTAB NAME: (.*?)>\n',text)
tabs={parts[i]:list(csv.reader(io.StringIO(parts[i+1]))) for i in range(1,len(parts),2)}
cat=json.loads(pathlib.Path('src/lib/pm/source-catalog.json').read_text(encoding='utf-8'))
norm=lambda value:re.sub(r'\s+',' ',value).strip().lower()
daily={norm(x['label']):x['id'] for x in cat['daily']};weekly={norm(x['label']):x['id'] for x in cat['weekly']}
facts=[];issues=[]
def add(sheet,row,col,kind,value,**extra):
 facts.append(dict(sheet=sheet,extractedRow=row,extractedColumn=col,kind=kind,value=value,**extra))
for name,rows in tabs.items():
 if name.isdigit():
  for row in rows:
   if len(row)<6 or not re.fullmatch(r'\d{3}',row[1]):continue
   for q in range(1,5):
    raw=row[q+1]
    if not raw:continue
    try:
     date=datetime.date.fromisoformat(raw[:10])
     if date.year!=int(name) or (date.month-1)//3+1!=q:raise ValueError('outside sheet year/quarter')
     add(name,row[0],q+1,'room-completion',raw,room=row[1],quarter=q,date=date.isoformat())
    except ValueError:issues.append(dict(sheet=name,room=row[1],quarter=q,raw=raw,reason='Malformed or mismatched date; not converted'))
  # Preserve additional source planning/compliance cells without guessing their meaning.
  for row in rows[1:]:
   for col,value in enumerate(row[7:],7):
    if value:add(name,row[0],col,'planning-or-compliance-source-cell',value)
  continue
 month=next(m for m in cat['months'] if m['month']==name)
 dates=next(row for row in rows if row[0]=='3')
 tasks={norm(t['label']):t['id'] for t in month['tasks']}
 for row in rows[1:]:
  label=norm(row[1]) if len(row)>1 else ''
  if label in daily:
   for col,value in enumerate(row[2:],2):
    if value.lower()!='true':continue
    raw=dates[col] if col<len(dates) else ''
    try:
     date=datetime.date.fromisoformat(raw[:10])
     if date.year!=2026:raise ValueError('different year')
     add(name,row[0],col,'daily-rollup' if daily[label]=='daily-21' else 'daily-task',True,itemId=daily[label],date=date.isoformat())
    except ValueError:issues.append(dict(sheet=name,row=row[0],column=col,rawDate=raw,reason='Checked daily cell has no valid 2026 date; not converted'))
  elif label in weekly or label=='weekly checklist completion':
   for col,value in enumerate(row[2:],2):
    if value.lower()=='true':add(name,row[0],col,'weekly-rollup' if label=='weekly checklist completion' else 'weekly-task',True,itemId=weekly.get(label),weekSlot=(col-13)//7+1,periodResolution='Retain corporate month/WK slot; do not silently convert to Monday dates')
  if len(row)>3 and norm(row[3]) in tasks and row[1].lower() in ['true','false']:
   add(name,row[0],1,'monthly-task',row[1].lower()=='true',itemId=tasks[norm(row[3])])
out={'sourceLibraryId':'libfile_37ca4e1af32481919e4e2a00117a702c','sourceType':'retained full Library text extraction, not raw XLSX','tabs':list(tabs),'facts':facts,'unresolved':issues,'limits':['Raw formulas, merged cells, comments, hyperlinks and exact original cell coordinates must be joined from cloud raw-workbook inspection.','Weekly slots are preserved, not guessed as calendar Mondays.','Source false does not overwrite later app completion; existing user records require per-cell conflict checking.']}
(root/'program-source-facts.json').write_text(json.dumps(out,indent=2)+'\n')
from collections import Counter
print(json.dumps({'tabs':len(tabs),'facts':dict(Counter(f['kind'] for f in facts)),'unresolved':issues}))
