(function () {
  'use strict';
  var KEY = 'mjhub_push_prompt_dismissed_until';
  var path = (location.pathname || '').toLowerCase();
  if (/dashboard|auth|admin|vendor/.test(path)) return;
  function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function installed() {
    return !!(navigator.standalone ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
  }
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function build() {
    if (!supported() || Notification.permission === 'denied') return;
    try { if (Date.now() < Number(localStorage.getItem(KEY) || 0)) return; } catch (_) {}
    var overlay = document.createElement('div');
    overlay.id = 'mjhubPushPrompt';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:max(16px,env(safe-area-inset-bottom));background:rgba(2,6,23,.56);backdrop-filter:blur(8px);font-family:Inter,system-ui,sans-serif;';
    var iosNeedsInstall = isIOS() && !installed();
    overlay.innerHTML =
      '<section role="dialog" aria-modal="true" aria-labelledby="mjPushPromptTitle" style="width:min(420px,100%);padding:22px 20px 18px;border-radius:24px;background:#0b1220;color:#f8fafc;border:1px solid rgba(96,165,250,.35);box-shadow:0 24px 70px rgba(0,0,0,.45)">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
          '<div style="width:48px;height:48px;border-radius:15px;background:linear-gradient(135deg,#2563eb,#7c3aed);display:grid;place-items:center;font-size:23px">🔔</div>' +
          '<div><div style="font-size:11px;font-weight:800;letter-spacing:.12em;color:#93c5fd">MJ HUB ALERTS</div><h2 id="mjPushPromptTitle" style="font-size:19px;line-height:1.2;margin:3px 0 0">Stay updated, wherever you are</h2></div>' +
        '</div>' +
        '<p style="font-size:13px;line-height:1.6;color:#cbd5e1;margin:0 0 14px">Get important account, service and platform updates on your phone, even when MJ HUB is not open. You can turn alerts off anytime.</p>' +
        (iosNeedsInstall ? '<div style="padding:12px;border-radius:13px;background:rgba(59,130,246,.12);font-size:12px;line-height:1.55;color:#dbeafe;margin-bottom:14px">On iPhone: open this page in Safari, tap Share, choose <b>Add to Home Screen</b>, then open MJ HUB from your Home Screen. Return here and enable alerts.</div>' : '') +
        '<button id="mjPushPromptEnable" type="button" style="width:100%;border:0;border-radius:13px;padding:14px;background:#2563eb;color:white;font-size:15px;font-weight:800">Enable phone notifications</button>' +
        '<button id="mjPushPromptLater" type="button" style="width:100%;border:0;background:transparent;color:#94a3b8;padding:12px 8px 4px;font-size:13px">Not now</button>' +
        '<div id="mjPushPromptError" role="status" style="font-size:12px;color:#fca5a5;margin-top:8px"></div>' +
      '</section>';
    document.documentElement.appendChild(overlay);
    function close(days) {
      try { localStorage.setItem(KEY, String(Date.now() + days * 86400000)); } catch (_) {}
      overlay.remove();
    }
    overlay.querySelector('#mjPushPromptLater').onclick = function(){ close(3); };
    overlay.addEventListener('click', function(e){ if(e.target===overlay) close(3); });
    overlay.querySelector('#mjPushPromptEnable').onclick = async function(){
      var btn = this, err = overlay.querySelector('#mjPushPromptError');
      btn.disabled = true; btn.textContent = 'Enabling…'; err.textContent = '';
      try {
        if (iosNeedsInstall && !installed()) throw new Error('First add MJ HUB to your Home Screen, then open it and enable notifications.');
        if (!window.MJHubPush) throw new Error('Notification service is still loading. Please try again.');
        await MJHubPush.enable();
        close(365);
        var toast = document.createElement('div');
        toast.textContent = 'Phone notifications are now enabled.';
        toast.style.cssText = 'position:fixed;z-index:2147483002;left:16px;right:16px;bottom:max(18px,env(safe-area-inset-bottom));padding:14px;border-radius:14px;background:#065f46;color:#fff;text-align:center;font:700 14px Inter,system-ui,sans-serif;box-shadow:0 10px 35px #0005';
        document.documentElement.appendChild(toast);
        setTimeout(function(){toast.remove();},3500);
      } catch(e) {
        err.textContent = e && e.message ? e.message : 'Could not enable notifications.';
        btn.disabled = false; btn.textContent = 'Try again';
      }
    };
  }
  function start() {
    if (!supported() || Notification.permission === 'denied') return;
    if (window.MJHubPush && MJHubPush.status) {
      MJHubPush.status().then(function(s){
        if (s.subscribed && s.permission === 'granted') return;
        setTimeout(build, 9000);
      }).catch(function(){ setTimeout(build, 9000); });
    } else setTimeout(build, 9000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();