// SONDE TEMPORAIRE (à retirer) : comportements du WebKit de Playwright, pour décider des adaptations.
const test = require('node:test');
const banc = require('../banc');

banc.brancher();

test('sonde webkit', async () => {
  if (!banc.WEBKIT) return;
  const t = await banc.telephone('Sonde');
  const p = t.page;
  const log = (k, v) => console.log(`# SONDE ${k} : ${JSON.stringify(v)}`);
  await p.goto(`${banc.origine}/__vide.html`);
  const imageBlob = () => p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
    const u = URL.createObjectURL(b);
    const img = await new Promise((r) => { const i = new Image(); i.onload = () => r('ok ' + i.naturalWidth); i.onerror = () => r('erreur'); i.src = u; });
    let f; try { f = (await (await fetch(u)).blob()).size; } catch (e) { f = 'fetch erreur ' + e.message; }
    const d = await new Promise((r) => { const i = new Image(); i.onload = () => r('ok'); i.onerror = () => r('erreur'); i.src = c.toDataURL(); });
    return { img, f, d, onLine: navigator.onLine };
  });
  const navs = [];
  await p.exposeFunction('__nav', (u) => navs.push(u));
  await p.evaluate(() => { navigation.addEventListener('navigate', (e) => window.__nav(e.destination.url)); });
  const reqs = [];
  p.on('request', (r) => reqs.push(r.url()));
  p.on('requestfailed', (r) => reqs.push('échec ' + r.url() + ' ' + (r.failure() || {}).errorText));
  await p.evaluate(() => { location.href = 'intent://quitter?cle=abc#Intent;scheme=papote;package=fr.mapapote.famille;end'; });
  await p.waitForTimeout(1500);
  log('intent', { navs, reqs, url: p.url() });
  await p.goto(`${banc.origine}/__vide.html`);
  log('en ligne blob', await imageBlob());
  await t.context.setOffline(true);
  log('hors ligne blob', await imageBlob());
  await t.context.setOffline(false);

  for (const css of ['', 'html{touch-action:manipulation}']) {
    await p.goto(`${banc.origine}/__vide.html`);
    await p.evaluate((style) => {
      const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1, viewport-fit=cover'; document.head.append(m);
      const s = document.createElement('style'); s.textContent = style + ' body{margin:0;font:16px sans-serif} button{display:block;margin:200px auto;padding:20px 40px}'; document.head.append(s);
      const b = document.createElement('button'); b.textContent = 'Résilier'; document.body.append(b);
      const p2 = document.createElement('p'); p2.textContent = 'texte '.repeat(200); document.body.append(p2);
      window.ev = [];
      for (const n of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu']) b.addEventListener(n, () => window.ev.push(n));
    }, css);
    const bb = await p.locator('button').boundingBox();
    await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await p.waitForTimeout(800);
    log(`double appui ${css || 'sans touch-action'}`, await p.evaluate(() => ({ ev: window.ev, scale: visualViewport.scale })));
    await p.evaluate(() => { window.ev = []; });
    await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await p.waitForTimeout(500);
    await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await p.waitForTimeout(800);
    log(`deux appuis espacés ${css || 'sans touch-action'}`, await p.evaluate(() => ({ ev: window.ev, scale: visualViewport.scale })));
  }

  await p.goto(`${banc.origine}/__vide.html`);
  log('images', await p.evaluate(async () => {
    const d = document.createElement('div'); d.style.cssText = 'height:0;background:red;overflow:hidden'; document.body.append(d);
    const t0 = performance.now(); const dts = []; let prev = t0;
    await new Promise((r) => { (function f() { const n = performance.now(); dts.push(Math.round(n - prev)); prev = n; if (n - t0 < 1500) requestAnimationFrame(f); else r(); })(); setTimeout(() => { d.style.transition = 'height 250ms ease-in-out'; d.style.height = '200px'; }, 500); });
    return { n: dts.length, max: Math.max(...dts), dts: dts.slice(0, 80) };
  }));
  log('caméra', await p.evaluate(async () => {
    const out = {};
    for (const [k, c] of [['défaut', true], ['640x480', { width: 640, height: 480 }]]) {
      try { const s = await navigator.mediaDevices.getUserMedia({ video: c }); const st = s.getVideoTracks()[0].getSettings(); out[k] = [st.width, st.height]; s.getTracks().forEach((x) => x.stop()); } catch (e) { out[k] = e.name; }
    }
    out.mr = typeof MediaRecorder;
    out.touch = typeof Touch;
    out.nav = typeof navigation;
    return out;
  }));
});
