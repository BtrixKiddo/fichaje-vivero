'use strict';
/* Fichaje Vivero — todo offline, todo en el dispositivo. Sin servidores. */
const APP_VERSION = 'v22'; // se muestra en Ajustes/Exportar para saber qué versión tiene el móvil

/* ============================ IndexedDB ============================ */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('fichaje_vivero', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('workers', { keyPath: 'uid' });   // {uid, nombre, foto, alta_ts}
    d.createObjectStore('records', { keyPath: 'seq' });    // cadena append-only (fichajes + correcciones)
    d.createObjectStore('meta', { keyPath: 'id' });        // {id:'chain',...} , {id:'pin',hash}
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
let db;

const idbReq = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const metaGet = id => idbReq(db.transaction('meta').objectStore('meta').get(id));
const metaPut = v => idbReq(db.transaction('meta', 'readwrite').objectStore('meta').put(v));
const getAllRecords = () => idbReq(db.transaction('records').objectStore('records').getAll());
const getAllWorkers = () => idbReq(db.transaction('workers').objectStore('workers').getAll());
const getWorker = uid => idbReq(db.transaction('workers').objectStore('workers').get(uid));
const putWorker = w => idbReq(db.transaction('workers', 'readwrite').objectStore('workers').put(w));

/* ==================== Cadena con hash (inalterabilidad) ==================== */
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Serialización estable (claves ordenadas) para que el hash sea reproducible.
function canonical(o) { return JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]])); }

async function buildRecord(fields, prevHash, seq) {
  const content = { ...fields, seq, prevHash };
  const hash = await sha256hex(canonical(content));
  return { ...content, hash };
}

// Append-only: nunca se edita ni se borra. Un candado en memoria serializa las escrituras.
// ponytail: candado global; el kiosco tiene un solo lector NFC, no hay concurrencia real.
let appendLock = Promise.resolve();
function appendRecord(fields) {
  appendLock = appendLock.then(() => doAppend(fields), () => doAppend(fields));
  return appendLock;
}
async function doAppend(fields) {
  const head = (await metaGet('chain')) || { id: 'chain', lastSeq: 0, lastHash: 'GENESIS' };
  const record = await buildRecord(fields, head.lastHash, head.lastSeq + 1);
  await new Promise((res, rej) => {
    const t = db.transaction(['records', 'meta'], 'readwrite');
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    // sin await entre los dos put -> la transacción no se cierra sola
    t.objectStore('records').put(record);
    t.objectStore('meta').put({ id: 'chain', lastSeq: record.seq, lastHash: record.hash });
  });
  return record;
}

// Recalcula toda la cadena: detecta cualquier hash o prevHash alterado.
async function verifyRecords(recs) {
  recs = recs.slice().sort((a, b) => a.seq - b.seq);
  let prev = 'GENESIS';
  for (const r of recs) {
    const { hash, ...content } = r;
    if (content.prevHash !== prev) return { ok: false, seq: r.seq, reason: 'prevHash roto' };
    if (await sha256hex(canonical(content)) !== hash) return { ok: false, seq: r.seq, reason: 'hash no coincide' };
    prev = hash;
  }
  return { ok: true, count: recs.length };
}
const verifyChain = async () => verifyRecords(await getAllRecords());

/* ============ Fichajes efectivos (aplica correcciones sin tocar el original) ============ */
function effectivePunches(records, uid) {
  const map = new Map();
  for (const r of records)
    if (r.type === 'fichaje' && r.uid === uid)
      map.set(r.seq, { seq: r.seq, uid, tipo: r.tipo, ts: r.ts, origen: 'fichaje' });
  const corr = records.filter(r => r.type === 'correccion' && r.uid === uid).sort((a, b) => a.seq - b.seq);
  for (const c of corr) {
    if (c.op === 'anular') map.delete(c.targetSeq);
    else if (c.op === 'modificar' && map.has(c.targetSeq)) {
      const p = map.get(c.targetSeq);
      if (c.tsCorregido != null) p.ts = c.tsCorregido;
      if (c.tipoCorregido) p.tipo = c.tipoCorregido;
      p.origen = 'corregido';
    } else if (c.op === 'agregar')
      map.set('c' + c.seq, { seq: 'c' + c.seq, uid, tipo: c.tipoCorregido, ts: c.tsCorregido, origen: 'añadido' });
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

/* ============================ Cálculo de horas ============================ */
const pad = n => String(n).padStart(2, '0');
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const msToH = ms => ms / 3600000;
const fmtH = ms => { const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000); return `${h}h ${pad(m)}m`; };

// Regla de pausa de comida por trabajador (por defecto: −30 min salvo jun/jul/ago, que no restan).
function ruleFor(w) {
  const p = (w && w.pausa) || {};
  return { min: p.min != null ? p.min : 30, cuando: p.cuando || 'invierno', umbralH: p.umbralH != null ? p.umbralH : 6 };
}
// Empareja ENTRADA con SALIDA del mismo día. Marca incompleto si algo queda sin pareja.
function computeDays(records, uid, rule) {
  rule = rule || ruleFor(null);
  const byDay = {};
  for (const p of effectivePunches(records, uid)) (byDay[dayKey(p.ts)] ||= []).push(p);
  const days = [];
  for (const [date, list] of Object.entries(byDay)) {
    list.sort((a, b) => a.ts - b.ts);
    let open = null, worked = 0, incompleto = false, pares = 0;
    for (const p of list) {
      if (p.tipo === 'entrada') { if (open) incompleto = true; open = p; }
      else { if (open) { worked += p.ts - open.ts; open = null; pares++; } else incompleto = true; }
    }
    if (open) incompleto = true;
    // Si solo hay UN tramo (no ficharon la comida) y es jornada larga, se resta la pausa.
    // Si fichan 4 veces, ya queda excluida por el hueco y no se resta nada.
    const mes = +date.split('-')[1];
    // 'invierno' (estándar) = restar salvo verano; verano = junio, julio y agosto (meses 6, 7 y 8).
    const aplica = rule.cuando === 'siempre' ? true : (rule.cuando === 'invierno' ? !(mes >= 6 && mes <= 8) : false);
    let descanso = 0;
    // ponytail: umbral en horas para no restar comida en una media jornada (p. ej. solo la mañana).
    if (aplica && rule.min > 0 && !incompleto && pares === 1 && worked >= rule.umbralH * 3600000) {
      descanso = rule.min * 60000; worked -= descanso;
    }
    days.push({ date, worked, incompleto, list, descanso });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}
// Texto de estado del día (para Excel/PDF/pantalla).
const estadoTxt = d => d.incompleto ? 'INCOMPLETO' : (d.descanso ? `OK (-${d.descanso / 60000} min comida)` : 'OK');
// Compara las horas de una semana con las previstas del trabajador (mínimo).
function estadoSemana(workedMs, targetH) {
  if (!targetH) return '';
  const faltan = targetH - msToH(workedMs);
  return faltan <= 0.01 ? 'Cumple' : 'Faltan ' + (Math.round(faltan * 100) / 100) + ' h';
}

// Un fichaje es "a mano" si el admin lo añadió o corrigió (no salió del kiosco).
const isManual = p => p.origen !== 'fichaje';
const fmtMark = p => hhmm(p.ts) + (isManual(p) ? '*' : '');
function dayCols(d) {
  return {
    ent: d.list.filter(p => p.tipo === 'entrada').map(fmtMark).join(' / '),
    sal: d.list.filter(p => p.tipo === 'salida').map(fmtMark).join(' / '),
    manual: d.list.some(isManual)
  };
}
function describeCorr(c) {
  if (c.op === 'agregar') return `Añadió ${c.tipoCorregido} a las ${hhmm(c.tsCorregido)}`;
  if (c.op === 'anular') return `Anuló el fichaje #${c.targetSeq}`;
  if (c.op === 'modificar') return `Cambió la hora del #${c.targetSeq} a las ${hhmm(c.tsCorregido)}`;
  return c.op;
}
// ¿Añadir (tipo, ts) mantiene el día alternando entrada→salida→entrada→salida…?
function secuenciaValida(dayPunches, tipo, ts) {
  const seq = [...dayPunches.map(p => ({ tipo: p.tipo, ts: p.ts })), { tipo, ts }].sort((a, b) => a.ts - b.ts);
  let esperado = 'entrada';
  for (const p of seq) { if (p.tipo !== esperado) return false; esperado = esperado === 'entrada' ? 'salida' : 'entrada'; }
  return true;
}

function thisWeek() { const d = new Date(); const off = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - off); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return [iso(mon), iso(sun)]; }
function thisMonth() { const d = new Date(); return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), iso(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }
function thisYear() { const y = new Date().getFullYear(); return [`${y}-01-01`, `${y}-12-31`]; }

// Agrupar días por semana (lunes) o por mes, para los totales.
function mondayOf(dateStr) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
const weekKey = dateStr => iso(mondayOf(dateStr));
const monthKey = dateStr => dateStr.slice(0, 7);
function weekLabel(mondayIso) {
  const m = new Date(mondayIso + 'T00:00:00'), s = new Date(m); s.setDate(m.getDate() + 6);
  const f = dt => dt.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `${f(m)} – ${f(s)}`;
}
const monthLabel = ym => { const [y, m] = ym.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }); };
// Suma días por semana o por mes -> [{label, worked, dias, inc}]
function groupTotals(days, group) {
  const keyFn = group === 'semana' ? weekKey : monthKey, labelFn = group === 'semana' ? weekLabel : monthLabel, g = {};
  for (const d of days) { const o = g[keyFn(d.date)] || (g[keyFn(d.date)] = { worked: 0, inc: 0, dias: 0 }); o.worked += d.worked; if (d.incompleto) o.inc++; o.dias++; }
  return Object.keys(g).sort().map(k => ({ label: labelFn(k), ...g[k] }));
}

/* ============================ Utilidades UI ============================ */
const $ = s => document.querySelector(s);
const show = id => { document.querySelectorAll('.screen').forEach(e => e.classList.remove('active')); $(id).classList.add('active'); };
const setPanel = html => { $('#adminBody').innerHTML = html; };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2500); }
function download(name, mime, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Guarda el último Excel generado para poder ENVIARLO (compartir) después con un solo toque.
// (Compartir justo tras generar falla en algunos Samsung con NotAllowedError. Con el archivo ya
//  hecho, el toque de "Enviar" tiene activación fresca del usuario y el menú de compartir sí abre.)
let lastExport = null;
async function shareLast() {
  if (!lastExport) return 'Primero pulsa “Exportar Excel”.';
  const { name, mime, bytes } = lastExport;
  let file;
  try { file = new File([bytes], name, { type: mime }); } catch (_) { return 'Este móvil no permite compartir; el archivo está en Descargas.'; }
  if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) return 'Este móvil no permite compartir; ábrelo desde Descargas.';
  try { await navigator.share({ files: [file] }); return 'Enviado ✓'; }
  catch (e) { return (e && e.name === 'AbortError') ? 'Cancelado' : 'No se pudo abrir el menú de compartir; el archivo está en Descargas.'; }
}
const normUid = s => String(s || '').toLowerCase();
function workerSelect(id, ws, sel) { return `<select id="${id}">${ws.map(w => `<option value="${w.uid}" ${w.uid === sel ? 'selected' : ''}>${w.nombre}</option>`).join('')}</select>`; }

// Reduce la foto a 320px máx para no llenar la memoria.
async function fileToThumb(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 320 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.8);
}

/* ============================ KIOSCO ============================ */
let nfcReader = null, captureCb = null, lastRead = { uid: null, at: 0 }, resultTimer;

// Alterna: cada día nuevo empieza por ENTRADA; dentro del día alterna entrada/salida.
async function nextTipo(uid) {
  const eff = effectivePunches(await getAllRecords(), uid);
  const last = eff[eff.length - 1];
  const sameDay = last && dayKey(last.ts) === dayKey(Date.now());
  return (sameDay && last.tipo === 'entrada') ? 'salida' : 'entrada';
}
async function onCard(raw) {
  const uid = normUid(raw);
  if (captureCb) { const cb = captureCb; captureCb = null; cb(uid); toast('Tarjeta leída: ' + uid); return; }
  const now = Date.now();
  if (uid === lastRead.uid && now - lastRead.at < 4000) return; // ignora la misma tarjeta repetida
  lastRead = { uid, at: now };
  const worker = await getWorker(uid);
  if (!worker) return showResult(null, uid);
  const tipo = await nextTipo(uid);
  const rec = await appendRecord({ type: 'fichaje', uid, tipo, ts: now });
  showResult(worker, uid, tipo, rec.ts);
}
window.simulateCard = onCard; // probar sin NFC desde la consola: simulateCard('04:aa:bb')

function showResult(worker, uid, tipo, ts) {
  clearTimeout(resultTimer);
  const box = $('#result');
  $('#rest').classList.add('hidden');
  box.className = '';
  if (!worker) {
    box.classList.add('unknown');
    $('#rPhoto').style.display = 'none';
    $('#rName').textContent = 'Tarjeta no dada de alta';
    $('#rMsg').textContent = '✗';
    $('#rTime').textContent = uid;
  } else {
    box.classList.add(tipo === 'entrada' ? 'entrada' : 'salida');
    $('#rPhoto').style.display = worker.foto ? 'block' : 'none';
    $('#rPhoto').src = worker.foto || '';
    $('#rName').textContent = worker.nombre;
    $('#rMsg').textContent = tipo === 'entrada' ? 'ENTRADA registrada ✓' : 'SALIDA registrada ✓';
    $('#rTime').textContent = hhmm(ts);
  }
  resultTimer = setTimeout(() => { box.classList.add('hidden'); $('#rest').classList.remove('hidden'); }, 3500);
}

async function startNFC() {
  if (!('NDEFReader' in window)) { $('#nfcWarn').classList.remove('hidden'); return; }
  try {
    const r = new NDEFReader();
    await r.scan();                 // pide permiso NFC (requiere HTTPS y a veces un toque)
    r.onreading = e => onCard(e.serialNumber);
    nfcReader = r;
    $('#tapHint').classList.add('hidden');
  } catch (err) {
    $('#tapHint').classList.remove('hidden'); // necesita un gesto del usuario -> tocar pantalla
  }
}
async function captureUid(cb) { if (!nfcReader) await startNFC(); captureCb = cb; toast('Acerca la tarjeta…'); }

// Reloj grande en la pantalla de reposo.
function startClock() {
  const upd = () => {
    const now = new Date();
    const h = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const f = now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    for (const [t, d] of [['#clock', '#restDate'], ['#pClock', '#pDate']]) {
      const te = $(t), de = $(d); if (te) te.textContent = h; if (de) de.textContent = f;
    }
  };
  upd(); setInterval(upd, 1000);
}

/* ============================ MODO PERSONAL ============================ */
// Aplica el modo guardado: kiosco (NFC) o personal (botón de un solo trabajador).
let personalTimer = null;
async function applyMode() {
  const cfg = (await metaGet('config')) || { modo: 'kiosco' };
  if (cfg.modo === 'personal' && cfg.personalUid && await getWorker(cfg.personalUid)) {
    await setupPersonal(cfg.personalUid);
    show('#personal');
  } else {
    clearInterval(personalTimer);
    show('#kiosk');
    if (!nfcReader) startNFC();
  }
}
async function setupPersonal(uid) {
  const w = await getWorker(uid);
  if (!w) return;
  $('#pPhoto').src = w.foto || '';
  $('#pPhoto').style.display = w.foto ? 'block' : 'none';
  $('#pName').textContent = w.nombre;
  await personalRefresh(uid);
  clearInterval(personalTimer);
  personalTimer = setInterval(() => updatePersonalStatus(uid), 20000); // horas del día en vivo
}
async function personalRefresh(uid) {
  const tipo = await nextTipo(uid);
  const btn = $('#pBtn');
  btn.className = 'bigbtn ' + tipo;
  btn.textContent = tipo === 'entrada' ? 'FICHAR ENTRADA' : 'FICHAR SALIDA';
  btn.onclick = async () => {
    const t = await nextTipo(uid);
    const rec = await appendRecord({ type: 'fichaje', uid, tipo: t, ts: Date.now() });
    showResult(await getWorker(uid), uid, t, rec.ts);
    setTimeout(() => personalRefresh(uid), 3600);
  };
  await updatePersonalStatus(uid);
}
// Muestra si está dentro/fuera hoy y cuántas horas lleva.
async function updatePersonalStatus(uid) {
  const el = $('#pStatus'); if (!el) return;
  const hoy = dayKey(Date.now());
  const eff = effectivePunches(await getAllRecords(), uid).filter(p => dayKey(p.ts) === hoy);
  let worked = 0, open = null;
  for (const p of eff) { if (p.tipo === 'entrada') open = p; else if (open) { worked += p.ts - open.ts; open = null; } }
  const live = worked + (open ? Date.now() - open.ts : 0);
  if (open) { el.className = 'pstatus in'; el.innerHTML = `<span class="pdot"></span>Dentro desde las ${hhmm(open.ts)} · <b>${fmtH(live)}</b> hoy`; }
  else if (eff.length) { el.className = 'pstatus out'; el.innerHTML = `Fuera · <b>${fmtH(live)}</b> trabajadas hoy`; }
  else { el.className = 'pstatus out'; el.textContent = 'Aún no has fichado hoy'; }
}

/* ============================ PIN ============================ */
const pinHash = pin => sha256hex('pin:' + pin);
async function checkPin(pin) {
  const stored = await metaGet('pin');
  if (!stored) return pin === '1234';            // PIN por defecto la primera vez
  return (await pinHash(pin)) === stored.hash;
}
let pinBuf = '', pinCb = null;
function openPinpad(label, cb) { pinBuf = ''; pinCb = cb; $('#pinLabel').textContent = label; drawPin(); show('#adminLogin'); }
function drawPin() { $('#pinDots').textContent = '●'.repeat(pinBuf.length) + '○'.repeat(Math.max(0, 4 - pinBuf.length)); }
function openAdminLogin() {
  openPinpad('Introduce el PIN', async pin => {
    if (await checkPin(pin)) openAdmin();
    else { $('#pinLabel').textContent = 'PIN incorrecto'; pinBuf = ''; drawPin(); }
  });
}

/* ============================ ADMIN ============================ */
function openAdmin() { show('#admin'); panelHoras(); }
function exitAdmin() { captureCb = null; applyMode(); }

/* --- Alta y edición de trabajadores --- */
let altaFotoData = '';
async function panelAlta() {
  setPanel(`
    <h2>Trabajadores y tarjetas</h2>
    <p>Da de alta acercando una tarjeta (o escribe el número), o pulsa <b>Editar</b> en la lista de abajo para cambiar nombre o foto.</p>
    <div class="row"><button id="altaLeer" class="btn">📶 Leer tarjeta</button>
      <input id="altaUid" placeholder="UID de la tarjeta"></div>
    <p>Nombre:</p>
    <input id="altaNombre" placeholder="Nombre">
    <p>Foto (cámara o galería):</p>
    <input id="altaFoto" type="file" accept="image/*">
    <img id="altaPrev" class="prev hidden">
    <p>Regla de comida (para el cálculo de horas):</p>
    <div class="row">
      <select id="altaPausaCuando">
        <option value="invierno">Estándar: restar salvo jun, jul y ago</option>
        <option value="siempre">Restar siempre (todo el año)</option>
        <option value="nunca">No restar nunca</option>
      </select>
      <input id="altaPausaMin" type="number" min="0" value="30" style="width:80px"> min
    </div>
    <p>Horas previstas por semana (para avisar si llega al mínimo; deja 0 si no quieres control):</p>
    <div class="row"><input id="altaHorasSem" type="number" min="0" step="0.5" value="0" style="width:90px"> h/semana</div>
    <div class="row"><button id="altaGuardar" class="btn primary">Guardar</button>
      <button id="altaLimpiar" class="btn">Nuevo / limpiar</button></div>
    <div id="altaMsg" class="msg"></div>
    <h3>Trabajadores</h3><div id="altaLista"></div>`);
  altaFotoData = '';
  $('#altaLeer').onclick = () => captureUid(uid => { $('#altaUid').value = uid; });
  $('#altaFoto').onchange = async e => { if (e.target.files[0]) { altaFotoData = await fileToThumb(e.target.files[0]); showAltaPrev(altaFotoData); } };
  $('#altaLimpiar').onclick = () => { $('#altaUid').value = ''; $('#altaNombre').value = ''; altaFotoData = ''; showAltaPrev(''); $('#altaPausaCuando').value = 'invierno'; $('#altaPausaMin').value = '30'; $('#altaHorasSem').value = '0'; $('#altaMsg').textContent = ''; };
  $('#altaGuardar').onclick = async () => {
    const uid = normUid($('#altaUid').value.trim()), nombre = $('#altaNombre').value.trim();
    if (!uid || !nombre) { $('#altaMsg').textContent = 'Falta el UID o el nombre'; return; }
    const exists = await getWorker(uid);
    const pausa = { cuando: $('#altaPausaCuando').value, min: +$('#altaPausaMin').value || 0 };
    const horasSemana = +$('#altaHorasSem').value || 0;
    await putWorker({ uid, nombre, foto: altaFotoData || (exists && exists.foto) || '', alta_ts: (exists && exists.alta_ts) || Date.now(), pausa, horasSemana });
    $('#altaMsg').textContent = exists ? 'Trabajador actualizado ✓' : 'Trabajador dado de alta ✓';
    captureCb = null; renderAltaLista();
  };
  renderAltaLista();
}
function showAltaPrev(data) { const p = $('#altaPrev'); if (data) { p.src = data; p.classList.remove('hidden'); } else { p.src = ''; p.classList.add('hidden'); } }
async function renderAltaLista() {
  const ws = await getAllWorkers();
  $('#altaLista').innerHTML = ws.length
    ? ws.map(w => `<div class="wrow">${w.foto ? `<img src="${w.foto}" class="mini">` : '<span class="mini mini-ph">👤</span>'}${w.nombre} <span class="muted">${w.uid}</span> <button class="btn sm" data-edit="${w.uid}">Editar</button></div>`).join('')
    : '<p class="muted">Ninguno todavía.</p>';
  $('#altaLista').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editWorker(b.dataset.edit));
}
async function editWorker(uid) {
  const w = await getWorker(uid); if (!w) return;
  $('#altaUid').value = w.uid;
  $('#altaNombre').value = w.nombre;
  altaFotoData = w.foto || '';
  showAltaPrev(w.foto || '');
  const r = ruleFor(w);
  $('#altaPausaCuando').value = r.cuando;
  $('#altaPausaMin').value = r.min;
  $('#altaHorasSem').value = w.horasSemana || 0;
  $('#altaMsg').textContent = 'Editando a ' + w.nombre + ' — cambia lo que quieras y pulsa Guardar';
  $('#adminBody').scrollIntoView({ block: 'start' });
}

/* --- Corrección (log de auditoría, nunca borra el original) --- */
async function panelCorreccion(preUid, preDate) {
  const ws = await getAllWorkers();
  if (!ws.length) return setPanel('<h2>Corrección</h2><p class="muted">Primero da de alta trabajadores.</p>');
  setPanel(`
    <h2>Corrección de fichajes</h2>
    <p class="muted">No se borra nada. Se añade un registro de corrección con motivo.</p>
    <div class="row">${workerSelect('corrW', ws, preUid)}
      <input type="date" id="corrD" value="${preDate || iso(new Date())}">
      <button id="corrVer" class="btn">Ver día</button></div>
    <div id="corrDay"></div>
    <h3>Añadir un fichaje que falta</h3>
    <div class="row">
      <select id="addTipo"><option value="entrada">Entrada</option><option value="salida">Salida</option></select>
      <input type="time" id="addTime">
      <input id="addMot" placeholder="Motivo">
      <button id="addBtn" class="btn">Añadir</button></div>
    <div id="corrMsg" class="msg"></div>`);
  $('#corrVer').onclick = renderCorrDay;
  $('#corrW').onchange = renderCorrDay;   // al cambiar de trabajador se ve su día automáticamente
  $('#corrD').onchange = renderCorrDay;   // idem al cambiar la fecha
  $('#addBtn').onclick = async () => {
    const uid = $('#corrW').value, date = $('#corrD').value, t = $('#addTime').value, mot = $('#addMot').value.trim(), tipo = $('#addTipo').value;
    if (!uid || !date || !t || !mot) { $('#corrMsg').textContent = 'Faltan datos (el motivo es obligatorio)'; return; }
    const ts = new Date(`${date}T${t}`).getTime();
    // El día debe quedar entrada → salida → entrada → salida… (una salida por cada entrada).
    const dia = effectivePunches(await getAllRecords(), uid).filter(p => dayKey(p.ts) === date);
    if (!secuenciaValida(dia, tipo, ts)) {
      $('#corrMsg').textContent = tipo === 'salida'
        ? 'No se puede: quedaría una SALIDA sin su ENTRADA (cada entrada lleva como mucho una salida).'
        : 'No se puede: quedarían dos ENTRADAS seguidas. Primero la salida de la anterior.';
      return;
    }
    await appendRecord({ type: 'correccion', op: 'agregar', uid, tipoCorregido: tipo, tsCorregido: ts, motivo: mot, ts: Date.now() });
    $('#corrMsg').textContent = 'Corrección añadida ✓'; renderCorrDay();
  };
  renderCorrDay();
}
async function renderCorrDay() {
  const uid = $('#corrW').value, date = $('#corrD').value;
  const list = effectivePunches(await getAllRecords(), uid).filter(p => dayKey(p.ts) === date);
  $('#corrDay').innerHTML = list.length ? list.map(p => `
    <div class="prow ${p.tipo}">
      <b>${p.tipo === 'entrada' ? 'ENTRADA' : 'SALIDA'}</b> ${hhmm(p.ts)} <span class="muted">(${p.origen})</span>
      ${typeof p.seq === 'number' ? `<button class="btn sm" data-anular="${p.seq}">Anular</button>
      <button class="btn sm" data-mod="${p.seq}">Cambiar hora</button>` : ''}
    </div>`).join('') : '<p class="muted">Sin fichajes ese día.</p>';
  $('#corrDay').querySelectorAll('[data-anular]').forEach(b => b.onclick = () => corrOp('anular', +b.dataset.anular));
  $('#corrDay').querySelectorAll('[data-mod]').forEach(b => b.onclick = () => corrOp('modificar', +b.dataset.mod));
}
// ponytail: prompt() basta para el admin (sabe leer); cambiar a modal propio si algún Chrome lo bloquea.
async function corrOp(op, seq) {
  const uid = $('#corrW').value, date = $('#corrD').value;
  let extra = {};
  if (op === 'modificar') {
    const nueva = prompt('Nueva hora (HH:MM):'); if (!nueva) return;
    const ts = new Date(`${date}T${nueva}`).getTime();
    if (isNaN(ts)) return alert('Hora no válida');
    extra = { tsCorregido: ts };
  }
  const mot = prompt(op === 'anular' ? 'Motivo para anular:' : 'Motivo del cambio:'); if (!mot) return;
  await appendRecord({ type: 'correccion', op, uid, targetSeq: seq, motivo: mot, ts: Date.now(), ...extra });
  renderCorrDay();
}

/* --- Días incompletos (para corregir de un vistazo) --- */
async function panelIncompletos() {
  const recs = await getAllRecords();
  const workers = await getAllWorkers();
  const items = [];
  const hoy = dayKey(Date.now());
  for (const w of workers)
    for (const d of computeDays(recs, w.uid, ruleFor(w)))
      // excluye hoy: quien está fichado y aún no ha salido no es un error, es que sigue trabajando
      if (d.incompleto && d.date < hoy) items.push({ nombre: w.nombre, uid: w.uid, date: d.date, list: d.list });
  items.sort((a, b) => (a.date < b.date ? 1 : -1)); // más recientes primero
  const rows = items.map(it => {
    const marcas = it.list.map(p => `${p.tipo === 'entrada' ? 'E' : 'S'} ${hhmm(p.ts)}`).join(' · ') || '—';
    return `<tr><td>${it.nombre}</td><td>${it.date}</td><td>${marcas}</td><td><button class="btn sm" data-uid="${it.uid}" data-date="${it.date}">Corregir</button></td></tr>`;
  }).join('');
  setPanel(`
    <h2>Días incompletos</h2>
    <p class="muted">Un día está <b>incompleto</b> cuando falta fichar la <b>entrada</b> o la <b>salida</b>
    (queda un número impar de marcas), así que ese día no cuenta bien las horas. Pulsa <b>Corregir</b>
    para añadir lo que falta. <br>La columna <b>Marcas</b> muestra lo que hay: <b>E</b> = entrada, <b>S</b> = salida.</p>
    ${items.length
      ? `<div class="scrollx"><table class="grid"><tr><th>Trabajador</th><th>Fecha</th><th>Marcas</th><th></th></tr>${rows}</table></div>
         <p class="leyenda">El día de hoy no aparece: quien está fichado y aún no ha salido no es un error.</p>`
      : '<p class="msg big">✅ No hay días incompletos.</p>'}`);
  document.querySelectorAll('#adminBody [data-uid]').forEach(b => b.onclick = () => panelCorreccion(b.dataset.uid, b.dataset.date));
}

/* --- Horas / resumen --- */
async function renderHoursTable(container, from, to, onlyUid, group = 'dia') {
  const recs = await getAllRecords();
  const workers = (await getAllWorkers()).filter(w => !onlyUid || w.uid === onlyUid);
  let html = '';
  for (const w of workers) {
    const days = computeDays(recs, w.uid, ruleFor(w)).filter(d => (!from || d.date >= from) && (!to || d.date <= to));
    let tot = 0;
    if (group === 'dia') {
      html += `<div class="wblock"><h3>${w.nombre}</h3><table class="grid"><tr><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Horas</th></tr>`;
      if (!days.length) html += '<tr><td colspan="4" class="muted">Sin fichajes en el periodo</td></tr>';
      for (const d of days) {
        tot += d.worked;
        const c = dayCols(d);
        html += `<tr class="${d.incompleto ? 'inc' : ''}"><td>${d.date}</td><td>${c.ent || '—'}</td><td>${c.sal || '—'}</td><td>${d.incompleto ? '⚠ ' : ''}${fmtH(d.worked)}${d.descanso ? ` <span class="muted">(−${d.descanso / 60000}m comida)</span>` : ''}</td></tr>`;
      }
      html += `<tr class="tot"><td colspan="3">TOTAL</td><td>${fmtH(tot)}</td></tr></table></div>`;
    } else {
      const keyFn = group === 'semana' ? weekKey : monthKey;
      const labelFn = group === 'semana' ? weekLabel : monthLabel;
      const groups = {};
      for (const d of days) { const g = groups[keyFn(d.date)] || (groups[keyFn(d.date)] = { worked: 0, inc: 0, dias: 0 }); g.worked += d.worked; if (d.incompleto) g.inc++; g.dias++; }
      const keys = Object.keys(groups).sort();
      const target = group === 'semana' ? (+w.horasSemana || 0) : 0;
      html += `<div class="wblock"><h3>${w.nombre}</h3><table class="grid"><tr><th>${group === 'semana' ? 'Semana' : 'Mes'}</th><th>Días</th><th>Horas</th>${target ? '<th>Previstas</th>' : ''}</tr>`;
      if (!keys.length) html += `<tr><td colspan="${target ? 4 : 3}" class="muted">Sin fichajes en el periodo</td></tr>`;
      for (const k of keys) {
        const g = groups[k]; tot += g.worked;
        const est = target ? estadoSemana(g.worked, target) : '';
        const cumple = est === 'Cumple';
        html += `<tr class="${g.inc ? 'inc' : ''}"><td>${labelFn(k)}</td><td>${g.dias}${g.inc ? ` <span class="muted">(${g.inc} incompleto/s)</span>` : ''}</td><td>${fmtH(g.worked)}</td>${target ? `<td>${target}h — <b style="color:${cumple ? '#1b8a3a' : '#c62828'}">${est}</b></td>` : ''}</tr>`;
      }
      html += `<tr class="tot"><td colspan="2">TOTAL</td><td>${fmtH(tot)}</td>${target ? '<td></td>' : ''}</tr></table></div>`;
    }
  }
  html += '<p class="leyenda">⚠ = día/periodo con algún fichaje incompleto &nbsp;·&nbsp; <b>*</b> = hora puesta por el administrador &nbsp;·&nbsp; se resta la comida (30 min) salvo jun–ago, si solo se ficha entrada y salida</p>';
  container.innerHTML = html || '<p class="muted">No hay trabajadores.</p>';
}
async function panelHoras() {
  const [f, t] = thisMonth();
  setPanel(`
    <h2>Horas trabajadas</h2>
    <div class="row">Ver por:
      <select id="hGroup"><option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option></select>
      <button id="hSem" class="btn">Esta semana</button>
      <button id="hMes" class="btn">Este mes</button>
      <button id="hAno" class="btn">Este año</button>
    </div>
    <div class="row">Desde <input type="date" id="hFrom" value="${f}"> Hasta <input type="date" id="hTo" value="${t}">
      <button id="hVer" class="btn primary">Ver</button></div>
    <div id="hTable"></div>`);
  const go = () => renderHoursTable($('#hTable'), $('#hFrom').value, $('#hTo').value, null, $('#hGroup').value);
  $('#hVer').onclick = go;
  $('#hGroup').onchange = go;
  $('#hSem').onclick = () => { const [a, b] = thisWeek(); $('#hFrom').value = a; $('#hTo').value = b; $('#hGroup').value = 'dia'; go(); };
  $('#hMes').onclick = () => { const [a, b] = thisMonth(); $('#hFrom').value = a; $('#hTo').value = b; $('#hGroup').value = 'semana'; go(); };
  $('#hAno').onclick = () => { const [a, b] = thisYear(); $('#hFrom').value = a; $('#hTo').value = b; $('#hGroup').value = 'mes'; go(); };
  go();
}

/* --- Consulta de un trabajador --- */
async function panelConsulta() {
  const ws = await getAllWorkers();
  if (!ws.length) return setPanel('<h2>Consulta</h2><p class="muted">Primero da de alta trabajadores.</p>');
  const [f, t] = thisMonth();
  setPanel(`
    <h2>Consultar un trabajador</h2>
    <div class="row">${workerSelect('cW', ws)}
      <select id="cGroup"><option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option></select>
    </div>
    <div class="row">Desde <input type="date" id="cFrom" value="${f}"> Hasta <input type="date" id="cTo" value="${t}">
      <button id="cVer" class="btn primary">Ver</button></div>
    <div id="cTable"></div>`);
  const go = () => renderHoursTable($('#cTable'), $('#cFrom').value, $('#cTo').value, $('#cW').value, $('#cGroup').value);
  $('#cVer').onclick = go; $('#cGroup').onchange = go; $('#cW').onchange = go; go();
}

/* --- Exportar: genera un .xlsx de verdad (una hoja por tabla, números como números) --- */
// Generador XLSX sin librerías: ZIP "stored" (sin comprimir) + XML mínimo. Validado con SheetJS.
const _CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = _CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data), size = data.length;
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)];
    parts.push(Uint8Array.from(local), name, data);
    central.push({ name, crc, size, offset });
    offset += local.length + name.length + size;
  }
  const cdStart = offset, cdParts = [];
  for (const c of central) {
    const h = [0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
    cdParts.push(Uint8Array.from(h), c.name);
    offset += h.length + c.name.length;
  }
  const cdSize = offset - cdStart;
  const end = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]);
  const all = [...parts, ...cdParts, end];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
function sheetXml(rows) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  rows.forEach((row, ri) => {
    x += `<row r="${ri + 1}">`;
    row.forEach((val, ci) => {
      if (val === '' || val === null || val === undefined) return;
      const ref = colLetter(ci + 1) + (ri + 1);
      if (typeof val === 'number' && isFinite(val)) x += `<c r="${ref}"><v>${val}</v></c>`;
      else x += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
}
function buildXlsx(sheets) {
  const enc = new TextEncoder(), files = [];
  const add = (name, str) => files.push({ name, data: enc.encode(str) });
  let ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
  sheets.forEach((s, i) => ct += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  add('[Content_Types].xml', ct + '</Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  let wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
  sheets.forEach((s, i) => wb += `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`);
  add('xl/workbook.xml', wb + '</sheets></workbook>');
  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  sheets.forEach((s, i) => rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  add('xl/_rels/workbook.xml.rels', rels + '</Relationships>');
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)));
  return zipStore(files);
}

const numH = ms => Math.round(msToH(ms) * 100) / 100; // horas en decimal (número), p. ej. 7.5

async function exportXLSX() {
  const recs = (await getAllRecords()).sort((a, b) => a.seq - b.seq);
  const workers = await getAllWorkers();
  const nombre = uid => (workers.find(w => w.uid === uid) || {}).nombre || uid;

  const resumen = [['Trabajador', 'Fecha', 'Entrada', 'Salida', 'Horas', 'Estado']];
  for (const w of workers) {
    let tot = 0;
    for (const d of computeDays(recs, w.uid, ruleFor(w))) { tot += d.worked; const c = dayCols(d); resumen.push([w.nombre, d.date, c.ent, c.sal, numH(d.worked), estadoTxt(d)]); }
    resumen.push([w.nombre, '', '', 'TOTAL', numH(tot), '']);
  }

  const semanas = [['Trabajador', 'Semana', 'Días', 'Horas', 'Previstas', 'Estado']];
  const meses = [['Trabajador', 'Mes', 'Días', 'Horas']];
  for (const w of workers) {
    const days = computeDays(recs, w.uid, ruleFor(w));
    const target = +w.horasSemana || 0;
    for (const g of groupTotals(days, 'semana')) semanas.push([w.nombre, g.label, g.dias, numH(g.worked), target || '', estadoSemana(g.worked, target)]);
    for (const g of groupTotals(days, 'mes')) meses.push([w.nombre, g.label, g.dias, numH(g.worked)]);
  }

  const detalle = [['Seq', 'Tipo', 'Trabajador', 'Marca', 'Fecha', 'Hora', 'Origen', 'Motivo', 'Hash', 'Hash anterior']];
  for (const r of recs) {
    if (r.type === 'fichaje') detalle.push([r.seq, 'fichaje', nombre(r.uid), r.tipo, dayKey(r.ts), hhmm(r.ts), 'kiosco', '', r.hash, r.prevHash]);
    else { const ts = r.tsCorregido != null ? r.tsCorregido : r.ts; detalle.push([r.seq, 'corrección', nombre(r.uid), r.tipoCorregido || '', dayKey(ts), hhmm(ts), 'admin', r.motivo || '', r.hash, r.prevHash]); }
  }

  const corr = [['Seq', 'Fecha', 'Hora', 'Trabajador', 'Acción', 'Motivo']];
  for (const r of recs.filter(r => r.type === 'correccion')) corr.push([r.seq, dayKey(r.ts), hhmm(r.ts), nombre(r.uid), describeCorr(r), r.motivo || '']);

  const bytes = buildXlsx([
    { name: 'Resumen', rows: resumen },
    { name: 'Semanas', rows: semanas },
    { name: 'Meses', rows: meses },
    { name: 'Detalle', rows: detalle },
    { name: 'Correcciones', rows: corr },
  ]);
  // Nombre único por hora: así descargar 2 veces el mismo día NO deja abierto el archivo viejo.
  const now = new Date();
  const stamp = `${dayKey(now.getTime())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const name = `fichajes_${stamp}.xlsx`;
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  download(name, mime, bytes);        // guardar SIEMPRE en Descargas (fiable en todos los móviles)
  lastExport = { name, mime, bytes }; // recordarlo para el botón "Enviar"
  return name;
}

async function exportPDF() {
  const recs = await getAllRecords();
  const workers = await getAllWorkers();
  const nombre = uid => (workers.find(w => w.uid === uid) || {}).nombre || uid;
  let html = `
    <div class="pdf-head">
      <h1>Registro de jornada · Vivero</h1>
      <p>Control horario — art. 34.9 del Estatuto de los Trabajadores<br>
      Generado el ${new Date().toLocaleString('es-ES')}</p>
    </div>`;
  const totalsTable = (title, arr, colName, targetH = 0) => arr.length ? `
      <div class="subt">${title}</div>
      <table><thead><tr><th>${colName}</th><th>Días</th><th>Horas</th>${targetH ? '<th>Previstas</th><th>Estado</th>' : ''}</tr></thead><tbody>
      ${arr.map(g => `<tr class="${g.inc ? 'inc' : ''}"><td>${g.label}</td><td>${g.dias}${g.inc ? ` (${g.inc} incompleto/s)` : ''}</td><td class="num">${fmtH(g.worked)}</td>${targetH ? `<td class="num">${targetH} h</td><td>${estadoSemana(g.worked, targetH)}</td>` : ''}</tr>`).join('')}
      </tbody></table>` : '';
  for (const w of workers) {
    const days = computeDays(recs, w.uid, ruleFor(w));
    let tot = 0, incompletos = 0, rows = '';
    for (const d of days) {
      tot += d.worked; if (d.incompleto) incompletos++;
      const c = dayCols(d);
      rows += `<tr class="${d.incompleto ? 'inc' : ''}"><td>${d.date}</td><td>${c.ent || '—'}</td><td>${c.sal || '—'}</td><td class="num">${fmtH(d.worked)}</td><td>${d.incompleto ? '⚠ Incompleto' : (d.descanso ? `OK · −${d.descanso / 60000}m comida` : 'OK')}</td></tr>`;
    }
    if (!rows) rows = '<tr><td colspan="5" class="muted">Sin fichajes</td></tr>';
    html += `
      <h2>${w.nombre}</h2>
      <table>
        <thead><tr><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Estado</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="tot"><td colspan="3">TOTAL${incompletos ? ` · ${incompletos} día(s) incompleto(s)` : ''}</td><td class="num">${fmtH(tot)}</td><td></td></tr></tfoot>
      </table>
      ${totalsTable('Totales por semana', groupTotals(days, 'semana'), 'Semana', +w.horasSemana || 0)}
      ${totalsTable('Totales por mes', groupTotals(days, 'mes'), 'Mes')}`;
  }
  const corr = recs.filter(r => r.type === 'correccion');
  if (corr.length) {
    html += '<h2>Correcciones del administrador</h2><table><thead><tr><th>Fecha</th><th>Trabajador</th><th>Acción</th><th>Motivo</th></tr></thead><tbody>';
    for (const r of corr)
      html += `<tr><td>${dayKey(r.ts)} ${hhmm(r.ts)}</td><td>${nombre(r.uid)}</td><td>${describeCorr(r)}</td><td>${r.motivo}</td></tr>`;
    html += '</tbody></table>';
  }
  html += '<p class="legend"><b>⚠</b> día incompleto: falta una entrada o una salida. &nbsp; <b>*</b> hora introducida o corregida por el administrador. &nbsp; Se restan 30 min de comida (salvo junio, julio y agosto) cuando solo se ficha entrada y salida.</p>';
  $('#printArea').innerHTML = html;
  window.print();
}
function panelExportar() {
  setPanel(`
    <h2>Exportar</h2>
    <p><b>Exportar Excel</b> guarda el archivo en <b>Descargas</b>. Después, con <b>Enviar</b>, lo mandas por WhatsApp o Gmail.</p>
    <p class="muted">El Excel trae una hoja por tabla: Resumen, Semanas, Meses, Detalle y Correcciones. Se abre bien en Excel y en Google Sheets.</p>
    <div class="row">
      <button id="expXlsx" class="btn primary">📥 Exportar Excel (.xlsx)</button>
      <button id="expSend" class="btn" disabled>📤 Enviar</button></div>
    <div class="row">
      <button id="expPdf" class="btn">Exportar PDF (imprimir → Guardar como PDF)</button></div>
    <div id="expMsg" class="msg"></div>
    <p class="muted" style="margin-top:14px">App ${APP_VERSION}</p>`);
  $('#expXlsx').onclick = async () => {
    try {
      const name = await exportXLSX();
      $('#expMsg').textContent = 'Guardado en Descargas ✓  ' + name;
      $('#expSend').disabled = false;
    } catch (e) { $('#expMsg').textContent = 'Error al generar: ' + e.message; }
  };
  $('#expSend').onclick = async () => { $('#expMsg').textContent = await shareLast(); };
  $('#expPdf').onclick = exportPDF;
}

/* --- Integridad --- */
function panelIntegridad() {
  setPanel(`
    <h2>Verificar integridad</h2>
    <p>Comprueba que ningún fichaje se haya manipulado.</p>
    <button id="intVer" class="btn primary">Verificar cadena</button>
    <div id="intMsg" class="msg big"></div>`);
  $('#intVer').onclick = async () => {
    const r = await verifyChain();
    $('#intMsg').innerHTML = r.ok
      ? `✅ Cadena intacta (${r.count} registros)`
      : `❌ MANIPULACIÓN detectada en el registro #${r.seq}: ${r.reason}`;
  };
}

/* --- Ajustes: modo del móvil + cambiar PIN + borrar datos --- */
async function panelPin() {
  const ws = await getAllWorkers();
  const cfg = (await metaGet('config')) || { modo: 'kiosco' };
  setPanel(`
    <h2>Ajustes</h2>
    <h3>Modo de este móvil</h3>
    <p class="muted"><b>Kiosco</b> = tarjeta NFC compartida (varios trabajadores). <b>Personal</b> = un solo
    trabajador ficha con un botón grande, sin tarjeta (para su propio móvil).</p>
    <div class="row">
      <select id="modoSel">
        <option value="kiosco">Kiosco (NFC compartido)</option>
        <option value="personal">Personal (un trabajador)</option>
      </select>
      ${workerSelect('modoWorker', ws, cfg.personalUid)}
      <button id="modoSave" class="btn primary">Guardar modo</button>
    </div>
    <div id="modoMsg" class="msg"></div>
    <hr style="margin:22px 0;border:none;border-top:1px solid #ddd">
    <h3>Cambiar PIN</h3>
    <p>PIN nuevo (mínimo 4 dígitos):</p>
    <input id="pinNew" type="password" inputmode="numeric" placeholder="PIN nuevo">
    <input id="pinNew2" type="password" inputmode="numeric" placeholder="Repite el PIN">
    <button id="pinSave" class="btn primary">Guardar PIN</button>
    <div id="pinMsg" class="msg"></div>
    <hr style="margin:22px 0;border:none;border-top:1px solid #ddd">
    <h3>Borrar todos los datos</h3>
    <p class="muted">Borra <b>todos los fichajes y todas las tarjetas</b>. Úsalo solo para empezar de cero
    (por ejemplo, antes de usar las tarjetas reales). <b>No se puede deshacer.</b> Si tienes fichajes que
    quieras guardar, expórtalos antes en <b>Exportar</b>.</p>
    <button id="resetBtn" class="btn" style="background:#c62828">🗑 Borrar todos los datos</button>
    <div id="resetMsg" class="msg"></div>`);
  // Modo del móvil
  $('#modoSel').value = cfg.modo || 'kiosco';
  const syncModoUI = () => { $('#modoWorker').style.display = $('#modoSel').value === 'personal' ? '' : 'none'; };
  syncModoUI();
  $('#modoSel').onchange = syncModoUI;
  $('#modoSave').onclick = async () => {
    const modo = $('#modoSel').value;
    if (modo === 'personal' && !$('#modoWorker').value) return $('#modoMsg').textContent = 'Elige el trabajador primero (dalo de alta en “Alta tarjeta”).';
    await metaPut({ id: 'config', modo, personalUid: modo === 'personal' ? $('#modoWorker').value : null });
    $('#modoMsg').textContent = 'Modo guardado ✓ (se aplica al pulsar “Salir”).';
  };
  $('#pinSave').onclick = async () => {
    const a = $('#pinNew').value, b = $('#pinNew2').value;
    if (a.length < 4) return $('#pinMsg').textContent = 'Mínimo 4 dígitos';
    if (a !== b) return $('#pinMsg').textContent = 'No coinciden';
    await metaPut({ id: 'pin', hash: await pinHash(a) });
    $('#pinMsg').textContent = 'PIN cambiado ✓';
  };
  $('#resetBtn').onclick = async () => {
    const pin = prompt('Para BORRAR todos los datos, introduce el PIN de administrador:');
    if (pin === null) return;
    if (!(await checkPin(pin))) return $('#resetMsg').textContent = 'PIN incorrecto. No se borró nada.';
    await resetAllData();
    $('#resetMsg').textContent = 'Datos borrados. Todo a cero ✓';
  };
}
// Borra fichajes + tarjetas y reinicia la cadena. Conserva el PIN.
async function resetAllData() {
  await new Promise((res, rej) => {
    const t = db.transaction(['records', 'workers', 'meta'], 'readwrite');
    t.oncomplete = res; t.onerror = () => rej(t.error);
    t.objectStore('records').clear();
    t.objectStore('workers').clear();
    t.objectStore('meta').delete('chain');
  });
  lastRead = { uid: null, at: 0 };
}

/* ============================ Arranque ============================ */
(async () => {
  db = await dbp;
  // Pide al navegador que NO borre los datos por falta de espacio (almacenamiento persistente).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  startClock();
  $('#kiosk').addEventListener('click', e => { if (e.target.id !== 'gear' && !nfcReader) startNFC(); });
  $('#gear').addEventListener('click', e => { e.stopPropagation(); openAdminLogin(); });
  $('#gear2').addEventListener('click', e => { e.stopPropagation(); openAdminLogin(); });

  // Pinpad
  document.querySelectorAll('.pinpad [data-d]').forEach(b => b.onclick = () => { if (pinBuf.length < 8) { pinBuf += b.dataset.d; drawPin(); } });
  $('#pinDel').onclick = () => { pinBuf = pinBuf.slice(0, -1); drawPin(); };
  $('#pinCancel').onclick = () => applyMode();
  $('#pinOk').onclick = () => pinCb && pinCb(pinBuf);

  // Menú admin
  $('#navAlta').onclick = panelAlta;
  $('#navCorr').onclick = () => panelCorreccion();
  $('#navHoras').onclick = panelHoras;
  $('#navIncompletos').onclick = panelIncompletos;
  $('#navConsulta').onclick = panelConsulta;
  $('#navExport').onclick = panelExportar;
  $('#navInteg').onclick = panelIntegridad;
  $('#navPin').onclick = panelPin;
  $('#navSalir').onclick = exitAdmin;

  await applyMode();  // muestra kiosco (con NFC) o modo personal, según config
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

/* ---- Autocomprobación de la cadena (corre en consola al cargar) ---- */
async function selfTest() {
  let recs = [], prev = 'GENESIS', seq = 0;
  for (const f of [{ type: 'fichaje', uid: 'a', tipo: 'entrada', ts: 1000 }, { type: 'fichaje', uid: 'a', tipo: 'salida', ts: 2000 }]) {
    const r = await buildRecord(f, prev, ++seq); recs.push(r); prev = r.hash;
  }
  const good = await verifyRecords(recs);
  const bad = await verifyRecords(recs.map((r, i) => i === 0 ? { ...r, ts: 9999 } : r));
  console.log('[selfTest]', good.ok && !bad.ok ? 'OK' : 'FALLO', good, bad);
}
window.__selfTest = selfTest;
selfTest();
