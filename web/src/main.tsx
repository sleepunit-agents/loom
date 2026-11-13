import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { appAt } from './apps';
// The shell needs animation and focus/hover features, but no drag or layout projection.
// Keep these synchronous so initial presence states paint and animate on the first frame.
import { LazyMotion, domAnimation } from 'motion/react';
import { markIosApp } from './standalone';
import { allowZoom, noTouchMenus } from './immersion';
import { keptFollow, wearContrast, wearMotion } from './access';

// The worker that keeps the last copy of each page for when loom can't be reached, and shows push (src/ui/pwa.ts).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// On an iPhone's home screen the document is kept the screen's height, so the dock is at its bottom (standalone.ts).
markIosApp();

// An app, not a page (immersion.ts): no zoom unless this person allows it (this device's copy of their choice; App.tsx
// applies loom's once a page lands), and no long-press menu on the app's chrome, links and images.
allowZoom((() => { try { return localStorage.getItem('loom-zoom') === 'on'; } catch { return false; } })());
noTouchMenus();

// Reduce motion and Higher contrast (access.ts): boot.js has already set them for the first paint; from here they keep
// following the phone while the person's choice is to follow it (App.tsx applies loom's copy once a page lands).
wearMotion(keptFollow('loom-motion'));
wearContrast(keptFollow('loom-contrast'));

const Screen = appAt(location.pathname)?.Screen ?? (location.pathname === '/_dev/live-example' ? lazy(() => import('./data-demo')) : App);

createRoot(document.getElementById('root')!).render(<StrictMode><LazyMotion features={domAnimation}><Suspense fallback={null}><Screen /></Suspense></LazyMotion></StrictMode>);
