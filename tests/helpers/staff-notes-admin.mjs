/** A local PostgreSQL adapter for executing the real handlers; never connects to Supabase. */
const identifier=value=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('Invalid fixture identifier');return '"'+value+'"'};
export function staffNotesAdmin(db){
 return {
  from(table){
   const relation=identifier(table);let columns='*',operation='select',mutation,count=false,single=false,offset=0,limit;
   const filters=[],orders=[];
   const q={
    select(value='*',options={}){columns=value;count=options.count==='exact';return q},
    update(value){operation='update';mutation=value;columns=null;return q},
    eq(k,v){filters.push([k,'=',v]);return q},in(k,v){filters.push([k,'in',v]);return q},is(k,v){filters.push([k,'is',v]);return q},
    gte(k,v){filters.push([k,'>=',v]);return q},lte(k,v){filters.push([k,'<=',v]);return q},lt(k,v){filters.push([k,'<',v]);return q},
    like(k,v){filters.push([k,'like',v]);return q},contains(k,v){filters.push([k,'@>',v]);return q},
    order(k,options={}){orders.push(identifier(k)+(options.ascending===false?' desc':' asc'));return q},
    limit(n){limit=n;return q},range(from,to){offset=from;limit=to-from+1;return q},
    maybeSingle(){single=true;return execute()},then(resolve,reject){return execute().then(resolve,reject)},
   };
   async function execute(){try{
    const params=[],bind=value=>{params.push(value);return '$'+params.length};
    const changes=operation==='update'?Object.entries(mutation).map(([k,v])=>identifier(k)+'='+bind(v)).join(','):'';
    const where=filters.length?' where '+filters.map(([k,op,v])=>op==='is'?identifier(k)+(v===null?' is null':' is '+(v?'true':'false')):op==='in'?identifier(k)+'=any('+bind(v)+')':identifier(k)+' '+op+' '+bind(v)).join(' and '):'';
    let total;
    if(count)total=(await db.query('select count(*)::int n from '+relation+where,params)).rows[0].n;
    const projection=columns===null?'':columns==='*'?'*':columns.split(',').map(c=>identifier(c.trim())).join(',');
    const sql=operation==='update'?'update '+relation+' set '+changes+where+(projection?' returning '+projection:''):'select '+projection+' from '+relation+where+(orders.length?' order by '+orders.join(','):'')+(limit!==undefined?' limit '+Math.max(0,Number(limit)):'')+(offset?' offset '+Number(offset):'');
    const result=await db.query(sql,params);return {data:operation==='update'&&!projection?null:single?(result.rows[0]||null):result.rows,error:null,...(count?{count:total}:{})};
   }catch(error){return {data:null,error:{message:error.message,code:error.code}}}}
   return q;
  },
  async rpc(name,args){try{
   const params=Object.values(args).map((value,i)=>['p_recipients','p_gifs','p_mentions'].includes(Object.keys(args)[i])?JSON.stringify(value):value);
   const result=await db.query('select * from public.'+identifier(name)+'('+Object.keys(args).map((key,i)=>identifier(key)+'=>$'+(i+1)).join(',')+')',params);
   const scalar=name.startsWith('cmpri_post_staff_note');return {data:scalar?result.rows[0]?.[name]:result.rows,error:null};
  }catch(error){return {data:null,error:{message:error.message,code:error.code}}}},
 };
}
