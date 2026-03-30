// Build timestamp: 2026-03-30 17:30:18 UTC
// sw.js – Service Worker för Lufttryck-appen
// Hanterar Periodic Background Sync och push-notiser i bakgrunden.
//
// Flöde när Chrome triggar bakgrundssynken:
//   1. Hämta senaste lufttryck från Open-Meteo (Vallentuna)
//   2. Jämför med senaste sparade värdet i Cache Storage
//   3. Skicka notis om trycket förändrats tillräckligt mycket

const CACHE_NAME   = 'lufttryck-v1';
const STATE_KEY    = 'last-pressure';   // nyckel för cachat tryckvärde
const FALLBACK_LAT = 59.5344;           // Vallentuna
const FALLBACK_LON = 18.0762;
const NOTIFY_THRESHOLD_HPA = 3;        // hPa förändring → skicka notis

// ─── Install & Activate ──────────────────────────────────────────────────────
// Vi tar över direkt utan att vänta på att gamla flikar stängs.
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ─── Periodic Background Sync ────────────────────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-pressure') {
    // waitUntil ser till att service workern inte avslutas
    // innan hela asynkrona jobbet är klart
    e.waitUntil(checkAndNotify());
  }
});

// ─── Huvud-logik ─────────────────────────────────────────────────────────────
async function checkAndNotify() {
  try {
    // Hämta aktuellt lufttryck från Open-Meteo
    const url = `https://api.open-meteo.com/v1/forecast`
              + `?latitude=${FALLBACK_LAT}&longitude=${FALLBACK_LON}`
              + `&current=surface_pressure`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const hpa  = data?.current?.surface_pressure;
    if (hpa == null) return;

    // Läs senast sparade tryckvärde från Cache Storage
    const cache = await caches.open(CACHE_NAME);
    const prev  = await readState(cache);

    // Spara det nya värdet så nästa körning kan jämföra
    await writeState(cache, { hpa, time: Date.now() });

    // Om vi inte har något tidigare värde är det första körningen – avvakta
    if (prev == null) return;

    const diff    = hpa - prev.hpa;
    const absDiff = Math.abs(diff);
    const hours   = (Date.now() - prev.time) / 3600000;

    // Notifiera bara om förändringen är stor nog relativt tid som gått.
    // Vi normaliserar till hPa/timme för att undvika falska larm om
    // service workern råkar köras tätt inpå föregående körning.
    const ratePerHour = hours > 0 ? absDiff / hours : 0;
    if (ratePerHour < 1 && absDiff < NOTIFY_THRESHOLD_HPA) return;

    // Bygg ett vettigt notismeddelande
    const dir   = diff > 0 ? '↑ ökar' : '↓ sjunker';
    const title = absDiff >= 5
      ? '🧠 Hög migränrisk – stort tryckfall!'
      : `⚠️ Lufttrycket ${dir} snabbt`;
    const body  = `${diff > 0 ? '+' : ''}${diff.toFixed(1)} hPa`
                + ` sedan senaste mätning (nu: ${hpa.toFixed(1)} hPa)`;

    await self.registration.showNotification(title, {
      body,
      icon:    'icon-192.png',
      badge:   'icon-192.png',
      vibrate: [200, 100, 200, 100, 200],
      // data används om användaren trycker på notisen
      data: { url: self.registration.scope }
    });

  } catch (err) {
    // Tyst fel – vi vill inte att service workern kraschar
    console.warn('[sw] checkAndNotify fel:', err);
  }
}

// ─── Hjälpfunktioner för Cache Storage ───────────────────────────────────────
// Vi använder Cache Storage som enkel key-value-lagring eftersom
// localStorage inte är tillgängligt i service workers.

async function readState(cache) {
  try {
    const res = await cache.match(STATE_KEY);
    if (!res) return null;
    return await res.json();
  } catch { return null; }
}

async function writeState(cache, obj) {
  const res = new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' }
  });
  await cache.put(STATE_KEY, res);
}

// ─── Notis-klick: öppna appen ────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Om appen redan är öppen i en flik – fokusera den
        const existing = clients.find(c => c.url === target);
        if (existing) return existing.focus();
        // Annars öppna en ny flik
        return self.clients.openWindow(target);
      })
  );
});
