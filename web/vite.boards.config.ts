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
  'pieces/inbox-view/model.ts', // an Inbox item's state words, its folders, its rows and outcomes, and the rule for what is answered elsewhere (imports kit/time.ts)
  'pieces/approval-view/model.ts', // an approval's title and kind words
  'pieces/approval-view/answering.ts', // how an approval is read and answered: every safeguard of the answer, as functions and one headless hook (imports react and model.ts)
  'pieces/tempo/change.ts', // a Tempo timings change, checked and said as before and after (imports zod; types from answering.ts)
  'pieces/measuring/change.ts', // the same for a Measuring settings change (imports src/core/measuring/change)
  'pieces/attention/inbox-query.ts', // the Inbox's selections of a folder and of one item, its inbox.answer call and an approval item's plain words (imports data/ and the two models above)
  'memory/queries.ts', // the People selection of one person
  'memory/query.ts', // its decoder over the data hook
  'pieces/tasks/words.ts', // the words for a ticket's priorities and types
  'pieces/tasks/query.ts', // the Tasks selection of who and which projects a ticket may be given (a string; its imports are types)
  'pieces/work/query.ts', // the Work selection of the tickets under no project (strings and its page size)
  'pieces/activity/model.ts', // Activity's entry types and which link it may follow (no imports)
  'pieces/people/model.ts', // People's grouping of a person with the agents' relationship cards, its search, and which addresses it links (a type beside them)
  'pieces/knowledge/model.ts', // Knowledge's words for a page's freshness, its date and which pages a list holds (types only beside them)
  'pieces/comms/thread-fields.ts', // the fields every reading of a Comms thread row selects
  'pieces/comms-view/model.ts', // Comms' thread row and the order of its list (types and one function)
  'pieces/attention/agent-directory.ts', // the shared directory's agent names, as Comms and Home say them (imports data/ only)
  'pieces/attention/agent-displays.ts', // an agent's mark colours, face shape and eyes (imports data/ only)
  'face-data.json', // the shapes of an agent's face, as data
  'shell/shortcuts.ts', // the declared shortcuts and the engine that reads their keys (imports react only)
  'pieces/attention/home-model.ts', // an agent's state word and line, the roster's order (types and functions)
  'pieces/attention/roster.ts', // Home's roster: the member's own agents (imports data/ only)
  'pieces/attention/agent-status.ts', // each agent's reported state and work (imports data/ only)
  'pieces/attention/agent-profiles.ts', // each agent's description (imports data/ only)
  'pieces/attention/home-comms-data.ts', // Home's summary of the member's threads per agent (imports data/ only)
  'pieces/attention/doing-model.ts', // what an agent is doing now: the read and its sentences (imports kit/time.ts)
  'pieces/attention/waiting-counts.ts', // how many questions wait on the member, per agent (imports data/ only)
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
