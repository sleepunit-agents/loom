/** Every brick's scenes, group by group. */
import type { BrickScenes } from '../scenes';
import { scenes as work } from './work';
import { scenes as attention } from './attention';
import { scenes as agents } from './agents';
import { scenes as knowledge } from './knowledge';
import { scenes as settings } from './settings';

export const groups: { name: string; bricks: BrickScenes[] }[] = [
  { name: 'Work', bricks: work },
  { name: 'Attention and conversations', bricks: attention },
  { name: 'Agents', bricks: agents },
  { name: 'Knowledge, people and you', bricks: knowledge },
  { name: 'Household', bricks: settings },
];
export const all: BrickScenes[] = groups.flatMap((g) => g.bricks);
