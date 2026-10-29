import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// The worker that keeps the last copy of each page for when loom can't be reached, and shows push (src/ui/pwa.ts).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
