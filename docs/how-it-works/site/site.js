// Theme switch (data-theme on <html>, remembered per browser) and opening a table when a link points at it.
(function(){
  var root=document.documentElement;
  try{var saved=localStorage.getItem('loom-docs-theme');if(saved==='light'||saved==='dark')root.setAttribute('data-theme',saved);}catch(e){}
  function now(){return root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}
  function openTarget(){var el=location.hash.length>1&&document.getElementById(location.hash.slice(1));if(el&&el.tagName==='DETAILS'){el.open=true;el.scrollIntoView({block:'nearest'});}}
  document.addEventListener('DOMContentLoaded',function(){
    var b=document.getElementById('theme');
    function label(){if(b)b.textContent=now()==='dark'?'Light':'Dark';}
    label();
    if(b)b.addEventListener('click',function(){var next=now()==='dark'?'light':'dark';root.setAttribute('data-theme',next);try{localStorage.setItem('loom-docs-theme',next);}catch(e){}label();});
    openTarget();
  });
  addEventListener('hashchange',openTarget);
})();
