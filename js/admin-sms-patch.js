/* MJ HUB admin patch: intentionally empty.
 * Server 3 (VirtualSMS) layout, shared Edit Price popup, the Profit lines on every SMS server and the
 * Profit on sold numbers in SMS Orders now live directly inside admin.html, so nothing needs patching here.
 * (Keeping this file prevents the old patch from overriding admin.html's own functions.) */
(function () { 'use strict'; window.__mjAdminSmsPatch = true; })();
