/** Observe before activation; spend response time only once its request exists. */
export async function responseForAction(page,matches,action,timeoutMs=4000){
 let wanted,timer,complete=false,resolve,reject;
 const received=new Promise((yes,no)=>{resolve=yes;reject=no;});void received.catch(()=>{});
 const settle=(error,response)=>{if(complete)return;complete=true;clearTimeout(timer);error?reject(error):resolve(response);};
 const arm=message=>{clearTimeout(timer);timer=setTimeout(()=>settle(Error(message)),timeoutMs);};
 const request=value=>{try{if(!wanted&&!complete&&matches(value)){wanted=value;arm('The matching HTTP response did not arrive');}}catch(error){settle(error);}};
 const response=value=>{if(wanted&&value.request()===wanted)settle(undefined,value);};
 page.on('request',request);page.on('response',response);
 try{
  await action();
  if(!wanted&&!complete)arm('The action did not send its matching HTTP request');
  return await received;
 }finally{clearTimeout(timer);page.off('request',request);page.off('response',response);}
}
