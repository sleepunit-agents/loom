/** The bricks' gallery (development only; web/vite.gallery.config.ts, `npm run gallery:build`): every brick of the
 * page's registry in its three forms, at the sizes the layout gives them, drawn from fixtures and never from loom.
 *
 * The address chooses what is drawn:
 *   ?scheme=dark|light       the colour scheme (default: the device's)
 *   ?sheet=side|compact|primary|phone   one contact sheet: every brick's `default` scene in that form
 *   ?brick=<name>            only that brick's scenes (`page`: the parts of the page that are no brick)
 *   ?tall                    a primary form as tall as what it holds, so a shot shows the whole of a long one
 * With no `sheet`, every scene of every brick is drawn in all its forms. Each drawing is a <figure data-shot>, which
 * is what web/scripts/gallery-shots.mjs photographs. */
import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { bricks, brickView } from '../bricks';
import { Fetching, Here, Loading, Lost } from '../brick-kit';
import type { Form } from '../layout';
import { PlacementFrame } from '../placement';
import { BridgeReceipt, ThreadHead, ThreadStop, ThreadSwitch } from '../threads';
import { SceneContext } from './fake-graphql';
import { all, groups } from './fixtures';
import { attention, headScenes, pageScenes, type PageScene } from './fixtures/page';
import { BoardHead } from '../board-head';
import type { Scene } from './scenes';
import '../../pair/screen.css';
import '../board.css';
import '../board-kit.css';
import './gallery.css';

const query = new URLSearchParams(location.search);
const scheme = query.get('scheme');
if (scheme === 'dark' || scheme === 'light') document.documentElement.style.colorScheme = scheme;
// A brick's operations go nowhere: each is answered as saved, a moment later.
// The sign-in door answers a made token with a fictitious bearer of the real shape, so its shown-once state can be seen.
const galleryBearer = 'loom_' + 'gallery0'.repeat(5) + 'abc';
window.fetch = async (url) => { await new Promise((done) => setTimeout(done, 400)); return new Response(JSON.stringify({ ok: true, value: String(url).startsWith('/api/signin/') ? { token: galleryBearer, fingerprint: '0'.repeat(64) } : {} }), { status: 200, headers: { 'content-type': 'application/json' } }); };

type Drawn = Form | 'phone';
/** The room the layout gives a form on an ordinary screen (../layout.ts): a 1440 px window gives the side column
 * about 300 px and a 1920 px one its ideal 360; the primary gets what is left, up to its max. */
function room(brick: string, form: Drawn): { w: number; h: number } {
  const fits = brickView(brick).fits;
  if (form === 'phone') return { w: 362, h: 620 };
  if (form === 'primary') return { w: Math.min(fits.primary.max, Math.max(fits.primary.min, 700)), h: Math.max(fits.primary.height, 640) };
  return { w: 320, h: fits[form].height };
}

/** Presses a scene's buttons, in order, once the brick has drawn them. */
function Pressed({ labels, children }: { labels?: Scene['press']; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!labels?.length) return;
    let stopped = false;
    void (async () => {
      for (const label of labels) {
        if (typeof label !== 'string') {
          // A controlled field takes words only through the setter React watches, then an input event.
          for (let tries = 0; tries < 40 && !stopped; tries++) {
            const field = box.current?.querySelector<HTMLInputElement>(`input[aria-label="${label.field}"]`);
            if (field) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, label.text); field.dispatchEvent(new Event('input', { bubbles: true })); break; }
            await new Promise((done) => setTimeout(done, 50));
          }
          continue;
        }
        for (let tries = 0; tries < 40 && !stopped; tries++) {
          const button = [...(box.current?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
          if (button) { button.click(); break; }
          await new Promise((done) => setTimeout(done, 50));
        }
      }
    })();
    return () => { stopped = true; };
  }, [labels]);
  return <div ref={box} style={{ display: 'contents' }}>{children}</div>;
}

function Shot({ brick, scene, form }: { brick: string; scene: Scene; form: Drawn }) {
  const view = brickView(brick), size = room(brick, form), drawnForm: Form = form === 'phone' ? 'primary' : form;
  const { Body } = view;
  const box = query.has('tall') && form === 'primary' ? { width: size.w, minHeight: size.h } : { width: size.w, height: size.h };
  return (
    <figure data-shot={`${brick}.${scene.name}.${form}`}>
      <figcaption><b>{brick}</b> {scene.name} · {form}</figcaption>
      <SceneContext.Provider value={scene}>
        <Pressed labels={scene.press}>
          <PlacementFrame title={view.title(scene.params)} sub={view.sub(scene.params)} form={drawnForm} flag={scene.flag} canMaximize={drawnForm !== 'primary'}
            style={box}>
            <Here.Provider value={{ thread: scene.here }}><Suspense fallback={<Loading />}><Body params={scene.params} form={drawnForm} act={() => {}} raise={() => {}} /></Suspense></Here.Provider>
          </PlacementFrame>
        </Pressed>
      </SceneContext.Provider>
    </figure>
  );
}

/** The board's header row (../board-head.tsx) over the top of an empty board: at the width a board has beside the
 * conversation on a 1440 px window, or on a phone the window's own width less the board's padding. Room is left
 * under it for the list it opens, which lies over the board. */
function HeadShot({ scene }: { scene: PageScene }) {
  const head = scene.head!, box = useRef<HTMLElement>(null);
  const phone = innerWidth < 640, width = phone ? innerWidth : 880;
  useEffect(() => {
    if (!head.open) return;
    const press = setTimeout(() => box.current?.querySelector<HTMLButtonElement>(head.open === 'more' ? '.boards-head-more' : '.boards-notice-fold')?.click(), 100);
    return () => clearTimeout(press);
  }, [head.open]);
  return (
    <figure data-shot={`page.${scene.name}.${phone ? 'phone' : 'desktop'}`}>
      <figcaption><b>page</b> {scene.name} · {phone ? 'phone' : 'desktop'}</figcaption>
      <section ref={box} className="boards-board gallery-board" aria-label="Board" style={{ width, height: scene.height ?? 200 }}>
        <BoardHead heading={head.heading ?? 'Garden'} attention={attention.slice(0, head.chips)} onJump={() => {}} notices stale={!!head.stale} reload={() => {}}
          lost={head.lost ?? 0} onTryAll={() => {}} getting={!!head.getting} closed={!!head.closed} onClose={() => {}} onReopen={() => {}} tokenNotices={head.tokens ?? []} />
        <div className="boards-field gallery-field" />
      </section>
    </figure>
  );
}

/** A part of the page that is no brick, drawn as the page draws it (../main.tsx): the conversation's header at the
 * width the chat has beside a board, or a side placement whose body did not load. */
function PageShot({ scene }: { scene: PageScene }) {
  const thread = String(scene.params.thread ?? ''), names = (id: string) => id.slice(0, 1).toUpperCase() + id.slice(1);
  return (
    <figure data-shot={`page.${scene.name}.page`}>
      <figcaption><b>page</b> {scene.name}</figcaption>
      <SceneContext.Provider value={scene}>
        <Pressed labels={scene.press}>
          {scene.part === 'header' ? (
            <section className="boards-talk gallery-talk" aria-label="Conversation" style={{ width: 420, height: scene.height ?? 150 }}>
              <div className="boards-top">
                <button type="button" className="boards-presence">
                  <span className="boards-face" data-framed="true" style={{ width: 52, height: 52 }} />
                  <span className="boards-who"><span className="boards-name">Fern</span><span className="boards-where"><span className="boards-thread-title">Watering the raised beds</span><span role="status">Working</span></span></span>
                </button>
                <ThreadStop thread={thread} member="alex" name="Fern" />
                <ThreadSwitch thread={thread} visit={() => {}}><ThreadHead thread={thread} member="alex" /></ThreadSwitch>
              </div>
              <BridgeReceipt thread={thread} agentName={names} />
            </section>
          ) : (
            <PlacementFrame title="Ticket" sub="t-3" form="side" canMaximize style={{ width: 320, height: 200 }}>
              {scene.part === 'fetching' ? <Fetching /> : <Lost again={() => {}} />}
            </PlacementFrame>
          )}
        </Pressed>
      </SceneContext.Provider>
    </figure>
  );
}

function Gallery() {
  const sheet = query.get('sheet') as Drawn | null, only = query.get('brick');
  const missing = Object.keys(bricks).filter((name) => !all.some((b) => b.brick === name));
  if (sheet) {
    return (
      <div className="gallery-sheet" data-sheet={sheet}>
        {all.map((b) => { const scene = b.scenes.find((s) => s.name === 'default') ?? b.scenes[0]; return scene ? <Shot key={b.brick} brick={b.brick} scene={scene} form={sheet} /> : null; })}
      </div>
    );
  }
  return (
    <>
      {missing.length > 0 && <p className="gallery-missing">No fixtures: {missing.join(', ')}</p>}
      {(!only || only === 'page') && (
        <section className="gallery-group">
          {!only && <h1>The page</h1>}
          <section className="gallery-brick"><div className="gallery-scene">{pageScenes.map((scene) => <PageShot key={scene.name} scene={scene} />)}</div></section>
          <section className="gallery-brick"><div className="gallery-scene gallery-heads">{headScenes.map((scene) => <HeadShot key={scene.name} scene={scene} />)}</div></section>
        </section>
      )}
      {groups.map((group) => (
        <section key={group.name} className="gallery-group">
          {!only && <h1>{group.name}</h1>}
          {group.bricks.filter((b) => !only || b.brick === only).map((b) => (
            <section key={b.brick} className="gallery-brick">
              {b.scenes.map((scene) => (
                <div key={scene.name} className="gallery-scene">
                  {(['primary', 'side', 'compact'] as const).filter((form) => !scene.only || scene.only.includes(form)).map((form) => <Shot key={form} brick={b.brick} scene={scene} form={form} />)}
                </div>
              ))}
            </section>
          ))}
        </section>
      ))}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<main className="boards-page pair-workspace gallery"><Gallery /></main>);
