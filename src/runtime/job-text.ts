/** Encrypted conversations never leave a second prompt/stdout copy in jobs. */
export function keepJobText(conversation:{venue:string;member:string|null}|undefined):boolean {
 return !!conversation&&conversation.member===null&&conversation.venue!=='loom'&&conversation.venue!=='handoff';
}
