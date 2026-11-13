/** Home's roster is ownership metadata, independent of whether an agent reports work. */
import { mayAct, type Live, type Sharing } from '../../core/index.js';
export function installHomeRoster(live: Live, sharing: () => Sharing) {
  live.register({
    name: 'attention.ownedAgent',
    ids: () => [...new Set(Object.values(sharing().members).flatMap(member => member.agents))],
    read(id, viewer) {
      const held = sharing();
      // give-work is the central ownership rule; project visibility alone never makes a card.
      if (!mayAct(viewer, { agent: id }, held, 'give-work')) return;
      return { id, name: id };
    },
    inScope: () => true,
  });
}
