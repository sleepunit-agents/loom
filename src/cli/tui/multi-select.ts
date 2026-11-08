/**
/**
 * Reusable keyboard-nav multi-select primitive. The reducer is pure and
 * fully unit-tested; the TTY adapter (`multiSelect`) is a thin
 * stdin+render wrapper exercised by the inject integration test and
 * manual verification only. Raw-mode stdin + ANSI cursor codes.
 */
import { emitKeypressEvents } from 'node:readline';

export interface MultiSelectItem<T> {
  value: T;
  label: string;
  detail?: string;
}

export interface MultiSelectState<T> {
  cursor: number;
  selected: Set<T>;
}

export type MultiSelectEvent =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'toggle' }
  | { kind: 'confirm' }
  | { kind: 'cancel' };

export type MultiSelectResult<T> =
  | { status: 'running'; state: MultiSelectState<T> }
  | { status: 'confirmed'; selected: Set<T> }
  | { status: 'cancelled' };

export interface ReduceOpts {
  single?: boolean;
}

export interface MultiSelectOpts<T> {
  title: string;
  items: ReadonlyArray<MultiSelectItem<T>>;
  initialSelected?: ReadonlySet<T>;
  single?: boolean;
}

export function initialState<T>(
  _items: ReadonlyArray<MultiSelectItem<T>>,
  initialSelected?: ReadonlySet<T>,
): MultiSelectState<T> {
  return {
    cursor: 0,
    selected: new Set(initialSelected ?? []),
  };
}

export function reduce<T>(
  state: MultiSelectState<T>,
  event: MultiSelectEvent,
  items: ReadonlyArray<MultiSelectItem<T>>,
  opts: ReduceOpts = {},
): MultiSelectResult<T> {
  switch (event.kind) {
    case 'up': {
      if (items.length === 0) return { status: 'running', state };
      const cursor = (state.cursor - 1 + items.length) % items.length;
      return { status: 'running', state: { ...state, cursor } };
    }
    case 'down': {
      if (items.length === 0) return { status: 'running', state };
      const cursor = (state.cursor + 1) % items.length;
      return { status: 'running', state: { ...state, cursor } };
    }
    case 'toggle': {
      if (items.length === 0) return { status: 'running', state };
      const v = items[state.cursor].value;
      const has = state.selected.has(v);
      let next: Set<T>;
      if (opts.single) {
        next = has ? new Set() : new Set([v]);
      } else {
        next = new Set(state.selected);
        if (has) next.delete(v);
        else next.add(v);
      }
      return { status: 'running', state: { cursor: state.cursor, selected: next } };
    }
    case 'confirm':
      return { status: 'confirmed', selected: new Set(state.selected) };
    case 'cancel':
      return { status: 'cancelled' };
  }
}

// ─── TTY adapter (manually verified) ────────────────────────────────────────

function renderFrame<T>(
  opts: MultiSelectOpts<T>,
  state: MultiSelectState<T>,
  write: (s: string) => void,
): void {
  // Clear screen + move home; keep scrollback.
  write('\x1b[2J\x1b[H');
  write(`${opts.title}\n\n`);
  opts.items.forEach((item, i) => {
    const marker = state.selected.has(item.value) ? '[x]' : '[ ]';
    const pointer = i === state.cursor ? '›' : ' ';
    const detail = item.detail ? `  ${item.detail}` : '';
    write(`  ${pointer} ${marker} ${item.label}${detail}\n`);
  });
  const hint = opts.single
    ? '\n  ↑/↓ move    space select    enter confirm    esc/q cancel\n'
    : '\n  ↑/↓ move    space toggle    enter confirm    esc/q cancel\n';
  write(hint);
}

interface KeypressAdapterDeps {
  stdin: NodeJS.ReadStream;
  stdout: { write: (s: string) => void };
}

/**
 * TTY wrapper around `reduce`. Returns the confirmed selection or null
 * on cancel. Throws if stdin is not a TTY — callers must check
 * beforehand.
 */
export async function multiSelect<T>(
  opts: MultiSelectOpts<T>,
  deps: KeypressAdapterDeps = { stdin: process.stdin, stdout: process.stdout },
): Promise<ReadonlySet<T> | null> {
  const { stdin, stdout } = deps;
  if (!stdin.isTTY) {
    throw new Error('multiSelect requires a TTY stdin');
  }
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  let state = initialState(opts.items, opts.initialSelected);
  const write = (s: string) => stdout.write(s);
  renderFrame(opts, state, write);

  return new Promise<ReadonlySet<T> | null>((resolve) => {
    const onKey = (_str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      let event: MultiSelectEvent | null = null;
      if (key.ctrl && key.name === 'c') event = { kind: 'cancel' };
      else if (key.name === 'escape' || key.name === 'q') event = { kind: 'cancel' };
      else if (key.name === 'up') event = { kind: 'up' };
      else if (key.name === 'down') event = { kind: 'down' };
      else if (key.name === 'space') event = { kind: 'toggle' };
      else if (key.name === 'return') event = { kind: 'confirm' };
      if (!event) return;

      const result = reduce(state, event, opts.items, { single: opts.single });
      if (result.status === 'running') {
        state = result.state;
        renderFrame(opts, state, write);
        return;
      }
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      write('\n');
      resolve(result.status === 'confirmed' ? result.selected : null);
    };
    stdin.on('keypress', onKey);
  });
}
