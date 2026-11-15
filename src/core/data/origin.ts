/** HTTP doors accept same-origin traffic and the configured canonical origin. */
export function sameRequestOrigin(request:Request,publicOrigin?:string):boolean {
 const origin=request.headers.get('origin'),url=new URL(request.url);
 return request.headers.get('sec-fetch-site')!=='cross-site'&&(!origin||origin===url.origin||origin===publicOrigin&&new URL(origin).host===url.host);
}
