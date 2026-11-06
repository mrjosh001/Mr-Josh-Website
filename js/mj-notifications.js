/* MJ HUB — Global Toast Notifications
 * One visible notification at a time. Legacy showToast(msg, type) is supported.
 */
(function (w, d) {
  'use strict';
  if (w.__mjNotificationsReady) return;
  w.__mjNotificationsReady = true;

  var active = null;
  var sequence = 0;
  var styleId = 'mj-global-toast-style';
  var rootId = 'mj-global-toast-root';
  var icons = {
    success: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.8"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3h.01"/><path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
    loading: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/></svg>'
  };
  var labels = {success:'Completed',error:'Something went wrong',warning:'Action required',info:'Notice',loading:'Please wait'};
  var defaultTitles = {success:'Success',error:'Unable to complete',warning:'Action required',info:'Information',loading:'Processing'};

  function addStyles() {
    if (d.getElementById(styleId)) return;
    var css = [
      '#'+rootId+'{position:fixed;z-index:2147483646;top:calc(22px + env(safe-area-inset-top,0px));right:24px;width:min(280px,calc(100vw - 24px));pointer-events:none;font-family:inherit;color:#f8fafc}',
      '#'+rootId+' .mj-toast{--mj-accent:#5ee6b8;--mj-rgb:94,230,184;position:relative;display:grid;grid-template-columns:48px minmax(0,1fr) 34px;align-items:center;gap:12px;min-height:70px;padding:10px 12px;overflow:hidden;border:1px solid rgba(var(--mj-rgb),.58);border-radius:21px;background:linear-gradient(112deg,rgba(var(--mj-rgb),.17),rgba(12,14,20,.94) 38%,rgba(12,14,20,.97));box-shadow:0 18px 55px rgba(0,0,0,.42),0 0 22px rgba(var(--mj-rgb),.13),inset 0 1px 0 rgba(255,255,255,.09);-webkit-backdrop-filter:blur(24px) saturate(1.45);backdrop-filter:blur(24px) saturate(1.45);pointer-events:auto;opacity:0;transform:translate3d(24px,-8px,0) scale(.985);transition:opacity .24s ease,transform .32s cubic-bezier(.2,.8,.2,1)}',
      '#'+rootId+' .mj-toast.is-visible{opacity:1;transform:translate3d(0,0,0) scale(1)}',
      '#'+rootId+' .mj-toast.is-leaving{opacity:0;transform:translate3d(18px,-5px,0) scale(.985)}',
      '#'+rootId+' .mj-toast::before{content:\"\";position:absolute;left:20px;top:0;width:52px;height:2px;background:linear-gradient(90deg,transparent,var(--mj-accent),transparent);filter:drop-shadow(0 0 7px var(--mj-accent))}',
      '#'+rootId+' .mj-toast-icon{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:rgba(var(--mj-rgb),.16);box-shadow:inset 0 0 0 1px rgba(var(--mj-rgb),.12);color:var(--mj-accent)}',
      '#'+rootId+' .mj-toast-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 7px rgba(var(--mj-rgb),.48))}',
      '#'+rootId+' .mj-toast-copy{min-width:0;padding:2px 0}',
      '#'+rootId+' .mj-toast-title{display:block;margin:0 0 3px;color:#fff;font-size:12.5px;line-height:1.2;font-weight:700;letter-spacing:-.035em;overflow-wrap:anywhere}',
      '#'+rootId+' .mj-toast-message{display:block;color:rgba(241,245,249,.76);font-size:10.5px;line-height:1.3;font-weight:400;overflow-wrap:anywhere}',
      '#'+rootId+' .mj-toast-close{width:26px;height:26px;border:0;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.085);color:rgba(255,255,255,.84);cursor:pointer;transition:background .18s ease,transform .18s ease}',
      '#'+rootId+' .mj-toast-close:hover{background:rgba(255,255,255,.16);transform:scale(1.05)}',
      '#'+rootId+' .mj-toast-close svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;stroke-linecap:round}',
      '#'+rootId+' .mj-toast-progress{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--mj-accent);transform-origin:left;opacity:.8;animation:mjToastTimer linear forwards}',
      '#'+rootId+' .mj-toast[data-type=\"error\"]{--mj-accent:#ff6678;--mj-rgb:255,102,120}',
      '#'+rootId+' .mj-toast[data-type=\"warning\"]{--mj-accent:#ffc66b;--mj-rgb:255,198,107}',
      '#'+rootId+' .mj-toast[data-type=\"info\"]{--mj-accent:#55c8ff;--mj-rgb:85,200,255}',
      '#'+rootId+' .mj-toast[data-type=\"loading\"]{--mj-accent:#65baff;--mj-rgb:101,186,255}',
      '#'+rootId+' .mj-toast[data-type=\"loading\"] .mj-toast-icon svg{animation:mjToastSpin 1.15s linear infinite}',
      '@keyframes mjToastTimer{from{transform:scaleX(1)}to{transform:scaleX(0)}}@keyframes mjToastSpin{to{transform:rotate(360deg)}}',
      'html[data-theme=\"light\"] #'+rootId+' .mj-toast,body[data-theme=\"light\"] #'+rootId+' .mj-toast{background:linear-gradient(112deg,rgba(var(--mj-rgb),.17),rgba(255,255,255,.97) 42%,rgba(255,255,255,.98));box-shadow:0 18px 45px rgba(15,23,42,.16),0 0 18px rgba(var(--mj-rgb),.1)}',
      'html[data-theme=\"light\"] #'+rootId+' .mj-toast-title,body[data-theme=\"light\"] #'+rootId+' .mj-toast-title{color:#101827}',
      'html[data-theme=\"light\"] #'+rootId+' .mj-toast-message,body[data-theme=\"light\"] #'+rootId+' .mj-toast-message{color:#526174}',
      'html[data-theme=\"light\"] #'+rootId+' .mj-toast-close,body[data-theme=\"light\"] #'+rootId+' .mj-toast-close{background:rgba(15,23,42,.07);color:#263244}',
      '@media(max-width:600px){#'+rootId+'{top:calc(10px + env(safe-area-inset-top,0px));right:10px;width:calc(100vw - 20px)}#'+rootId+' .mj-toast{grid-template-columns:32px minmax(0,1fr) 24px;gap:7px;min-height:48px;padding:6px 8px;border-radius:13px}#'+rootId+' .mj-toast-icon{width:32px;height:32px}#'+rootId+' .mj-toast-icon svg{width:16px;height:16px}#'+rootId+' .mj-toast-title{font-size:11.5px;margin-bottom:1px}#'+rootId+' .mj-toast-message{font-size:10px}#'+rootId+' .mj-toast-close{width:24px;height:24px}#'+rootId+' .mj-toast-close svg{width:12px;height:12px}}',
      '@media(prefers-reduced-motion:reduce){#'+rootId+' .mj-toast,#'+rootId+' .mj-toast-close{transition:none}#'+rootId+' .mj-toast-progress{animation:none;display:none}#'+rootId+' .mj-toast[data-type=\"loading\"] .mj-toast-icon svg{animation:none}}'
    ].join('');
    var style=d.createElement('style');style.id=styleId;style.textContent=css;(d.head||d.documentElement).appendChild(style);
  }
  function getRoot(){addStyles();var root=d.getElementById(rootId);if(!root){root=d.createElement('div');root.id=rootId;root.setAttribute('aria-live','polite');root.setAttribute('aria-atomic','true');root.setAttribute('role','status');d.body.appendChild(root);}return root;}
  function dismiss(id, immediate){
    if(!active||active.id!==id)return;
    var item=active;active=null;
    if(item.timer)w.clearTimeout(item.timer);
    if(item.node&&item.node.parentNode){
      item.node.classList.remove('is-visible');
      item.node.classList.add('is-leaving');
      if(immediate||item.reduced){item.node.remove();return;}
      w.setTimeout(function(){if(item.node.parentNode)item.node.remove();},260);
    }
  }
  function notify(input, legacyType){
    var opts=typeof input==='string'?{message:input,type:legacyType||'success'}:(input||{});
    var type=String(opts.type||'info').toLowerCase();
    if(!icons[type])type='info';
    var message=String(opts.message==null?'':opts.message);
    var title=String(opts.title||defaultTitles[type]);
    var duration=opts.duration==null?(type==='loading'?0:4200):Math.max(0,Number(opts.duration)||0);
    var id=++sequence;
    if(active)dismiss(active.id,true);
    var root=getRoot();
    var node=d.createElement('div');node.className='mj-toast';node.dataset.type=type;node.setAttribute('role',type==='error'?'alert':'status');
    var icon=d.createElement('div');icon.className='mj-toast-icon';icon.innerHTML=icons[type];
    var copy=d.createElement('div');copy.className='mj-toast-copy';
    var heading=d.createElement('strong');heading.className='mj-toast-title';heading.textContent=title;
    var body=d.createElement('span');body.className='mj-toast-message';body.textContent=message;
    copy.appendChild(heading);copy.appendChild(body);
    var close=d.createElement('button');close.className='mj-toast-close';close.type='button';close.setAttribute('aria-label','Dismiss notification');close.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    node.appendChild(icon);node.appendChild(copy);node.appendChild(close);
    if(duration>0){var progress=d.createElement('span');progress.className='mj-toast-progress';progress.style.animationDuration=duration+'ms';node.appendChild(progress);}
    root.appendChild(node);
    var reduced=false;try{reduced=w.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
    active={id:id,node:node,timer:null,reduced:reduced};
    close.addEventListener('click',function(){dismiss(id,false);});
    w.requestAnimationFrame(function(){if(active&&active.id===id)node.classList.add('is-visible');});
    if(duration>0)active.timer=w.setTimeout(function(){dismiss(id,false);},duration);
    return {id:id,dismiss:function(){dismiss(id,false);},update:function(next){if(active&&active.id===id){notify(Object.assign({},opts,next||{}));}}};
  }
  notify.dismiss=function(){if(active)dismiss(active.id,false);};
  notify.success=function(message,title){return notify({type:'success',message:message,title:title});};
  notify.error=function(message,title){return notify({type:'error',message:message,title:title});};
  notify.warning=function(message,title){return notify({type:'warning',message:message,title:title});};
  notify.info=function(message,title){return notify({type:'info',message:message,title:title});};
  notify.loading=function(message,title){return notify({type:'loading',message:message,title:title,duration:0});};
  w.mjNotify=notify;
  w.mjToast=notify;
  /* Existing site pages call showToast(message, 'success'|'error'). Route those calls
     into the single global visual system without requiring page-by-page rewrites. */
  w.showToast=function(message,type){return notify({message:message,type:type==='error'?'error':(type||'success')});};
})(window,document);
