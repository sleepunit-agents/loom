import InboxNotice from '../pieces/tempo/notice';
import Appearance from './appearance';
import { markIosApp } from '../standalone';
markIosApp();
import { StrictMode } from 'react';
import { LazyMotion, domAnimation } from 'motion/react';
import { createRoot } from 'react-dom/client';
import { apps, shellSurfaces } from '../apps';
import Shell from './index';
import Signin from './signin';
import { stagingApp } from '../pieces/staging/registration';
import '../index.css';
import { wearMotion, wearContrast, keptFollow } from '../access';
wearMotion(keptFollow('loom-motion')); wearContrast(keptFollow('loom-contrast'));
createRoot(document.getElementById('root')!).render(<StrictMode><LazyMotion features={domAnimation}><Signin><Appearance><InboxNotice /><Shell surfaces={shellSurfaces} apps={[...apps,...(document.documentElement.dataset.staging==='true'?[stagingApp]:[])]} /></Appearance></Signin></LazyMotion></StrictMode>);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
