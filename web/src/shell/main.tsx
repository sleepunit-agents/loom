import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { apps } from '../apps';
import Shell from './index';
import '../index.css';
import { wearMotion, wearContrast, keptFollow } from '../access';
wearMotion(keptFollow('loom-motion')); wearContrast(keptFollow('loom-contrast'));
const fixtureApps = document.documentElement.dataset.fixture === 'true' ? [{
  id:'example',title:'Live example',icon:'activity',path:'/_dev/live-example',
  fit:{min:[320,280] as [number,number],ideal:520,max:680,big:false,why:'a small live list'},
  Screen:lazy(() => import('../data-demo')),
}] : [];
createRoot(document.getElementById('root')!).render(<StrictMode><Shell apps={[...apps,...fixtureApps]} /></StrictMode>);
