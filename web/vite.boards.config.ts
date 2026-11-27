import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Verify the shipped graph, including lazy chunks. Shared behavior is opt-in.
// What the drawn bricks share with the desktop, each named whole: words for stored states, selections and the
// calls that send an answer. Each is plain TypeScript with no component and no stylesheet, and so is everything it
// imports. Never `kit/index`, a component or a sheet: a brick that needs one of those needs a pure module instead.
const shared = new Set([
  'kit/words.ts', // displayName
  'kit/time.ts', // the shared date formats
  'pieces/change-view/model.ts', // a pull request's state words (imports kit/words.ts)
  'pieces/inbox-view/model.ts', // an Inbox item's state words and the rule for what is answered elsewhere (imports kit/time.ts)
  'pieces/approval-view/model.ts', // an approval's title and kind words
  'pieces/approval-view/answering.ts', // how an approval is read and answered: every safeguard of the answer, as functions and one headless hook (imports react and model.ts)
  'pieces/tempo/change.ts', // a Tempo timings change, checked and said as before and after (imports zod; types from answering.ts)
  'pieces/measuring/change.ts', // the same for a Measuring settings change (imports src/core/measuring/change)
  'pieces/attention/inbox-query.ts', // the Inbox's selection of one item and its inbox.answer call (imports data/ only)
  'memory/queries.ts', // the People selection of one person
  'memory/query.ts', // its decoder over the data hook
]);
const isolation: Plugin = {
  name: 'boards-visual-isolation',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const module of Object.keys(chunk.modules)) {
        const id = module.split('/web/src/')[1]?.split('?')[0];
        if (
          id &&
          !/^(access\.ts$|boards\/|pair\/|contexts\/(?:portrait\.tsx|portrait-player\.ts|manifest\.json|sheet\.png)$|data\/|signin\/use-session\.ts$|lib\/utils\.ts$|pieces\/comms\/use-deadline\.ts$)/.test(
            id,
          ) &&
          !shared.has(id)
        )
          this.error('Desktop dependency in boards page: ' + id);
      }
    }
  },
};
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwind(), isolation],
  build: {
    outDir: '../dist/web',
    assetsDir: 'boards-assets',
    emptyOutDir: false,
    rolldownOptions: { input: 'board.html' },
  },
});
