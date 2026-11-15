/** The recipient's dim setting presents only the first nonempty line. */
export function mailWords(volume:'full'|'dim'|'mute',words:string|null):string|null {
 if(volume==='mute'||words===null)return null;
 return volume==='dim' ? words.split(/[\r\n\v\f\u0085\u2028\u2029]/u).map(line=>line.trim()).find(Boolean)??'' : words;
}
