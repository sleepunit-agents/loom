/** Called only while holding the daemon home lock. Never remove a live endpoint. */
import { lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { touchSocketPath, type TouchSource } from './index.js';
export async function prepareTouchSources(sources: readonly TouchSource[]) {
  for (const source of sources) {
    const path = touchSocketPath(source.directory);
    let before;
    try { before = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!before.isSocket()) throw new Error('Touch endpoint is not a socket');
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      socket.setTimeout(250, () => { socket.destroy(); reject(new Error('Touch endpoint probe timed out')); });
      socket.once('connect', () => { socket.destroy(); reject(new Error('Touch endpoint is occupied')); });
      socket.once('error', error => {
        socket.destroy();
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') { reject(error); return; }
        try {
          const current = lstatSync(path);
          if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('Touch endpoint changed during startup');
          unlinkSync(path); resolve();
        } catch (error) { reject(error); }
      });
    });
  }
}
