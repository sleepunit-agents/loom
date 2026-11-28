// The sign-in gate: the page loom serves at the root and at every address that is not the boards page's
// (src/shared-web.ts). Signed out it is the gate (./signin.tsx), exactly as it was before the desktop; signed in it
// goes on to the boards page, which is the only page after sign-in (signin/gate-address.ts says where).
import { markIosApp } from '../standalone';
markIosApp();
import { StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Signin from './signin';
import { afterSignin } from '../signin/gate-address';
import '../index.css';
import { wearMotion, wearContrast, keptFollow } from '../access';
wearMotion(keptFollow('loom-motion')); wearContrast(keptFollow('loom-contrast'));

/** Signed in: on to the boards page, in place of this address, so Back does not come here again. */
function OnToBoards() {
  useLayoutEffect(() => { location.replace(afterSignin(location.pathname, location.search)); }, []);
  return null;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Signin><OnToBoards /></Signin></StrictMode>);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
