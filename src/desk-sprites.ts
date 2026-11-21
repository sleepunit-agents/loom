/** Opaque PNG sheets in the shared schema. Trusted producers write through the
 * root's DataWrites; only the outside query resolver applies agent visibility. */
import {createHash} from 'node:crypto';
import {and,eq,getTableColumns,sql} from 'drizzle-orm';
import {GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,agentSprites} from './core/data/schema.js';
import {taskVisibility} from './core/data/visibility.js';
import type {Viewer} from './policy.js';
import {checkSpriteLayout,spriteSheets,SPRITE_MAX_BYTES,SPRITE_SHEET_NAME} from './desk-sprite-layout.js';
const pngHeader=Buffer.from([137,80,78,71,13,10,26,10]);
export const deskSpriteVersion=(layout:string,sheets:Buffer)=>createHash('sha256').update(layout).update('\0').update(sheets).digest('hex');
/** Atomic document + bytes + version. No files, legacy settings or helper store. */
export function storeDeskSprite(db:DataDatabase,agent:string,document:unknown,images:Record<string,Uint8Array>):string {
 const manifest=checkSpriteLayout(document),names=spriteSheets(manifest),packed:Record<string,string>=Object.create(null);
 for(const name of Object.keys(images))if(!SPRITE_SHEET_NAME.test(name))throw Error('Invalid sprite sheet name');
 for(const name of names){const bytes=images[name]&&Buffer.from(images[name]);if(!bytes||bytes.length>SPRITE_MAX_BYTES||!bytes.subarray(0,8).equals(pngHeader))throw Error('Sprite needs each named PNG sheet (4 MB at most)');packed[name]=bytes.toString('base64');}
 const layout=JSON.stringify(manifest);checkSpriteLayout(JSON.parse(layout));
 const sheets=Buffer.from(JSON.stringify(packed)),version=deskSpriteVersion(layout,sheets);
 db.transaction(()=>{db.insert(agentSprites).values({agent,layout,sheets}).onConflictDoUpdate({target:agentSprites.agent,set:{layout,sheets}}).run();db.update(agents).set({spriteVersion:version}).where(eq(agents.id,agent)).run();});
 return version;
}
export function removeDeskSprite(db:DataDatabase,agent:string){
 db.transaction(()=>{
  db.delete(agentSprites).where(eq(agentSprites.agent,agent)).run();
  db.update(agents).set({spriteVersion:null}).where(eq(agents.id,agent)).run();
 });
}
export function deskSpriteFields(db:DataDatabase):GraphQLFieldConfigMap<unknown,{viewer:Viewer}>{
 const asset=new GraphQLObjectType({name:'DeskSprite',fields:{id:{type:new GraphQLNonNull(GraphQLString)},version:{type:new GraphQLNonNull(GraphQLString)},layout:{type:new GraphQLNonNull(GraphQLString)},sheets:{type:new GraphQLNonNull(GraphQLString)}}});
 return {deskSprite:{type:asset,args:{agent:{type:new GraphQLNonNull(GraphQLString)},version:{type:new GraphQLNonNull(GraphQLString)}},resolve(_row,args:{agent:string;version:string},{viewer}){
  // The reused agent predicate is an OR; group it with the exact asset target.
  const allowed=taskVisibility(viewer).agents!(getTableColumns(agents));
  const row=db.select({version:agents.spriteVersion,layout:agentSprites.layout,sheets:agentSprites.sheets}).from(agentSprites).innerJoin(agents,eq(agents.id,agentSprites.agent))
   .where(and(eq(agents.id,args.agent),eq(agents.spriteVersion,args.version),sql`(${allowed})`)).get();
  // A direct inconsistent producer write cannot combine old metadata with new bytes.
  if(!row||row.version!==deskSpriteVersion(row.layout,row.sheets))return null;
  return {id:JSON.stringify([args.agent,row.version]),version:row.version,layout:row.layout,sheets:row.sheets.toString('utf8')};
 }}};
}
