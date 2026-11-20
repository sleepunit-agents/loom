/** Fit only this composer's Split above an unzoomed visual keyboard. Never change the shell or another tile. */
export function bindComposerViewport(form:HTMLFormElement){
 const box=form.closest<HTMLElement>('.loom-comms'),viewport=window.visualViewport;
 if(!box||!viewport)return()=>{};
 const clear=()=>{box.style.removeProperty('--comms-visible-height');box.removeAttribute('data-comms-keyboard');};
 const fit=()=>{
  const bottom=viewport.offsetTop+viewport.height;
  if(!form.contains(document.activeElement)||viewport.scale!==1||window.innerHeight-bottom<80){clear();return;}
  const height=Math.max(0,bottom-box.getBoundingClientRect().top);
  box.style.setProperty('--comms-visible-height',`${height}px`);box.setAttribute('data-comms-keyboard','');
 };
 viewport.addEventListener('resize',fit);viewport.addEventListener('scroll',fit);
 window.addEventListener('resize',fit);form.addEventListener('focusin',fit);form.addEventListener('focusout',fit);
 fit();
 return()=>{viewport.removeEventListener('resize',fit);viewport.removeEventListener('scroll',fit);window.removeEventListener('resize',fit);form.removeEventListener('focusin',fit);form.removeEventListener('focusout',fit);clear();};
}
