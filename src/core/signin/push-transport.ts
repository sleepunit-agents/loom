/** Keep web-push encryption/signing; own the abortable HTTPS request. */
import { request as httpsRequest } from 'node:https';
import webpush from 'web-push';
export type PushTransport=(sub:webpush.PushSubscription,payload:string,options:webpush.RequestOptions,signal:AbortSignal)=>Promise<unknown>;
export const pushTransport:PushTransport=(sub,payload,options,signal)=>sendPush(sub,payload,options,signal);
export function sendPush(sub:webpush.PushSubscription,payload:string,options:webpush.RequestOptions,signal:AbortSignal,request:typeof httpsRequest=httpsRequest):Promise<void> {
  const details=webpush.generateRequestDetails(sub,payload,options);
  return new Promise((resolve,reject)=>{
    const req=request(details.endpoint,{method:details.method,headers:details.headers},res=>{
      res.on('error',reject);
      res.on('end',()=>{const statusCode=res.statusCode;if(statusCode!==undefined&&statusCode>=200&&statusCode<300)resolve();else reject({statusCode});});
      // Drain without collecting private/external diagnostics or unbounded bodies.
      res.resume();
    });
    const abort=()=>req.destroy(new Error('Push transport deadline'));
    req.once('close',()=>signal.removeEventListener('abort',abort));
    req.on('error',reject);
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    req.end(details.body);
  });
}
