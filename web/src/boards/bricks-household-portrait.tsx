/** An agent's animated portrait, changed from the `household` brick's agent rows (big form) as the desktop's Household
 * setup changes it (pieces/household/portrait.tsx, whose reader, limits and words are imported here): two files
 * chosen in the brick, a PixelLab PNG sheet and its PixelLab animation JSON, each checked before anything is sent
 * (the sheet `image/png` and at most `SPRITE_MAX_BYTES`, the JSON a `.json` or `application/json` file of at most
 * `DOOR_REQUEST_BYTES` that reads as a PixelLab sheet's), then sent from the page straight to the desktop's member
 * operation, `household.setPortrait` (`POST /api/household/setPortrait`, a household owner's, from a signed-in
 * browser window). "Use generated face" sends the same operation with no portrait. A failed request (no reply, a 5xx,
 * an answer that is not loom's) keeps the request and its id so Retry finishes or checks it, as on the desktop.
 *
 * The files live in this component's state and nowhere else: they are never passed to `act`, never part of a read,
 * the address or storage. The board is told which agent's portrait changed and whether it was uploaded or restored,
 * and nothing else (src/core/boards/bricks/household.ts, `setPortrait`). */
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
// The outcomes the board may be told, as the catalogue declares them: a type only, so nothing of it is bundled.
import type { portraitOutcomes } from '../../../src/core/boards/bricks/household';
import { MemberOperationError, memberOperation } from '../data/operation';
import { newId } from '../data/id';
import { METADATA_LIMIT_WORDS, SHEET_LIMIT_WORDS, portraitRefusal, readPortraitFiles, type PortraitInput } from '../pieces/household/portrait';
import { Action, Actions, Note, Opened, Opens, Problem, Row, type Act } from './brick-kit';

type Request = { id: string; input: PortraitInput };
type Outcome = (typeof portraitOutcomes)[number];
const FAILED = 'Could not confirm the change. Retry to check or finish it.';
const UNREADABLE = 'Choose the PixelLab animation JSON that came with this sheet.';
/** The desktop's file choosers take a PNG, and a `.json` or JSON file: anything else is refused here before reading. */
const isPng = (file: File) => file.type === 'image/png';
const isJson = (file: File) => file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');

function FileField({ label, accept, disabled, choose }: { label: string; accept: string; disabled: boolean; choose(file: File | null): void }) {
  return (
    <label className="board-field">
      <span>{label}</span>
      <input className="board-input" type="file" aria-label={label} accept={accept} disabled={disabled} onChange={(event) => choose(event.target.files?.[0] ?? null)} />
    </label>
  );
}

/** An agent's row in the household brick's big form, with Portrait at its end opening the change under it. */
export function PortraitRow({ agent, version, title, meta, end, act }: { agent: string; version: string | null; title: ReactNode; meta?: ReactNode; end?: ReactNode; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <Row title={title} meta={meta} end={<>{end}<Opens open={open} label={`Portrait for ${agent}`} onToggle={() => setOpen(!open)}>Portrait</Opens></>}>
      {open ? <Opened><PortraitChange agent={agent} version={version} act={act} /></Opened> : undefined}
    </Row>
  );
}

function PortraitChange({ agent, version, act }: { agent: string; version: string | null; act: Act }) {
  const [sheet, setSheet] = useState<File | null>(null), [metadata, setMetadata] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [message, say] = useState(''), [retry, setRetry] = useState<Request>();
  // A new key draws the file choosers again, empty: a chosen file cannot be taken out of one any other way.
  const [drawn, setDrawn] = useState(0);
  // The portrait as it was when the first file was chosen: a change under the member's hands is refused, as on the desktop.
  const chosenAt = useRef<{ version: string | null } | undefined>(undefined);
  const clear = () => { chosenAt.current = undefined; setSheet(null); setMetadata(null); setRetry(undefined); setDrawn((n) => n + 1); };
  const choose = (set: (file: File | null) => void) => (file: File | null) => { chosenAt.current ??= { version }; setRetry(undefined); setProblem(''); say(''); set(file); };
  const send = async (request: Request) => {
    setBusy(true); setProblem(''); say('');
    try {
      await memberOperation('household.setPortrait', request.input, request.id);
    } catch (error) {
      if (error instanceof MemberOperationError && error.status >= 400 && error.status < 500) { clear(); setProblem(portraitRefusal(error.status)); }
      else { setRetry(request); setProblem(FAILED); }
      return;
    } finally { setBusy(false); }
    const outcome: Outcome = request.input.portrait ? 'uploaded' : 'restored';
    clear(); say(outcome === 'uploaded' ? 'Animated portrait saved.' : 'Generated face restored.');
    // The board is told which agent and which of the two, never a file's name, size or contents.
    act('setPortrait', { agent, outcome });
  };
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (retry) { await send(retry); return; }
    if (chosenAt.current && chosenAt.current.version !== version) { clear(); setProblem('The portrait changed while you were choosing files. Review it and choose the files again.'); return; }
    if (!sheet || !isPng(sheet)) { setProblem(SHEET_LIMIT_WORDS); return; }
    if (!metadata || !isJson(metadata)) { setProblem(METADATA_LIMIT_WORDS); return; }
    let portrait: PortraitInput['portrait'];
    try { portrait = await readPortraitFiles(sheet, metadata); }
    catch (error) {
      const words = error instanceof Error ? error.message : '';
      setProblem([SHEET_LIMIT_WORDS, METADATA_LIMIT_WORDS, 'Could not read the sheet.'].includes(words) ? words : UNREADABLE);
      return;
    }
    await send({ id: newId(), input: { agent, version, portrait } });
  };
  const restore = () => { if (!busy) void send({ id: newId(), input: { agent, version, portrait: null } }); };
  return (
    <form key={drawn} className="board-form" aria-label={`Animated portrait for ${agent}`} autoComplete="off" onSubmit={(event) => void upload(event)}>
      <FileField label="PixelLab sprite sheet" accept="image/png" disabled={busy} choose={choose(setSheet)} />
      <FileField label="PixelLab animation JSON" accept=".json,application/json" disabled={busy} choose={choose(setMetadata)} />
      <Note>A PNG sheet up to 4 MB and its PixelLab animation JSON up to 1 MB. The board is told only that this agent's portrait changed.</Note>
      <Problem>{problem}</Problem>
      {message && <p role="status" className="board-note">{message}</p>}
      <Actions>
        {retry ? <Action submit kind="primary" disabled={busy}>Retry portrait change</Action>
          : <Action submit kind="primary" disabled={busy}>{version ? 'Replace portrait' : 'Add portrait'}</Action>}
        {version && !retry && <Action kind="quiet" disabled={busy} onClick={restore}>Use generated face</Action>}
      </Actions>
    </form>
  );
}
