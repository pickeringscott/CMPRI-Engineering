import type {CmpriClientSession} from './auth/client-session';
export type NotesSessionResult={kind:'authorized';session:CmpriClientSession}|{kind:'denied'}|{kind:'missing'};
/** Revalidation failure is not evidence of sign-out. Keep the verified editor
 * mounted through transient focus/network failures; real revocation still hides it. */
export class NotesSessionGuard{
 session:CmpriClientSession|null=null;
 private generation=0;private lastRefresh=-Infinity;private flight:Promise<void>|null=null;private stopped=false;
 private read:()=>Promise<NotesSessionResult>;private publish:(session:CmpriClientSession|null,message:string)=>void;private now:()=>number;
 constructor(read:()=>Promise<NotesSessionResult>,publish:(session:CmpriClientSession|null,message:string)=>void,now=Date.now){this.read=read;this.publish=publish;this.now=now}
 async refresh(){
  if(this.stopped)return;if(this.flight)return this.flight;if(this.now()-this.lastRefresh<15_000)return;this.lastRefresh=this.now();const generation=++this.generation;
  this.flight=(async()=>{try{const result=await this.read();if(this.stopped||generation!==this.generation)return;
   if(result.kind==='authorized'){this.session=result.session;this.publish(this.session,'')}
   else if(result.kind==='denied'){this.session=null;this.publish(null,'Sign in to CMPRI to use your notebook.')}
   else this.publish(this.session,this.session?'Session verification is temporarily unavailable. Your draft remains protected on this device.':'Sign in to CMPRI to use your notebook.');
  }catch{if(!this.stopped&&generation===this.generation)this.publish(this.session,this.session?'Session verification is temporarily unavailable. Your draft remains protected on this device.':'Unable to verify your session. Reconnect and reopen Notes.')}
  finally{this.flight=null}})();return this.flight;
 }
 authChanged(event:string,userId?:string){
  if(this.stopped)return;
  if(event==='SIGNED_OUT'||(userId&&this.session&&userId!==this.session.user.id)){this.generation++;this.session=null;this.publish(null,'Your session changed. Reopen Notes after signing in.')}
 }
 stop(){this.stopped=true;this.generation++}
}
