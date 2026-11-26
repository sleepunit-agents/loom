import {and, eq, isNotNull} from 'drizzle-orm';
import {z} from 'zod';
import type {Viewer} from '../../policy.js';
import {inbox, messages, messageFiles} from '../data/schema.js';
import {commsKeepDays} from '../data/comms-days.js';
import {operation, Operations, OperationError} from '../operations/index.js';
import type {CommsMessages} from './messages.js';
import {wordsDeadline} from './retention.js';

export const CHAT_FILE_BYTES = 8 * 1024 * 1024;
export const CHAT_FILE_REQUEST_BYTES = Math.ceil(CHAT_FILE_BYTES / 3) * 4 + 1024 * 1024;
export const chatFiles = z.array(z.object({
  name:z.string().min(1).max(255).regex(/^[^\p{C}\u2028\u2029]+$/u),
  contents:z.string().max(Math.ceil(CHAT_FILE_BYTES/3)*4).refine(s=>Buffer.from(s,'base64').toString('base64')===s),
}).strict()).min(1).max(4).refine(files =>
  files.reduce((bytes,file) => bytes + Buffer.byteLength(file.contents,'base64'),0) <= CHAT_FILE_BYTES);

export function registerChatFileRead(operations:Operations, service:CommsMessages,
  heldMail:(viewer:Viewer,items:string[])=>boolean) {
  const retained = (id:string) => {
    const row = service.db.select({sealed:messageFiles.sealed, at:messages.at, keepUntil:messages.keepUntil})
      .from(messageFiles).innerJoin(messages,and(eq(messageFiles.thread,messages.thread),eq(messageFiles.seq,messages.seq)))
      .innerJoin(inbox,eq(inbox.id,messages.inboxItem))
      .where(and(eq(inbox.id,id),eq(inbox.state,'taken'),eq(inbox.volume,'full'),eq(inbox.takenVolume,'full'),isNotNull(messages.words))).get();
    if (!row) return;
    const until=wordsDeadline(row,commsKeepDays(service.db));
    return until > Date.parse(service.now()) ? {sealed:row.sealed,until} : undefined;
  };
  operations.register(operation({
    name:'conversation.messageFiles',write:false,doors:['http'],
    input:z.object({item:z.string().min(1)}).strict(),output:z.object({files:chatFiles,until:z.number()}),
    may:(viewer,input)=>heldMail(viewer,[input.item]),
    async prepare(input) {
      const before=retained(input.item);
      if(!before) throw new OperationError('not-found','Attachments unavailable');
      const files=chatFiles.parse(JSON.parse(await service.key.open(before.sealed)));
      return () => {
        const live=retained(input.item);
        if(!live || !live.sealed.equals(before.sealed)) throw new OperationError('not-found','Attachments unavailable');
        return {files,until:live.until};
      };
    },
    run(_ctx,_input,prepared){return (prepared as ()=>{files:z.infer<typeof chatFiles>;until:number})();},
  }));
}
