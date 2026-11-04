from pathlib import Path
import re,html,json,sys
root=Path(__file__).resolve().parents[1]
out=root/'lib';out.mkdir(exist_ok=True);designs={}

js=(root/'design-source/additions.js').read_text()
css=(root/'design-source/additions.css').read_text()
for source in (root/'design-source').glob('*.html'):
 s=source.read_text();m=re.search(r'srcdoc="(.*?)"',s,re.S);inner=html.unescape(m.group(1))
 inner=inner.replace("connect-src 'none'", "connect-src 'self' https://api.giphy.com").replace('img-src blob: data:', "img-src 'self' blob: data: https://*.giphy.com").replace('media-src blob: data:', 'media-src blob: data: https://*.giphy.com')
 inner=inner.replace("script-src 'unsafe-inline'","script-src 'self' 'unsafe-inline'")
 inner=inner.replace('</style>',css+'</style>',1)
 inner=inner.replace("function publish(author,frontDeskName=false){", "async function publish(author,frontDeskName=false){if(saving||!storageReady)return;saving=true;sync();")
 inner=inner.replace("id:'mock-'+sequence++,author,frontDeskName", "id:'local-'+crypto.randomUUID(),createdOrder:Date.now(),author,frontDeskName")
 inner=inner.replace("attachments:[...attachedFiles]};notes.append(createRow(note));", "attachments:[...attachedFiles]};try{await persistNote(note)}catch(e){saving=false;sync();announce('Could not save this note. Free browser storage and try again.');return}saving=false;notes.append(createRow(note));")
 inner=inner.replace("post.disabled=nameMode?", "post.disabled=(typeof storageReady!=='undefined'&&(!storageReady||saving))?true:nameMode?")
 # Declare storage flags before the existing initial sync call.
 extra=js.replace('let storageReady=false,saving=false;','')
 inner=inner.replace("const MAX_FILE_BYTES=", "let storageReady=false,saving=false;\nconst MAX_FILE_BYTES=")
 inner=inner.replace("id:'mock-'+sequence++,author:'Sam'", "id:'local-'+crypto.randomUUID(),author:'Sam'")
 inner=inner.replace("body:'New mock incoming note. 🔔 #handoff',at:previewNow};", "body:'New mock incoming note. 🔔 #handoff',at:previewNow};persistNote(note).catch(()=>announce('Incoming test note could not be saved.'));")
 inner=inner.replace('notify();\n</script>',extra+'\nnotify();\n</script>')
 s=s[:m.start(1)]+html.escape(inner,quote=True)+s[m.end(1):]
 s=s.replace("script-src 'unsafe-inline'","script-src 'self' 'unsafe-inline'")
 s=s.replace('sandbox="allow-scripts"','sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"')
 s=s.replace("connect-src 'none'", "connect-src 'self' https://api.giphy.com").replace('img-src blob: data:', "img-src 'self' blob: data: https://*.giphy.com").replace('media-src blob: data:', 'media-src blob: data: https://*.giphy.com')
 s=s.replace('Comments, files, counts, work orders, and flag states are local mock data and reset on reload.', 'Sample staff and notes are fictional. Posted notes, replies, and local attachments are saved in this browser. Selected GIPHY IDs are saved; GIFs reload directly from GIPHY. Clearing browser data removes saved test posts.')
 name='mobile.html' if 'Mobile' in source.name else 'desktop.html';designs[name.removesuffix('.html')]=s
(out/'designs.json').write_text(json.dumps(designs))
(root/'public/giphy-client.mjs').write_text((root/'lib/cards.mjs').read_text())
print('Built desktop and mobile from supplied sources')
