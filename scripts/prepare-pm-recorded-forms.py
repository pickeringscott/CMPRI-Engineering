"""Local-only compiler for the already-reviewed binder ledger. Never contacts a service.
The exact source page is fingerprinted; runtime projection refuses changed evidence.
No dates, completion flags, proposal responses or room-history records are written.
"""
import json, pathlib, re, hashlib, sys
source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
data = json.loads(source.read_text(encoding='utf-8-sig'))
# Explicit reviewed quarter marks; numbers refer to numbered definitions on THAT page.
quarter_marks = {
22:{1:list(range(1,8)),2:list(range(1,8)),3:list(range(1,8))},
23:{1:[1,2,3,4,5,8,9,10,11,12,13,14],2:[2],3:[2,4,5,8,9,10,11,12]},
24:{1:[1,2,3,4,5,9],3:[2,3,4,5,8]},
25:{1:[2,3,5,6,8,9,10,11],3:[1,2,7,8,9,10,11,12]},
26:{1:[3,5,6,7,8],3:[1,2,3,4,5,6,7]},
27:{1:[1,2,5,6,7,8,9,11],3:list(range(1,12))},
30:{1:list(range(1,10)),2:list(range(1,10)),3:list(range(1,10))},
31:{1:list(range(1,10)),2:list(range(1,10)),3:[1,2,3,4,5,7,8,9]},
35:{1:[1,3,4,5,6,7,8,9,10,11],2:[1,3,5,6,7,8,9,10,11],3:list(range(1,12))},
36:{1:[1,3,4,5,6,7,8,9,10,11,12,13],2:[1,3,4,5,6,7,8,9,10,11,12,13],3:[1,3,4,5,6,7,8,9,10,11,12,13]},
37:{1:[1,3,4,5,6,7,8,9,10,12,13],3:list(range(1,14))},
38:{1:list(range(1,10)),3:list(range(1,10))},
39:{1:list(range(1,10)),2:list(range(1,10)),3:list(range(1,10))},
40:{1:list(range(1,14)),2:list(range(1,14)),3:list(range(1,14))},
41:{1:list(range(1,11)),2:list(range(1,11)),3:list(range(1,11))},
42:{1:list(range(1,12)),2:list(range(1,12)),3:list(range(1,12))}}
slash = {(23,1):[6],(37,1):[2]}
def fingerprint(p):
    # Match validatePmSource's existing whitespace normalization at original import.
    def normalized(v):
        return v.strip() if isinstance(v,str) else [x.strip() for x in v] if isinstance(v,list) else v
    return hashlib.sha256(json.dumps([normalized(p[k]) for k in ['page','templateId','category','location','frequency','kind','rawDate','observedOn','evidence','findings','unresolved']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
out=[]
for p in data['pages'][:42]:
    n=p['page']; evidence=p['evidence']; forms=[]
    definitions=re.findall(r'^(\d+)\. (.+)$',evidence,re.M)
    if n in quarter_marks:
        for q in range(1,5):
            rows=[]
            for number,label in definitions:
                number=int(number)
                value='complete' if number in quarter_marks[n].get(q,[]) else 'follow-up' if number in slash.get((n,q),[]) else ''
                rows.append({'id':f'pm-source-p{n}-r{number}','label':label,'value':value,'rawDate':'','notes':''})
            forms.append({'id':f'p{n}-q{q}','period':f'Q{q} — '+p['rawDate'],'kind':'checklist','rows':rows})
        # Explicit source-wide N/A is real evidence, but its quarter is unspecified.
        # Do not copy it into every quarter or into a current inspection.
        if n in [24,25]:
            number=6 if n==24 else 4
            label=dict(definitions)[str(number)]
            forms.append({'id':f'p{n}-unassigned-na','period':'Quarter unspecified — explicit source N/A','kind':'checklist','rows':[{'id':f'pm-source-p{n}-r{number}','label':label,'value':'na','rawDate':'','notes':'Source-wide N/A note; no quarter or completion date assigned.'}]})
    elif p['kind']=='observations':
        rows=[]
        if n in [19,20]:
            for x in json.loads(evidence)['rows']:
                rows.append({'label':x['location']+' | '+x['device'],'value':x['marked_result'] if x['marked_result'] in ['YES','NO'] else '', 'rawDate':x.get('date_raw') or '', 'notes':x.get('notes','')})
        elif n in [16,18]:
            lines=evidence.splitlines();start=next(i for i,l in enumerate(lines) if l.startswith('All eight'))+1
            for l in lines[start:start+8]:
                label,_,notes=l.partition(':')
                rows.append({'label':label,'value':'YES','rawDate':'','notes':notes.strip()})
        else:
            for l in evidence.splitlines():
                cells=[x.strip() for x in l.split('|')]
                if len(cells)<3 or cells[0].lower().startswith(('rows','location')):continue
                # Only exact named result cells count; ambiguous or grouped results stay unselected.
                result_index=2 if n in [10,11,12,13,14,21,28] else 1
                if len(cells)<=result_index:raise ValueError(f'Incomplete page {n} row')
                raw=cells[result_index];value=raw if raw in ['YES','NO'] else ''
                date=''
                if n==21:date='9/14/26 possibly16' if cells[0]=='Middle hallway #3' else '9/16/2? last digit unclear' if cells[0]=='2nd north above door' else '2026-09-16'
                if n==28 and cells[0]!='South4 entrance door':date='2026-09-16'
                if n==29:date=cells[-1]
                notes=' | '.join(cells[result_index+1:])
                if raw not in ['YES','NO']:notes='Source mark: '+raw+'. '+notes
                if n==15:notes='Tag/service date (not inspection date): '+notes
                rows.append({'label':' | '.join(cells[:result_index]),'value':value,'rawDate':date,'notes':notes})
        for i,r in enumerate(rows):r['id']=f'pm-source-p{n}-r{i+1}'
        if not rows:raise ValueError(f'Marked page {n} has no mapped controls')
        forms=[{'id':f'p{n}-log','period':p['rawDate'] or 'Date not recorded','kind':'log','rows':rows}]
    out.append({'page':n,'templateId':p['templateId'],'fingerprint':fingerprint(p),'forms':forms})
assert len(out)==42
destination.write_text(json.dumps({'sourceId':data['sourceId'],'pages':out},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'pages':42,'observationPages':sum(bool(p['forms']) for p in out),'forms':sum(len(p['forms']) for p in out),'selected':sum(bool(r['value']) for p in out for f in p['forms'] for r in f['rows'])}))
