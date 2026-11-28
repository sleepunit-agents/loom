/** The gallery's data hook (development only): `useDataQuery` answered from the scene a brick is drawn in. The
 * gallery's build puts this file in the place of web/src/data/graphql (web/vite.gallery.config.ts). */
import { createContext, useContext } from 'react';
import type { Scene } from './scenes';

export type DataQuerySnapshot<T> = { status: 'loading' | 'live' | 'offline' | 'denied'; data?: T; settling?: boolean };
export interface DataQueryOptions { keep?: boolean; pause?: boolean }
export const SceneContext = createContext<Scene | null>(null);
const unnamed = new Set<string>();
const answered = new WeakMap<Scene, Map<string, DataQuerySnapshot<unknown>>>();
const queryName = (document: unknown): string => typeof document === 'string' ? /^\s*(?:query|subscription)\s+(\w+)/.exec(document)?.[1] ?? ''
  : (document as { definitions?: { name?: { value: string } }[] })?.definitions?.[0]?.name?.value ?? '';

export function useDataQuery<T>(document: unknown, variables?: Record<string, unknown>, options?: DataQueryOptions): DataQuerySnapshot<T> {
  const scene = useContext(SceneContext);
  if (options?.pause) return { status: 'loading' };
  const name = queryName(document);
  if (!scene || !(name in scene.data)) {
    if (scene && !unnamed.has(scene.name + name)) { unnamed.add(scene.name + name); console.warn(`gallery: scene "${scene.name}" has no answer for ${name}`, variables); }
    return { status: 'live', data: {} as T };
  }
  // One snapshot per scene, query and variables, so a brick's effects see the same object on every draw.
  const key = name + JSON.stringify(variables ?? {});
  let held = answered.get(scene);
  if (!held) answered.set(scene, (held = new Map()));
  let snapshot = held.get(key) as DataQuerySnapshot<T> | undefined;
  if (!snapshot) {
    const answer = scene.data[name], value = typeof answer === 'function' ? (answer as (v: Record<string, unknown>) => unknown)(variables ?? {}) : answer;
    snapshot = value === 'loading' || value === 'offline' || value === 'denied' ? { status: value } : { status: 'live', data: value as T };
    held.set(key, snapshot);
  }
  return snapshot;
}

/** The one-shot read (web/src/data/graphql's `useDataOnce`), answered from the scene by its query's name, as above. */
export const useDataOnce = <T,>(document: string, variables: Record<string, unknown>, options?: { pause?: boolean }): DataQuerySnapshot<T> => useDataQuery<T>(document, variables, options);
