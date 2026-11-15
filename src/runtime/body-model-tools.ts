/** Trusted receiving-body tool composition. These callbacks retain Root
 * credentials in the body; the native process receives only local tool names. */
import {z} from 'zod';
export interface BodyModelTool {
 name:string;
 description:string;
 inputSchema:z.ZodObject;
 execute(input:Record<string,unknown>,signal:AbortSignal):Promise<{content:{type:'text';text:string}[];isError?:boolean}>;
}
/** Snapshot names and callbacks before either native policy or MCP registration
 * consumes them. Extensions cannot replace the two private Secret tools. */
export function bodyModelTools(input:readonly BodyModelTool[]=[]):readonly Readonly<BodyModelTool>[] {
 const names=new Set(['request_secret','use_secret']);
 if(input.length>32)throw new Error('Body model tools unavailable');
 return Object.freeze(input.map(tool=>{
  if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)||names.has(tool.name)||!tool.description.trim()||tool.description.length>4096||!(tool.inputSchema instanceof z.ZodObject)||typeof tool.execute!=='function')throw new Error('Body model tools unavailable');
  names.add(tool.name);return Object.freeze({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,execute:tool.execute});
 }));
}
