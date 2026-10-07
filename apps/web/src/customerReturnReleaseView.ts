// Pure view logic for Release for Customer Return (no browser or API imports).
export type ReleaseValidity={state:'NOT_RELEASED'|'CUSTOMER_RETURN_RELEASED';releaseCurrentlyValid:boolean|null;releaseBlockingReason:string|null};
export const staleReleaseText='返还授权已历史记录，但当前条件已失效，不能进入后续发运。';

export function releaseNotice(data:ReleaseValidity){
  if(data.state!=='CUSTOMER_RETURN_RELEASED')return null;
  // A recorded release is history; only a currently valid one is shown as actionable.
  if(data.releaseCurrentlyValid===true)return {tone:'success' as const,title:'CUSTOMER_RETURN_RELEASED',text:'已授权返还原客户，尚未发运。设备仍处于隔离库存，不可销售。',reason:null};
  return {tone:'error' as const,title:'CUSTOMER_RETURN_RELEASED · 当前已失效',text:staleReleaseText,reason:data.releaseBlockingReason};
}

// Submit once. On any failure, read back exactly once: a committed release whose
// response was lost is restored from the server; the POST is never repeated.
export async function submitWithReadBack<T extends {state:string}>(post:()=>Promise<T>,read:()=>Promise<T>,message:(error:unknown)=>string){
  try{return {data:await post(),error:''};}
  catch(error){
    try{const current=await read();return {data:current,error:current.state==='CUSTOMER_RETURN_RELEASED'?'':message(error)};}
    catch{return {data:null,error:message(error)};}
  }
}
