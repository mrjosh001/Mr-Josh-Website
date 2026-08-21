/**
 * MJ Hub form UX helpers
 * - Live field validation + missing hints
 * - Disabled submit until valid
 * - Character counts
 * - Password rule checklist
 * - Forgiving phone normalization
 */
(function (w) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function digitsOnly(s) {
    return String(s || '').replace(/\D/g, '');
  }

  /** Accept 0803…, +234…, 234…, spaces/dashes */
  function normalizePhone(raw) {
    var d = digitsOnly(raw);
    if (d.indexOf('234') === 0 && d.length >= 13) d = '0' + d.slice(3);
    if (d.length === 10 && d.charAt(0) !== '0') d = '0' + d;
    return d;
  }

  function isValidNgPhone(raw) {
    var d = normalizePhone(raw);
    return /^0[7-9][0-1]\d{8}$/.test(d) || /^\d{10,14}$/.test(d);
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
  }

  function passwordRules(pw) {
    pw = String(pw || '');
    return {
      length: pw.length >= 8,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      number: /\d/.test(pw)
    };
  }

  function passwordOk(pw) {
    var r = passwordRules(pw);
    return r.length && r.upper && r.lower && r.number;
  }

  function setFieldState(input, state, message, force) {
    if (!input) return;
    var group = input.closest('.form-group') || input.parentElement;
    if (!group) return;
    group.classList.remove('is-valid', 'is-invalid', 'is-missing');
    // Don't paint red errors until the user has touched the field
    if (state && state !== 'is-valid' && !force && !group.classList.contains('touched')) {
      // keep clean until interaction
    } else if (state) {
      group.classList.add(state);
    }
    var hint = group.querySelector('.field-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'field-hint';
      group.appendChild(hint);
    }
    if (state === 'is-valid') {
      hint.textContent = '';
      hint.hidden = true;
    } else if (message && (force || group.classList.contains('touched'))) {
      hint.textContent = message;
      hint.hidden = false;
    } else {
      hint.textContent = '';
      hint.hidden = true;
    }
  }

  function ensureCharCount(input, max) {
    if (!input || !max) return null;
    var group = input.closest('.form-group') || input.parentElement;
    if (!group) return null;
    var el = group.querySelector('.char-count');
    if (!el) {
      el = document.createElement('div');
      el.className = 'char-count';
      group.appendChild(el);
    }
    var n = (input.value || '').length;
    el.textContent = n + ' / ' + max;
    el.classList.toggle('is-over', n > max);
    return el;
  }

  function renderPwChecklist(container, pw) {
    // Prefer the existing #pwRules list in auth.html — do not inject a second list
    var r = passwordRules(pw);
    var map = {
      pwRuleLen: r.length,
      pwRuleUp: r.upper,
      pwRuleLow: r.lower,
      pwRuleNum: r.number
    };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.className = map[id] ? 'ok' : 'bad';
    });
    // If a dedicated checklist container exists (no #pwRules), render once there
    if (container && !document.getElementById('pwRules')) {
      var items = [
        { ok: r.length, label: 'At least 8 characters' },
        { ok: r.upper, label: 'One uppercase letter' },
        { ok: r.lower, label: 'One lowercase letter' },
        { ok: r.number, label: 'One number' }
      ];
      container.innerHTML = items.map(function (it) {
        return '<div class="pw-check-item ' + (it.ok ? 'is-done' : '') + '">' +
          '<span class="pw-check-mark">' + (it.ok ? '✓' : '○') + '</span> ' +
          it.label + '</div>';
      }).join('');
    }
    return passwordOk(pw);
  }

  function wireSignupForm() {
    var form = $('signupForm');
    if (!form) return;

    var fullName = $('fullName');
    var username = $('username');
    var email = $('emailAddress');
    var phone = $('phoneNumber');
    var pass = $('signupPassword');
    var pass2 = $('signupPasswordConfirm');
    var btn = form.querySelector('.btn-submit') || $('signupSubmitBtn');

    // Password rules live in #pwRules (auth.html) — no duplicate list

    // Char limits
    if (fullName) { fullName.setAttribute('maxlength', '60'); }
    if (username) { username.setAttribute('maxlength', '24'); }
    if (phone) { phone.setAttribute('maxlength', '18'); phone.setAttribute('inputmode', 'tel'); }

    // Prefill email from query ?email=
    try {
      var q = new URLSearchParams(window.location.search);
      var preEmail = q.get('email');
      if (preEmail && email && !email.value) email.value = preEmail;
    } catch (e) {}

    function validate(showHints) {
      var missing = [];
      var ok = true;

      var fn = (fullName && fullName.value || '').trim();
      if (!fn || fn.length < 2) {
        ok = false; missing.push('full name');
        if (showHints && fullName) setFieldState(fullName, 'is-missing', 'Enter your full name');
      } else if (fullName) setFieldState(fullName, 'is-valid', '');

      var un = (username && username.value || '').trim();
      if (!un || un.length < 3) {
        ok = false; missing.push('username');
        if (showHints && username) setFieldState(username, 'is-missing', 'Username needs at least 3 characters');
      } else if (!/^[a-zA-Z0-9._]+$/.test(un)) {
        ok = false; missing.push('username');
        if (showHints && username) setFieldState(username, 'is-invalid', 'Use letters, numbers, dots or underscores only');
      } else if (username) setFieldState(username, 'is-valid', '');

      var em = (email && email.value || '').trim();
      if (!isValidEmail(em)) {
        ok = false; missing.push('email');
        if (showHints && email) setFieldState(email, 'is-missing', 'Enter a valid email like name@example.com');
      } else if (email) setFieldState(email, 'is-valid', '');

      var ph = (phone && phone.value || '').trim();
      if (!ph) {
        ok = false; missing.push('phone');
        if (showHints && phone) setFieldState(phone, 'is-missing', 'Enter your phone number');
      } else if (!isValidNgPhone(ph)) {
        ok = false; missing.push('phone');
        if (showHints && phone) setFieldState(phone, 'is-invalid', 'Enter a valid phone (dashes or spaces are fine)');
      } else if (phone) setFieldState(phone, 'is-valid', '');

      var pw = pass && pass.value || '';
      var pwGood = renderPwChecklist(null, pw);
      if (!pwGood) {
        ok = false; missing.push('password');
        if (showHints && pass) setFieldState(pass, 'is-missing', 'Use 8+ characters with upper, lower, and a number');
      } else if (pass) setFieldState(pass, 'is-valid', '');

      var pwC = pass2 && pass2.value || '';
      if (!pwC || pwC !== pw) {
        ok = false; missing.push('confirm password');
        if (showHints && pass2) setFieldState(pass2, pwC ? 'is-invalid' : 'is-missing', pwC ? 'Passwords do not match' : 'Confirm your password');
      } else if (pass2) setFieldState(pass2, 'is-valid', '');

      if (btn) {
        btn.disabled = !ok;
        btn.classList.toggle('is-disabled', !ok);
        btn.title = ok ? '' : ('Still needed: ' + missing.join(', '));
        var label = btn.querySelector('.btn-label') || btn;
        if (!btn.classList.contains('is-loading')) {
          // keep original text if loading
        }
      }

      var tip = $('signupMissingTip');
      if (!tip && form) {
        tip = document.createElement('div');
        tip.id = 'signupMissingTip';
        tip.className = 'form-missing-tip';
        if (btn && btn.parentNode) btn.parentNode.insertBefore(tip, btn);
        else form.appendChild(tip);
      }
      if (tip) {
        if (ok) {
          tip.hidden = true;
          tip.textContent = '';
        } else {
          tip.hidden = false;
          tip.textContent = 'Complete: ' + missing.join(' · ');
        }
      }

      return ok;
    }

    function onInput(e) {
      var t = e.target;
      if (t && t.closest) {
        var g = t.closest('.form-group');
        if (g) g.classList.add('touched');
      }
      if (t === fullName) ensureCharCount(fullName, 60);
      if (t === username) ensureCharCount(username, 24);
      if (t === phone) ensureCharCount(phone, 18);
      if (t === pass && typeof w.updatePasswordStrength === 'function') {
        try { w.updatePasswordStrength(pass.value); } catch (e2) {}
      }
      validate(true);
    }

    ['input', 'blur', 'change'].forEach(function (ev) {
      form.addEventListener(ev, onInput, true);
    });

    form.addEventListener('submit', function (e) {
      if (!validate(true)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Normalize phone before signup handler reads it
      if (phone) phone.value = normalizePhone(phone.value);
    }, true);

    // Remove any stale duplicate checklist nodes from older deploys
    document.querySelectorAll('.pw-checklist, #signupPwChecklist').forEach(function (n) {
      try { n.remove(); } catch (e) {}
    });
    validate(false);
  }

  function wireSigninForm() {
    var form = $('signinForm');
    if (!form) return;
    var email = $('signinEmail');
    var pass = $('signinPassword');
    var btn = form.querySelector('.btn-submit') || $('signinSubmitBtn');

    function validate(showHints) {
      var missing = [];
      var ok = true;
      var em = (email && email.value || '').trim();
      if (!isValidEmail(em)) {
        ok = false; missing.push('email');
        if (showHints && email) setFieldState(email, 'is-missing', 'Enter your account email');
      } else if (email) setFieldState(email, 'is-valid', '');
      var pw = pass && pass.value || '';
      if (!pw) {
        ok = false; missing.push('password');
        if (showHints && pass) setFieldState(pass, 'is-missing', 'Enter your password');
      } else if (pass) setFieldState(pass, 'is-valid', '');
      if (btn) {
        btn.disabled = !ok;
        btn.classList.toggle('is-disabled', !ok);
        btn.title = ok ? '' : ('Still needed: ' + missing.join(', '));
      }
      return ok;
    }

    form.addEventListener('input', function () { validate(true); }, true);
    form.addEventListener('blur', function () { validate(true); }, true);
    form.addEventListener('submit', function (e) {
      if (!validate(true)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    validate(false);
  }

  function wireForgotForm() {
    var form = $('forgotForm');
    if (!form) return;
    var email = $('forgotEmail');
    var btn = form.querySelector('.btn-submit') || $('forgotSubmitBtn');
    function validate(showHints) {
      var ok = isValidEmail(email && email.value);
      if (showHints && email) {
        setFieldState(email, ok ? 'is-valid' : 'is-missing', ok ? '' : 'Enter the email on your account');
      }
      if (btn) { btn.disabled = !ok; btn.classList.toggle('is-disabled', !ok); }
      return ok;
    }
    form.addEventListener('input', function () { validate(true); }, true);
    form.addEventListener('submit', function (e) {
      if (!validate(true)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    validate(false);
  }

  function wireUpdatePasswordForm() {
    var form = $('updatePasswordForm');
    if (!form) return;
    var pass = $('newPassword');
    var btn = form.querySelector('.btn-submit') || $('updatePassSubmitBtn');
    function validate(showHints) {
      var pw = pass && pass.value || '';
      var ok = renderPwChecklist(null, pw);
      if (showHints && pass) setFieldState(pass, ok ? 'is-valid' : 'is-missing', ok ? '' : 'Meet all password checks');
      if (btn) { btn.disabled = !ok; btn.classList.toggle('is-disabled', !ok); }
      return ok;
    }
    form.addEventListener('input', function () {
      if (pass && typeof w.updatePasswordStrength === 'function') {
        try { w.updatePasswordStrength(pass.value); } catch (e) {}
      }
      validate(true);
    }, true);
    form.addEventListener('submit', function (e) {
      if (!validate(true)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    validate(false);
  }

  function init() {
    wireSignupForm();
    wireSigninForm();
    wireForgotForm();
    wireUpdatePasswordForm();
  }

  w.MJFormUX = {
    init: init,
    normalizePhone: normalizePhone,
    isValidEmail: isValidEmail,
    isValidNgPhone: isValidNgPhone,
    passwordOk: passwordOk,
    passwordRules: passwordRules
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
