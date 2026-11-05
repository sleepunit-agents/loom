import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { markIosApp } from './standalone';
import { allowZoom, noTouchMenus } from './immersion';

// The worker that keeps the last copy of each page for when loom can't be reached, and shows push (src/ui/pwa.ts).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// On an iPhone's home screen the document is kept the screen's height, so the dock is at its bottom (standalone.ts).
markIosApp();

// An app, not a page (immersion.ts): no zoom unless this person allows it (this device's copy of their choice; App.tsx
// applies loom's once a page lands), and no long-press menu on the app's chrome, links and images.
allowZoom((() => { try { return localStorage.getItem('loom-zoom') === 'on'; } catch { return false; } })());
noTouchMenus();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
