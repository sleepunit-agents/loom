import {portraitPng} from './portrait-png.js';
import {DOOR_REQUEST_BYTES} from './core/data/door-limit.js';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {DataDatabase} from './core/data/database.js';
import {agents,agentSprites} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {checkSpriteLayout,SPRITE_MAX_BYTES,spriteSheets} from './desk-sprite-layout.js';
import {storeDeskSprite} from './desk-sprites.js';
import {householdOwner} from './shared-sharing.js';

const encodedLimit=4*Math.ceil(SPRITE_MAX_BYTES/3);
export const PORTRAIT_REQUEST_BYTES=encodedLimit+DOOR_REQUEST_BYTES;

export function registerAgentPortrait(operations:Operations,db:DataDatabase){
  operations.register({
    name:'household.setPortrait',write:true,windowOnly:true,refuses:true,
    input:z.object({agent:z.string().min(1),version:z.string().nullable(),
      portrait:z.object({layout:z.record(z.string(),z.unknown()),png:z.string().max(encodedLimit)}).strict().nullable()}).strict(),
    output:z.object({version:z.string().nullable()}).strict(),
    may:viewer=>householdOwner(db,viewer),
    run(ctx,{agent,version,portrait}){
      const row=db.select().from(agents).where(eq(agents.id,agent)).get();
      if(!row||row.removedAt)throw new OperationError('invalid','Choose a current agent');
      if(row.spriteVersion!==version)throw new OperationError('conflict','The portrait changed. Review the current face and try again.');
      let next:string|null=null;
      if(portrait){
        const layout=checkSpriteLayout(portrait.layout);
        const sheets=spriteSheets(layout);
        if(sheets.length!==1||sheets[0]!=='sheet.png')throw new OperationError('invalid','Choose a single PixelLab sheet');
        const {bytes,width,height}=portraitPng(portrait.png);
        for(const facings of Object.values(layout.states))for(const variants of Object.values(facings))for(const variant of variants){
          if(variant.frames*layout.cell[0]>width||(variant.row+1)*layout.cell[1]>height)throw new OperationError('invalid','The animation frames do not fit this sheet');
        }
        next=storeDeskSprite(db,agent,layout,{'sheet.png':bytes});
      }else{
        db.delete(agentSprites).where(eq(agentSprites.agent,agent)).run();
        db.update(agents).set({spriteVersion:null}).where(eq(agents.id,agent)).run();
      }
      ctx.changed('agents',agent);
      return {version:next};
    },
  });
}
