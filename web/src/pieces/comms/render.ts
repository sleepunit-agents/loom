/** Same reply safety as Comms: no raw HTML, images, insecure or arbitrary internal links. */
import MarkdownIt from 'markdown-it';
import {refBits} from './ref-bits';
const md=new MarkdownIt({html:false,linkify:false,breaks:true});
md.disable('image');
const localApproval=(url:string)=>/^\/p\/clock-preview\/item\/a-[0-9a-f]{8}$/.test(url);
md.validateLink=url=>localApproval(url)||/^https:\/\//i.test(url.trim()) && !/^https:\/\/loom\.invalid(?:\/|$)/i.test(url.trim());
md.renderer.rules.link_open=(tokens,i,opts,_env,self)=>{if(!localApproval(tokens[i].attrGet('href')??'')){tokens[i].attrSet('target','_blank');tokens[i].attrSet('rel','noopener noreferrer');}return self.renderToken(tokens,i,opts);};
// Only ordinary inline text is eligible: code, link labels and destinations stay literal.
md.renderer.rules.text=(tokens,i,_opts,env)=>{
 const token=tokens[i];
 if(env.commsLink)return md.utils.escapeHtml(token.content);
 return refBits(token.content).map(b=>b.ref?`<span data-comms-ref="${md.utils.escapeHtml(b.ref)}">${md.utils.escapeHtml(b.text)}</span>`:md.utils.escapeHtml(b.text)).join('');
};
const linkOpen=md.renderer.rules.link_open!;
md.renderer.rules.link_open=(tokens,i,opts,env,self)=>{env.commsLink=true;return linkOpen(tokens,i,opts,env,self);};
md.renderer.rules.link_close=(tokens,i,opts,env,self)=>{env.commsLink=false;return self.renderToken(tokens,i,opts);};
export const replyHtml=(words:string)=>md.render(words);
