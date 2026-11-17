/** Trusted receiving-body tool composition. These callbacks retain Root
 * credentials in the body; the native process receives only local tool names. */
import {z} from 'zod';
/** The name a tool served to a body may have. */
export const TOOL_NAME=/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
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
  const {name,description,inputSchema,execute}=tool;
  if(typeof name!=='string'||typeof description!=='string'||!TOOL_NAME.test(name)||names.has(name)||!description.trim()||description.length>4096||!(inputSchema instanceof z.ZodObject)||typeof execute!=='function')throw new Error('Body model tools unavailable');
  names.add(name);return Object.freeze({name,description,inputSchema,execute});
 }));
}
