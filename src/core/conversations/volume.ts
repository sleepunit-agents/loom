/** The recipient's dim setting presents only the first nonempty line. */
export function mailWords(volume:'full'|'dim'|'mute',words:string|null):string|null {
 if(volume==='mute'||words===null)return null;
 return volume==='dim' ? words.split(/\r?\n/).map(line=>line.trim()).find(Boolean)??'' : words;
}
