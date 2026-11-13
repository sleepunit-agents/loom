import { lazy, StrictMode } from 'react';
import { LazyMotion, domAnimation } from 'motion/react';
import { createRoot } from 'react-dom/client';
import { apps, shellSurfaces } from '../apps';
import Shell from './index';
import { stagingApp } from '../pieces/staging/registration';
import '../index.css';
import { wearMotion, wearContrast, keptFollow } from '../access';
wearMotion(keptFollow('loom-motion')); wearContrast(keptFollow('loom-contrast'));
const fixtureApps = document.documentElement.dataset.fixture === 'true' ? [{
  id:'example',title:'Live example',icon:'activity',path:'/_dev/live-example',
  fit:{min:[320,280] as [number,number],ideal:520,max:680,big:false,why:'a small live list'},
  Screen:lazy(() => import('../data-demo')),
}] : [];
createRoot(document.getElementById('root')!).render(<StrictMode><LazyMotion features={domAnimation}><Shell surfaces={shellSurfaces} apps={[...apps,...fixtureApps,...(document.documentElement.dataset.staging==='true'?[stagingApp]:[])]} /></LazyMotion></StrictMode>);
