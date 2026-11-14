import { lazy, Suspense, createElement } from 'react';
import { Loading } from '../../kit/loading';
const Home = lazy(() => import('./home'));
export function HomeSurface(props: { go?: (path:string)=>void }) {
  return createElement(Suspense,{fallback:createElement(Loading,{label:'Opening Home…'})},createElement<{go?:(path:string)=>void}>(Home,props));
}
export const homeApp = {
  id: 'home-preview', title: 'Home', icon: 'home', path: '/p/home-preview',
  fit: { min: [520,320] as [number,number], ideal:1040, max:null, big:true, why:'owned agents and their current questions' },
  Screen: Home,
};

const Rail = lazy(() => import('./rail'));
export function RailSurface(props: { go: (path:string)=>void }) {
  return createElement(Suspense,{fallback:createElement(Loading,{label:'Opening your agents…'})},createElement(Rail,props));
}

const Bar = lazy(() => import('./bar'));
export function BarSurface(props: import('./bar').BarProps) {
  return createElement(Suspense,{fallback:null},createElement(Bar,props));
}

const Signals = lazy(() => import('./desk-signals'));
export function SignalsSurface(props: {go:(path:string)=>void;onAttention:(value:boolean)=>void}) {
  return createElement(Suspense,{fallback:null},createElement(Signals,props));
}
