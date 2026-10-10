import { DEPLOYMENT_RELOAD_COOLDOWN_MS } from './data/deployment'
import { STORAGE_PURGE_COOKIE } from './domain/storage-purge'

/** Long enough that a slow first paint is never mistaken for a build that cannot load. */
const BOOT_RECOVERY_DELAY_MS = 10_000

export const BOOT_RECOVERY_COOKIE = 'spice.boot-recovery.v1'

/**
 * How long the cleanup may hold the reload. Unregistering a worker takes a healthy browser
 * well under a second; a wedged one never answers, and the reload is what fixes it.
 */
const BOOT_RECOVERY_CLEANUP_TIMEOUT_MS = 3_000

/**
 * The body is empty until the app hydrates, so anything that stops the entry module from
 * running leaves a blank page and no code of ours to notice. A shell held by an obsolete
 * service worker does exactly that: it names hashed files that no longer exist, every one
 * 404s, and nothing runs.
 *
 * This is deliberately inline, dependency-free, and ES5: it has to survive in a document
 * whose modules never loaded. If nothing has reported hydration by the deadline, it drops
 * the caches and workers that could be pinning the reader to a dead build, and reloads.
 *
 * The attempt is recorded so a genuinely broken deploy cannot loop, and it is recorded in a
 * cookie because the guard's own reload drops the purge receipt: the reloaded document then
 * carries `Clear-Site-Data: "storage"`, which empties session storage before it commits, so a
 * session-storage latch would be gone every time it was read and the loop it exists to stop
 * would run forever. Cookies are the one class that purge spares. The latch expires on the same
 * cooldown the deployment reload uses: iOS restores tabs across app restarts, and a latch that
 * never expired would turn one failed attempt into a tab that never tries again. A cookie that
 * cannot be read cannot bound a loop either, so it counts as an attempt in progress.
 *
 * The reload is the part that must happen. The registration and cache APIs it waits on live
 * in the same worker process that may be the problem, so the wait is bounded, and the purge
 * receipt is dropped first so the reloaded document asks the browser itself to clear the
 * origin (see `finalizeDocumentResponse`) — a path that needs no answer from that process.
 */
export function bootRecoveryScript(
  delayMs: number = BOOT_RECOVERY_DELAY_MS,
  cooldownMs: number = DEPLOYMENT_RELOAD_COOLDOWN_MS,
  cleanupTimeoutMs: number = BOOT_RECOVERY_CLEANUP_TIMEOUT_MS,
): string {
  return `(function(){
  var KEY='${BOOT_RECOVERY_COOKIE}';
  var COOLDOWN=${cooldownMs};
  var MAX_AGE=${Math.ceil(cooldownMs / 1_000)};
  var PURGE_COOKIE='${STORAGE_PURGE_COOKIE}';
  var SECURE=location.protocol === 'https:' ? '; Secure' : '';
  function attemptedAt(){ try {
    var pairs=document.cookie.split(';');
    for (var i=0;i<pairs.length;i++) {
      var separator=pairs[i].indexOf('=');
      if (separator === -1) continue;
      if (pairs[i].slice(0, separator).trim() === KEY) return Number(pairs[i].slice(separator + 1).trim());
    }
    return 0;
  } catch (error) { return Infinity } }
  function remember(){ try { document.cookie=KEY+'='+Date.now()+'; Max-Age='+MAX_AGE+'; Path=/; SameSite=Lax'+SECURE } catch (error) {} }
  window.__spiceBooted=function(){ clearTimeout(timer); try { document.cookie=KEY+'=; Max-Age=0; Path=/' } catch (error) {} };
  var timer=setTimeout(function(){
    var at=attemptedAt();
    if (at > 0 && Date.now() - at < COOLDOWN) return;
    remember();
    var reloaded=false;
    var reload=function(){
      if (reloaded) return;
      reloaded=true;
      try { document.cookie=PURGE_COOKIE+'=; Max-Age=0; Path=/' } catch (error) {}
      location.reload();
    };
    setTimeout(reload, ${cleanupTimeoutMs});
    var work=[];
    if (navigator.serviceWorker) work.push(navigator.serviceWorker.getRegistrations().then(function(all){
      return Promise.all(all.map(function(one){ return one.unregister() }));
    }));
    if (window.caches) work.push(caches.keys().then(function(names){
      return Promise.all(names.map(function(name){ return caches.delete(name) }));
    }));
    Promise.all(work).then(reload, reload);
  }, ${delayMs});
})()`
}
