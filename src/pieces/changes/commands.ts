/** One command contract for operation registration and the generated transport client. */
import type { CliCommand } from '../../core/index.js';
export interface ChangesCommand extends CliCommand { booleanFlags?: string[]; repeatedFlags?: string[] }
export const changesCommands: ChangesCommand[] = [
 {name:'list'},
 {name:'refresh',write:true},
 {name:'cited-by',positional:['task'],flags:{json:'json'},booleanFlags:['json']},
 {name:'project-feed',flags:{json:'json',project:'project',since:'since',repo:'repos',name:'names',venue:'venues',epic:'epic',conversation:'conversations'},booleanFlags:['json'],repeatedFlags:['repo','name','venue','conversation']},
 {name:'thread-feed',flags:{json:'json',conversation:'conversation',ref:'references'},booleanFlags:['json'],repeatedFlags:['ref']},
];
