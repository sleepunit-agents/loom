/** The client sends argv intact; parsing/formatting and all domain decisions run in the daemon. */
import type { CliCommand } from '../../core/index.js';
export const approvalCommands: CliCommand[] = [
  {name:'request',write:true,flags:Object.fromEntries(['kind','target','what','why','minutes','ask','if-yes','if-no','details','conversation','digest','principal','as','on-behalf'].map(k => [k,k]))},
  {name:'check',positional:['id'],flags:{json:'json',as:'as'}},
  {name:'use',write:true,positional:['id'],flags:{kind:'kind',target:'target',as:'as','on-behalf':'on-behalf',principal:'principal'}},
  {name:'withdraw',write:true,positional:['id'],flags:{as:'as',principal:'principal'}},
  {name:'standing',write:true,flags:{kind:'kind',target:'target',check:'check',digest:'digest',as:'as','on-behalf':'on-behalf'}},
  {name:'list'},
  {name:'rule',positional:['kind','targets'],flags:{for:'for',json:'json',as:'as','on-behalf':'on-behalf',principal:'principal'}},
  {name:'tell',write:true,flags:{kind:'kind',target:'target',what:'what',as:'as','on-behalf':'on-behalf',principal:'principal'}},
  {name:'grant',write:true,flags:{kind:'kind',target:'target',for:'for',by:'by',person:'person',deny:'deny'}},
];
