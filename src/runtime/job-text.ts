/** Encrypted conversations never leave a second prompt/stdout copy in jobs. Nor does a direct message:
 * its words are read under the conversation's rule, which a job row's wider readers do not all pass. */
export function keepJobText(conversation:{venue:string;member:string|null;direct:boolean}|undefined):boolean {
 return !!conversation&&conversation.member===null&&!conversation.direct&&conversation.venue!=='loom'&&conversation.venue!=='handoff';
}
