/** Configuration never releases executable inputs or grants host capabilities. */
import { z } from 'zod';
import { operation, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { houseConfig } from './records.js';
import { runtimeStore } from './store.js';
export function installHouseConfiguration(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.configureHouse', write: true,
    input: z.object({ agent: z.string().min(1).max(200), house: houseConfig.extend({ houseFile: houseConfig.shape.houseFile.default('house/house.json') }) }).strict(),
    output: z.object({ agent: z.string() }),
    may: (viewer, input) => mayAct(viewer, { type: 'runtime.settings', agent: input.agent }, sharing(), 'agent-setup'),
    run(ctx, input) {
      const existing = store.read('settings', input.agent);
      const { changedAt: _at, ...settings } = existing ?? { id: input.agent, agent: input.agent, boxes: [], changedAt: ctx.now };
      if (store.put('settings', { ...settings, house: input.house }, ctx.now)) ctx.changed('runtime.settings', input.agent);
      return { agent: input.agent };
    },
  }));
}
