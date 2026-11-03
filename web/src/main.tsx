import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { markIosApp } from './standalone';

// The worker that keeps the last copy of each page for when loom can't be reached, and shows push (src/ui/pwa.ts).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

// On an iPhone's home screen the app scrolls inside #root, so the dock is at the bottom from the first paint (standalone.ts).
markIosApp();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
