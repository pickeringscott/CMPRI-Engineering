import asyncio,json,time,os
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright,expect
BASE=os.environ.get('CMPRI_UI_BASE','http://127.0.0.1:3116'); assert urlparse(BASE).hostname in ['127.0.0.1','localhost']; OUT=Path(os.environ.get('CMPRI_UI_OUTPUT','work/cmpri-ui')); OUT.mkdir(parents=True,exist_ok=True)
ROLES=['chief_engineer','system_admin','technician','manager','assistant_manager','front_desk_manager','front_desk','housekeeping','senior_management']
UID='00000000-0000-4000-8000-000000000001';WID='00000000-0000-4000-8000-000000000003';HOTEL='00000000-0000-4000-8000-000000000002'
CAPS=json.loads(Path(__file__).with_name('role-capabilities.json').read_text())
orders=[{'id':WID,'display_id':'4218','revision':1,'room':'204','location_id':'loc-1','issue':'Fixture drain needs repair','status':'Open','priority':'High','technician_name':'Alex Morgan','created_at':'2026-11-06T12:00:00Z','guest_name':'Current Guest','loyalty_tier':'Silver','guest_group_badge':'big-ten','incoming_reserved':True,'incoming_loyalty_tier':'Ambassador','incoming_group_badge':'flyover-studios','room_status':'Occupied','notes':'','creator_name':'Reporter','created_by':UID}]

GIF=__import__('base64').b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
async def install(context,role,layouts=None,notes=None,counts=None,posts=None,connected=True):
 layouts=layouts if layouts is not None else {}; notes=notes if notes is not None else []; counts=counts if counts is not None else {}; posts=posts if posts is not None else []
 sess={'access_token':'fixture-token','refresh_token':'fixture-refresh','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':UID,'email':'fixture@example.invalid'}}
 await context.add_init_script('try{sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(sess))+');}catch{}')
 async def route(r):
  u=urlparse(r.request.url);q=parse_qs(u.query);counts[u.path]=counts.get(u.path,0)+1
  if u.hostname=='api.giphy.com':
   ids=q.get('ids',['gif-fixture-1,gif-fixture-2'])[0].split(',');items=[{'id':x,'title':'Fixture GIF '+x,'images':{'fixed_width':{'url':'https://media.giphy.com/'+x+'.gif','width':'160','height':'100'},'original':{'url':'https://media.giphy.com/'+x+'.gif','width':'160','height':'100'}}} for x in ids]
   return await r.fulfill(content_type='application/json',body=json.dumps({'data':items,'pagination':{'total_count':len(items)}}))
  if u.hostname and u.hostname.endswith('.giphy.com'):return await r.fulfill(content_type='image/gif',body=GIF)
  if u.hostname=='ci-placeholder.supabase.co' and '/storage/v1/object/upload/sign/' in u.path:return await r.fulfill(content_type='application/json',body=json.dumps({'Key':u.path.split('/sign/')[1]}))
  if u.hostname not in ['127.0.0.1','localhost']:return await r.abort()
  if not u.path.startswith('/api/'):return await r.continue_()
  data={}
  if u.path=='/api/session':data={'user':{'id':UID,'name':'Alex Morgan','role':role,'email':'fixture@example.invalid'},'hotelId':HOTEL,'landing':'/front-desk' if role=='front_desk' else '/engineering','capabilities':CAPS[role]}
  elif u.path=='/api/profile/header-layout':
   if r.request.method=='PUT':layouts[role]=r.request.post_data_json['layout'];posts.append({'path':u.path,'body':r.request.post_data_json})
   data={'layout':layouts.get(role,{})}
  elif u.path=='/api/profile':data={'preferences':{'appearance':'dark','language':'en'},'chatgpt_connection':{'connected':connected}}
  elif u.path=='/api/work-orders':data={'work_orders':orders,'total':1,'counts':{'pending':0,'open':1,'progress':0,'priority':1,'overdue':0,'completed':0,'closed':0,'all':1}}
  elif u.path=='/api/work-orders/'+WID:data={'workOrder':orders[0]}
  elif u.path=='/api/work-orders/drafts':data={'drafts':[]}
  elif u.path=='/api/work-orders/mentions':data={'mentions':[],'directory':[],'tickets':[]}
  elif u.path.endswith('/attachments'):data={'images':[{'id':'image1','name':'Original photo.gif','type':'image/gif','uploader_name':'Reporter','uploader_role':'Front Desk','uploaded_at':'2026-11-06T12:00:00Z','url':'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}]}
  elif u.path.endswith('/activity'):data={'events':[],'activity':[]}
  elif u.path=='/api/maintenance-reference':data={'assets':[],'technicians':[{'id':UID,'full_name':'Alex Morgan','active':True}]}
  elif u.path=='/api/rooms':data={'locations':[{'id':'loc-1','name':'204','room_number':'204','location_type':'Guest Room'}]}
  elif u.path=='/api/assets':data={'assets':[]}
  elif u.path=='/api/pool-status':data={'closed':True,'reason':'Fixture closure','revision':1,'manual_closed':True,'hours_closed':False,'notifications':[]}
  elif u.path in ['/api/dashboard/notifications','/api/work-orders/notifications']:data={'notifications':[]}
  elif u.path=='/api/staff-notes':
   if r.request.method=='POST':
    value=r.request.post_data_json;posts.append({'path':u.path,'body':value})
    if not any(n['id']==value['requestId'] for n in notes):notes.append({'id':value['requestId'],'author_name':value.get('staffName') or 'Alex','body':value['body'],'parent_id':value.get('parentId'),'created_at':'2026-11-06T12:00:00Z','attachments':[{'id':id,'name':'Photo.png','type':'image/png','size':100,'url':'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'} for id in value.get('uploadIds',[])],'gif_ids':value.get('gifIds',[])})
    data={'id':value['requestId']}
   else:data={'notes':notes,'parents':[],'mentions':[{'label':'Chief Engineer','userIds':[]},{'label':'Alex Morgan','userIds':[]}],'tickets':{},'next':None,'management':role not in ['front_desk','housekeeping','senior_management'],'frontDesk':role=='front_desk','hotelId':HOTEL,'userId':UID,'unread':0,'unreadKeys':[],'alertNow':False,'tags':[]}
  elif u.path=='/api/staff-notes/uploads':
   value=r.request.post_data_json
   data={'id':value['id'],'path':HOTEL+'/'+UID+'/'+value['id'],'token':'fixture-token','ready':r.request.method=='PUT'}
  elif u.path=='/api/engineering/supply-use':data={'items':[],'uses':[]}
  else:data={'assets':[],'rows':[],'mentions':[],'notifications':[]}
  return await r.fulfill(content_type='application/json',body=json.dumps(data))
 await context.route('**/*',route)
 return counts,posts
