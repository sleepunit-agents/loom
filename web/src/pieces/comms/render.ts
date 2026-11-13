/** Same reply safety as Comms: no raw HTML, images, insecure or arbitrary internal links. */
import MarkdownIt from 'markdown-it';
const md=new MarkdownIt({html:false,linkify:false,breaks:true});
md.disable('image');
const localApproval=(url:string)=>/^\/p\/clock-preview\/item\/a-[0-9a-f]{8}$/.test(url);
md.validateLink=url=>localApproval(url)||/^https:\/\//i.test(url.trim()) && !/^https:\/\/loom\.invalid(?:\/|$)/i.test(url.trim());
md.renderer.rules.link_open=(tokens,i,opts,_env,self)=>{if(!localApproval(tokens[i].attrGet('href')??'')){tokens[i].attrSet('target','_blank');tokens[i].attrSet('rel','noopener noreferrer');}return self.renderToken(tokens,i,opts);};
export const replyHtml=(words:string)=>md.render(words);
