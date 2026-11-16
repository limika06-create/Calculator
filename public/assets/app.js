(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const fmt = (v, d = 3) => v === null || v === undefined || !isFinite(v) ? '' : String(+(+v).toFixed(d)).replace('.', ',');
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const isEgg = s => /яйц|яйко|яйцо/i.test(s || '');
const clone = x => JSON.parse(JSON.stringify(x));
const shortName = p => String(p || '').split(' · ')[0];

let BASE = null, PROD = {}, PRODLIST = [], BYCODE = {}, DISHES = [];
let edits = {}, drafts = {}, openNotes = new Set();
let current = null, filter = 'all', ME = { name: '' }, online = true;

// ---------- utils ----------
function toast(t, ms = 2800) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
function setSync(state, text) { $('#syncDot').className = 'dot ' + state; $('#syncText').textContent = text; }
function confirmBox(title, text, okText = 'Да', cancelText = 'Отмена') {
  return new Promise(res => {
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="dialog" role="dialog" aria-modal="true"><h4>${esc(title)}</h4><div class="muted">${esc(text)}</div><div class="acts"><button class="btn" data-a="0">${esc(cancelText)}</button><button class="btn primary" data-a="1">${esc(okText)}</button></div></div>`;
    o.onclick = e => { const a = e.target.dataset.a; if (a !== undefined || e.target === o) { o.remove(); res(a === '1'); } };
    document.body.appendChild(o); $('[data-a="1"]', o).focus();
  });
}
async function api(path, opt = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opt });
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const j = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) { const e = new Error(j?.error || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
  return j;
}
const draftKey = code => 'mz-draft-' + code;
function persistDraft(code) { try { if (drafts[code]) localStorage.setItem(draftKey(code), JSON.stringify({ d: drafts[code], baseAt: (edits[code] || {}).at || 0 })); else localStorage.removeItem(draftKey(code)); } catch (e) {} }

// ---------- model ----------
function effective(code) {
  if (drafts[code]) return drafts[code];
  const b = BYCODE[code], e = edits[code];
  return e ? { ...b, ...e } : b;
}
function getDraft(code = current) { if (!drafts[code]) drafts[code] = clone(effective(code)); return drafts[code]; }
function prodOf(r) { return PROD[r.p] || null; }
function unitOf(r) { const p = prodOf(r); return p ? p.u : (r.u || 'г'); }
function sumNet(ing) { let s = 0; for (const r of ing) { const n = num(r.nt) || 0, u = unitOf(r); if (u === 'г' || u === 'мл') s += n; else if (u === 'шт' && isEgg(r.p)) s += n * 60; } return s; }
function fitState(c) { const o = num(c.out) || 0, s = sumNet(c.ing); if (!o || !s) return { s, o, dev: null, st: 'warn' }; const dev = s / o - 1; return { s, o, dev, st: Math.abs(dev) <= 0.02 ? 'ok' : Math.abs(dev) <= 0.1 ? 'warn' : 'bad' }; }
function needsCheck(code) {
  const b = BYCODE[code], c = effective(code);
  if (edits[code] && !drafts[code]) return c.ing.some(r => !prodOf(r) && r.p);
  return !!((b.iss && b.iss.length) || /Сильное|не увеличивал|проверить/i.test(b.fix || '') || c.ing.some(r => /Большое изменение/i.test(r.note || '') || (r.p && !prodOf(r))));
}
function rowKind(r) {
  const n = r.note || '';
  if (/Нет в ТТК|не пересчитано/i.test(n)) return 'miss';
  if (/^Добавлено/.test(n)) return 'add';
  if (/→ стало|Брутто было|Приведено к выходу/.test(n)) return 'chg';
  return '';
}
const KIND_LABEL = { chg: ['изменено', 'warn'], add: ['добавлено', 'good'], miss: ['нет в ТТК', 'bad'], '': ['примечание', 'mut'] };

// ---------- product combobox ----------
const dd = document.createElement('div'); dd.className = 'dd'; dd.hidden = true; dd.setAttribute('role', 'listbox'); document.body.appendChild(dd);
let ddState = null;
function searchList(list, q, key) {
  const t = norm(q).split(/\s+/).filter(Boolean);
  if (!t.length) return list.slice(0, 60);
  const out = [];
  for (const it of list) { const h = it._s || (it._s = norm(key(it))); if (t.every(x => h.includes(x))) { out.push(it); if (out.length >= 80) break; } }
  const f = t[0]; out.sort((a, b) => (a._s.startsWith(f) ? 0 : 1) - (b._s.startsWith(f) ? 0 : 1));
  return out;
}
function hl(text, q) { let s = esc(text); norm(q).split(/\s+/).filter(x => x.length > 1).forEach(t => { const i = norm(s).indexOf(t); if (i >= 0) s = s.slice(0, i) + '<mark>' + s.slice(i, i + t.length) + '</mark>' + s.slice(i + t.length); }); return s; }
function attachCombo(input, { list, key, label, sub, onPick }) {
  const open = () => {
    const items = searchList(list(), input.value === input.dataset.picked ? '' : input.value, key);
    ddState = { input, items, idx: 0, onPick };
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.width = Math.max(r.width, 320) + 'px';
    const below = innerHeight - r.bottom;
    if (below < 220 && r.top > below) { dd.style.top = ''; dd.style.bottom = (innerHeight - r.top + 4) + 'px'; } else { dd.style.bottom = ''; dd.style.top = (r.bottom + 4) + 'px'; }
    dd.innerHTML = items.length ? items.map((it, i) => `<div class="opt" role="option" data-i="${i}" aria-selected="${i === 0}"><span>${hl(label(it), input.value)}</span><small>${esc(sub(it))}</small></div>`).join('') : '<div class="none">Ничего не найдено. Попробуйте часть слова или код (например, DAIR).</div>';
    dd.hidden = false;
  };
  const pick = i => { const it = ddState && ddState.items[i]; if (!it) return; dd.hidden = true; input.dataset.picked = label(it); onPick(it); };
  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('input', open);
  input.addEventListener('keydown', e => {
    if (dd.hidden || !ddState || ddState.input !== input) return;
    const n = ddState.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ddState.idx = (ddState.idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; [...dd.children].forEach((c, i) => c.setAttribute('aria-selected', i === ddState.idx)); dd.children[ddState.idx]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(ddState.idx); }
    else if (e.key === 'Escape') { dd.hidden = true; }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (ddState && ddState.input === input) dd.hidden = true; }, 160));
  input._pick = pick;
}
dd.addEventListener('mousedown', e => { const o = e.target.closest('.opt'); if (o && ddState) { e.preventDefault(); ddState.input._pick(+o.dataset.i); } });
addEventListener('scroll', () => { if (!dd.hidden && ddState) { const r = ddState.input.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) dd.hidden = true; else if (dd.style.top) dd.style.top = (r.bottom + 4) + 'px'; } }, true);
const prodCombo = (input, onPick) => attachCombo(input, { list: () => PRODLIST, key: p => p.d, label: p => p.d.split(' · ')[0], sub: p => `${p.code || 'без кода'} · ${p.u}`, onPick });

// ---------- list ----------
function renderCounts() {
  let all = 0, bad = 0, chk = 0, ed = 0;
  for (const c of BASE.cards) { all++; if (fitState(effective(c.code)).st === 'bad') bad++; if (needsCheck(c.code)) chk++; if (edits[c.code]) ed++; }
  $('#nAll').textContent = all; $('#nBad').textContent = bad; $('#nCheck').textContent = chk; $('#nEdited').textContent = ed;
}
function renderList() {
  const q = norm($('#q').value.trim()), cat = $('#cat').value;
  const L = $('#list'); L.innerHTML = '';
  let lastCat = null, shown = 0;
  for (const b of BASE.cards) {
    const c = effective(b.code), f = fitState(c);
    if (cat && c.cat !== cat) continue;
    if (q && !q.split(/\s+/).every(t => norm(c.name + ' ' + b.code).includes(t))) continue;
    if (filter === 'bad' && f.st !== 'bad') continue;
    if (filter === 'check' && !needsCheck(b.code)) continue;
    if (filter === 'edited' && !edits[b.code]) continue;
    if (!cat && c.cat !== lastCat) { lastCat = c.cat; const g = document.createElement('div'); g.className = 'grp'; g.textContent = c.cat || 'Без категории'; L.appendChild(g); }
    const el = document.createElement('div');
    el.className = 'item s-' + f.st; el.tabIndex = 0; el.setAttribute('role', 'button');
    if (b.code === current) el.setAttribute('aria-current', 'true');
    let pill = '';
    if (drafts[b.code]) pill = '<span class="pill acc">не сохранено</span>';
    else if (f.dev !== null && Math.abs(f.dev) > 0.02) pill = `<span class="pill ${f.st === 'bad' ? 'bad' : 'warn'}">${f.dev > 0 ? '+' : ''}${Math.round(f.dev * 100)}%</span>`;
    else if (edits[b.code]) pill = '<span class="pill good">изменено</span>';
    else if (needsCheck(b.code)) pill = '<span class="pill warn">проверить</span>';
    el.innerHTML = `<span class="bar"></span><span><div class="n">${esc(c.name)}</div><div class="meta">${fmt(num(c.out), 1)} ${esc(c.ou)} · ${c.ing.length} прод.${edits[b.code] ? ' · ' + esc(edits[b.code].by) : ''}</div></span><span>${pill}</span>`;
    el.onclick = () => openCard(b.code);
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(b.code); } };
    L.appendChild(el); shown++;
  }
  if (!shown) L.innerHTML = '<div class="empty">Ничего не найдено</div>';
  renderCounts();
}

// ---------- editor ----------
function openCard(code) {
  current = code; openNotes = new Set();
  try { const s = JSON.parse(localStorage.getItem(draftKey(code)) || 'null'); if (s && !drafts[code]) { drafts[code] = s.d; toast('Восстановлены ваши несохранённые правки этой карты'); } } catch (e) {}
  renderEditor(); renderList();
  history.replaceState(null, '', '#' + code);
  if (innerWidth < 980) $('#editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function touched() { persistDraft(current); renderMeter(); renderSavebar(); renderList(); }

function renderEditor() {
  const E = $('#editor');
  if (!current) { E.innerHTML = '<div class="empty">Выберите блюдо слева</div>'; return; }
  const c = effective(current), e = edits[current];
  const cats = [...new Set(BASE.cards.map(x => x.cat).filter(Boolean))].sort();
  E.innerHTML = `<div class="ed">
    <div id="conflict"></div>
    <div class="edHead">
      <div><h2>${esc(c.name)}</h2><div class="sub">${esc(c.code)}${c.alt ? ' · ' + esc(c.alt) : ''}</div>
        <div class="sub">${e ? `Сохранено: ${esc(e.by)}, ${new Date(e.at).toLocaleString('ru-RU')}` : 'Исходная версия (после сверки с Word-ТТК)'}</div></div>
      <div class="edActions">
        <button class="btn sm" id="toCalc">Калькулятор</button>
        <button class="btn sm" id="print">Печать</button>
        <button class="btn sm" id="copy">Копировать</button>
      </div>
    </div>
    <div class="fields">
      <label class="fld">Выход 1 порции<span class="unitIn"><input id="eOut" inputmode="decimal" value="${fmt(num(c.out), 2)}"><select id="eOu">${['г', 'мл', 'шт'].map(u => `<option${u === c.ou ? ' selected' : ''}>${u}</option>`).join('')}</select></span></label>
      <label class="fld" style="grid-column:span 2">Категория<select id="eCat">${cats.map(x => `<option${x === c.cat ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label class="fld">Халяль<select id="eHalal"><option value="0"${c.halal ? '' : ' selected'}>нет</option><option value="1"${c.halal ? ' selected' : ''}>да</option></select></label>
    </div>
    <div class="meter" id="meter"></div>
    <div class="ingHead"><span>№</span><span>Продукт</span><span class="r">Брутто</span><span class="r">Нетто</span><span class="r">Потери</span><span>Статус</span><span></span></div>
    <div class="ingList" id="ing"></div>
    <div class="addRow"><button class="btn sm" id="addRow">+ Добавить продукт</button></div>
    <h3 class="sec">Технология приготовления</h3>
    <div class="steps" id="steps"></div>
    <div class="addRow"><button class="btn sm" id="addStep">+ Шаг</button></div>
    <div id="extra"></div>
    <div class="savebar" id="savebar"></div>
  </div>`;
  $('#eOut').oninput = ev => { getDraft().out = num(ev.target.value); touched(); };
  $('#eOu').onchange = ev => { getDraft().ou = ev.target.value; touched(); };
  $('#eCat').onchange = ev => { getDraft().cat = ev.target.value; touched(); };
  $('#eHalal').onchange = ev => { getDraft().halal = ev.target.value === '1'; touched(); };
  $('#addRow').onclick = () => { const d = getDraft(); d.ing.push({ p: '', code: '', u: 'г', br: null, nt: null, note: 'Добавлено вручную.' }); renderIng(); touched(); const ins = $('#ing').querySelectorAll('.cb input'); ins[ins.length - 1]?.focus(); };
  $('#addStep').onclick = () => { getDraft().steps.push(''); renderSteps(); touched(); const t = $('#steps').querySelectorAll('textarea'); t[t.length - 1]?.focus(); };
  $('#toCalc').onclick = () => { setCalcDish(current); showTab('calc'); };
  $('#print').onclick = printCard;
  $('#copy').onclick = copyCard;
  renderMeter(); renderIng(); renderSteps(); renderExtra(); renderSavebar();
}

function renderMeter() {
  const M = $('#meter'); if (!M) return;
  const c = effective(current), f = fitState(c);
  const pct = f.o ? Math.min(f.s / f.o, 1.5) / 1.5 * 100 : 0, goal = 100 / 1.5;
  const verdict = f.dev === null ? 'нет данных' : f.st === 'ok' ? 'сходится' : f.dev > 0 ? `больше выхода на ${fmt(f.dev * 100, 1)}%` : `меньше выхода на ${fmt(-f.dev * 100, 1)}%`;
  M.className = 'meter ' + f.st;
  M.innerHTML = `<div class="txt">Сумма нетто <b>${fmt(f.s, 1)} г</b> из выхода <b>${fmt(f.o, 1)} ${esc(c.ou)}</b> · <span class="verdict">${verdict}</span></div>
    <button class="btn sm" id="fitBtn" ${f.dev === null || Math.abs(f.dev) <= 0.005 ? 'disabled' : ''}>Подогнать нетто под выход</button>
    <div class="track"><div class="fill" style="width:${pct}%"></div><div class="goal" style="left:${goal}%"></div></div>`;
  $('#fitBtn').onclick = fitToOutput;
}
async function fitToOutput() {
  const d = getDraft(), s = sumNet(d.ing), o = num(d.out); if (!s || !o) return;
  const k = o / s;
  if (k > 1.15 && !(await confirmBox('Увеличить все продукты?', `Нетто вырастет в ${fmt(k, 2)} раза. Для круп и макарон это обычно неверно: при варке они набирают вес. Всё равно увеличить?`, 'Увеличить'))) return;
  d.ing.forEach(r => { const ob = num(r.br), on = num(r.nt); r.br = ob === null ? ob : +(ob * k).toFixed(3); r.nt = on === null ? on : +(on * k).toFixed(3); r.note = ((r.note || '') + ` Приведено к выходу ×${fmt(k, 3)} (${ME.name}): было ${fmt(ob)} / ${fmt(on)} → стало ${fmt(r.br)} / ${fmt(r.nt)}.`).trim(); });
  renderIng(); touched(); toast('Все продукты изменены одинаково ×' + fmt(k, 3));
}

function renderIng() {
  const c = effective(current), L = $('#ing'); L.innerHTML = '';
  c.ing.forEach((r, i) => {
    const p = prodOf(r), u = unitOf(r), br = num(r.br), nt = num(r.nt);
    const loss = br && nt !== null ? (1 - nt / br) * 100 : null;
    const kind = rowKind(r), [lab, cls] = KIND_LABEL[kind];
    const row = document.createElement('div');
    row.className = 'ing ' + kind;
    row.innerHTML = `<span class="no">${i + 1}</span>
      <div class="cb${r.p && !p ? ' unknown' : ''}"><input value="${esc(shortName(r.p))}" placeholder="Найти продукт…" aria-label="Продукт ${i + 1}" autocomplete="off"><div class="codeLine">${p ? esc(p.code || 'без кода') + ' · ' + esc(p.cat || '') : r.p ? 'нет в справочнике — выберите продукт из списка' : 'выберите продукт'}</div></div>
      <div class="uSuf"><input class="v br" inputmode="decimal" value="${fmt(br)}" aria-label="Брутто ${i + 1}"><span>${esc(u)}</span></div>
      <div class="uSuf"><input class="v nt" inputmode="decimal" value="${fmt(nt)}" aria-label="Нетто ${i + 1}"><span>${esc(u)}</span></div>
      <span class="loss${loss !== null && loss < -0.01 ? ' neg' : ''}">${loss === null ? '' : loss < -0.01 ? 'нетто > брутто' : fmt(loss, 1) + '%'}</span>
      <button class="stat" title="Показать примечание"><span class="pill ${r.note ? cls : 'mut'}">${r.note ? lab : '+ примечание'}</span></button>
      <button class="del" title="Удалить продукт" aria-label="Удалить продукт ${i + 1}">×</button>
      <div class="noteRow" ${openNotes.has(i) ? '' : 'hidden'}><textarea aria-label="Примечание ${i + 1}" placeholder="Примечание">${esc(r.note)}</textarea></div>`;
    prodCombo($('.cb input', row), it => { const d = getDraft(); d.ing[i].p = it.d; d.ing[i].code = it.code; d.ing[i].u = it.u; renderIng(); touched(); $('#ing').children[i]?.querySelector('.br')?.focus(); });
    const bi = $('.br', row), ni = $('.nt', row);
    bi.oninput = ev => { getDraft().ing[i].br = num(ev.target.value); touched(); };
    ni.oninput = ev => { getDraft().ing[i].nt = num(ev.target.value); touched(); };
    [bi, ni].forEach(x => { x.onblur = () => updateLoss(row, i); x.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); const nxt = x === bi ? ni : $('#ing').children[i + 1]?.querySelector('.br'); (nxt || $('#addRow')).focus(); } }; });
    $('.stat', row).onclick = () => { const n = $('.noteRow', row); n.hidden = !n.hidden; n.hidden ? openNotes.delete(i) : openNotes.add(i); if (!n.hidden) $('textarea', n).focus(); };
    $('.noteRow textarea', row).oninput = ev => { getDraft().ing[i].note = ev.target.value; touched(); };
    $('.del', row).onclick = async () => { if (!(await confirmBox('Удалить продукт?', shortName(r.p) || 'Пустая строка', 'Удалить'))) return; getDraft().ing.splice(i, 1); openNotes = new Set(); renderIng(); touched(); };
    L.appendChild(row);
  });
  if (!c.ing.length) L.innerHTML = '<div class="empty">В карте нет продуктов</div>';
}
function updateLoss(row, i) {
  const r = effective(current).ing[i], br = num(r.br), nt = num(r.nt), el = $('.loss', row);
  const loss = br && nt !== null ? (1 - nt / br) * 100 : null;
  el.className = 'loss' + (loss !== null && loss < -0.01 ? ' neg' : '');
  el.textContent = loss === null ? '' : loss < -0.01 ? 'нетто > брутто' : fmt(loss, 1) + '%';
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }
function renderSteps() {
  const c = effective(current), S = $('#steps'); S.innerHTML = '';
  c.steps.forEach((t, i) => {
    const el = document.createElement('div'); el.className = 'step';
    el.innerHTML = `<span class="k">${i + 1}</span><textarea aria-label="Шаг ${i + 1}">${esc(t)}</textarea><button class="del" title="Удалить шаг" aria-label="Удалить шаг ${i + 1}">×</button>`;
    const ta = $('textarea', el); setTimeout(() => autoGrow(ta));
    ta.oninput = ev => { autoGrow(ta); getDraft().steps[i] = ev.target.value; touched(); };
    $('.del', el).onclick = () => { getDraft().steps.splice(i, 1); renderSteps(); touched(); };
    S.appendChild(el);
  });
  if (!c.steps.length) S.innerHTML = '<div class="muted small">Технология не заполнена — нажмите «+ Шаг».</div>';
}
function renderExtra() {
  const b = BYCODE[current], e = edits[current], X = $('#extra'); let h = '';
  const notes = [];
  if (b.fix) notes.push(`<div class="nt warn"><b>Приведение к выходу порции</b>${esc(b.fix)}</div>`);
  if (b.outnote) notes.push(`<div class="nt warn"><b>Выход</b>${esc(b.outnote)}</div>`);
  if (b.ttk) notes.push(`<div class="nt acc"><b>Сверка с Word-ТТК${b.conf ? ' · достоверность: ' + esc(b.conf) : ''}</b>${esc(b.ttk)}</div>`);
  if (b.iss && b.iss.length) notes.push(`<div class="nt bad"><b>Замечания</b>${b.iss.map(esc).join('<br>')}</div>`);
  if (b.um && b.um.length) notes.push(`<div class="nt warn"><b>Из ТТК не внесено — нет продукта в справочнике</b>${b.um.map(esc).join('<br>')}</div>`);
  if (notes.length) h += `<details class="box"${b.iss && b.iss.length ? ' open' : ''}><summary>Что меняли при проверке (${notes.length})</summary><div class="in">${notes.join('')}</div></details>`;
  const log = (e && e.log) || [];
  h += `<details class="box"><summary>История правок (${log.length})</summary><div class="in log">${log.length ? log.slice().reverse().map(x => `<div><span>${new Date(x.at).toLocaleString('ru-RU')} · ${esc(x.by)}</span>${esc(x.what || 'изменения')}</div>`).join('') : '<span class="muted">Карту ещё никто не менял на сайте.</span>'}</div></details>`;
  X.innerHTML = h;
}
function diffSummary(code) {
  const a = effective(code), b = edits[code] ? { ...BYCODE[code], ...edits[code] } : BYCODE[code], out = [];
  if (num(a.out) !== num(b.out)) out.push(`выход ${fmt(num(b.out))} → ${fmt(num(a.out))}`);
  if (a.cat !== b.cat) out.push('категория');
  const bm = {}; b.ing.forEach(r => bm[r.p] = r);
  a.ing.forEach(r => { const o = bm[r.p]; if (!o) out.push('+ ' + shortName(r.p)); else if (num(o.br) !== num(r.br) || num(o.nt) !== num(r.nt)) out.push(`${shortName(r.p)} ${fmt(num(o.nt))}→${fmt(num(r.nt))}`); delete bm[r.p]; });
  Object.keys(bm).forEach(p => out.push('− ' + shortName(p)));
  if (JSON.stringify(a.steps) !== JSON.stringify(b.steps)) out.push('технология');
  return out;
}
function renderSavebar() {
  const S = $('#savebar'); if (!S) return;
  const dirty = !!drafts[current], ch = dirty ? diffSummary(current) : [];
  S.className = 'savebar' + (dirty ? ' dirty' : '');
  S.innerHTML = `<button class="btn primary" id="save" ${dirty ? '' : 'disabled'}>Сохранить</button>
    <button class="btn" id="undo" ${dirty ? '' : 'disabled'}>Отменить правки</button>
    <span class="msg">${dirty ? (ch.length ? 'Изменено: ' + esc(ch.slice(0, 5).join('; ')) + (ch.length > 5 ? ` и ещё ${ch.length - 5}` : '') : 'Есть правки в примечаниях') + ' · <kbd>Ctrl</kbd>+<kbd>S</kbd>' : 'Правок нет — все видят эту версию.'}</span>
    <button class="btn ghost sm" id="reset" ${edits[current] ? '' : 'disabled'} title="Убрать все сохранённые на сайте правки этой карты">Вернуть исходную</button>`;
  $('#save').onclick = () => save();
  $('#undo').onclick = () => { delete drafts[current]; persistDraft(current); renderEditor(); renderList(); };
  $('#reset').onclick = async () => {
    if (!(await confirmBox('Вернуть исходную карту?', 'Все сохранённые на сайте правки этой карты будут удалены для всех.', 'Вернуть'))) return;
    try { await api('/api/cards/' + encodeURIComponent(current), { method: 'DELETE' }); delete edits[current]; delete drafts[current]; persistDraft(current); renderEditor(); renderList(); toast('Карта возвращена к исходной'); } catch (e) { toast('Не получилось: ' + e.message); }
  };
}
async function save(force = false) {
  const code = current, d = drafts[code]; if (!d) return;
  const what = diffSummary(code).slice(0, 15).join('; ');
  const doc = { cat: d.cat, out: num(d.out), ou: d.ou, halal: !!d.halal, steps: d.steps.filter(s => s.trim()), what,
    ing: d.ing.filter(r => r.p || num(r.br) !== null || num(r.nt) !== null).map(r => ({ p: r.p, code: (prodOf(r) || {}).code || r.code || '', u: unitOf(r), br: num(r.br), nt: num(r.nt), note: r.note || '' })) };
  const btn = $('#save'); if (btn) btn.disabled = true;
  try {
    const saved = await api('/api/cards/' + encodeURIComponent(code), { method: 'PUT', body: JSON.stringify({ doc, prevAt: (edits[code] || {}).at || 0, force }) });
    edits[code] = saved; delete drafts[code]; persistDraft(code);
    if (current === code) renderEditor(); renderList(); toast('Сохранено — изменения видны всем');
  } catch (e) {
    if (e.status === 409) {
      const cur = e.body && e.body.current;
      $('#conflict').innerHTML = `<div class="banner">Пока вы правили, карту сохранил(а) ${esc(cur ? cur.by : 'другой сотрудник')}${cur ? ' в ' + new Date(cur.at).toLocaleTimeString('ru-RU') : ''}. <button class="btn sm" id="cfMine">Сохранить мою версию поверх</button><button class="btn sm" id="cfTheirs">Показать их версию (мои правки пропадут)</button></div>`;
      $('#cfMine').onclick = () => { if (cur) edits[code] = cur; else delete edits[code]; save(true); };
      $('#cfTheirs').onclick = () => { if (cur) edits[code] = cur; else delete edits[code]; delete drafts[code]; persistDraft(code); renderEditor(); renderList(); };
    } else toast('Не сохранилось: ' + e.message + '. Правки остались на этом устройстве — попробуйте ещё раз.', 4500);
    renderSavebar();
  }
}
function copyCard() {
  const c = effective(current);
  const t = [`${c.name} — выход ${fmt(num(c.out))} ${c.ou}`, 'Продукт\tКод\tЕд.\tБрутто\tНетто', ...c.ing.map(r => [shortName(r.p), (prodOf(r) || {}).code || r.code, unitOf(r), fmt(num(r.br)), fmt(num(r.nt))].join('\t'))].join('\n');
  navigator.clipboard.writeText(t).then(() => toast('Скопировано — можно вставить в Excel'), () => toast('Браузер не дал скопировать'));
}
function printCard() {
  const c = effective(current);
  $('#printCard').innerHTML = `<div class="top2"><div>Предприятие: ____________________</div><div><b>УТВЕРЖДАЮ</b><br>__________ / __________<br>«___» ________ 20__ г.</div></div>
    <div class="t" style="margin-top:6mm">ТЕХНОЛОГИЧЕСКАЯ КАРТА</div><h1>${esc(c.name)}</h1>
    <div>Категория: ${esc(c.cat)} · Код: ${esc(c.code)} · Выход порции: <b>${fmt(num(c.out), 1)} ${esc(c.ou)}</b> · Халяль: ${c.halal ? 'да' : 'нет'}</div>
    <table><thead><tr><th>№</th><th>Продукт</th><th>Ед.</th><th class="r">Брутто</th><th class="r">Нетто</th></tr></thead><tbody>${c.ing.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(shortName(r.p))}</td><td>${esc(unitOf(r))}</td><td class="r">${fmt(num(r.br))}</td><td class="r">${fmt(num(r.nt))}</td></tr>`).join('')}<tr><td></td><td><b>Выход</b></td><td>${esc(c.ou)}</td><td></td><td class="r"><b>${fmt(num(c.out), 1)}</b></td></tr></tbody></table>
    <b>Технология приготовления</b><ol>${c.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="sig"><div>Разработал (шеф-повар): ____________</div><div>Дата: «___» ________ 20__ г.</div></div>`;
  print();
}

// ---------- calculator ----------
const calc = { code: null, rows: [] };
function cTotal() { return (num($('#cN').value) || 0) * (num($('#cK').value) || 0); }
const big = u => u === 'г' ? 'кг' : u === 'мл' ? 'л' : u;
const toBase = (v, u) => v === null ? null : (u === 'кг' || u === 'л') ? v * 1000 : v;
const baseU = u => u === 'кг' ? 'г' : u === 'л' ? 'мл' : u;
function setCalcDish(code) { calc.code = code; const c = effective(code); $('#cDish').value = c.name; $('#cDish').dataset.picked = c.name; $('#cDishInfo').textContent = `Карта: выход ${fmt(num(c.out), 1)} ${c.ou}, ${c.ing.length} продуктов · ${c.code}`; renderCalc(); }
function renderCalc() {
  const T = cTotal(), n = num($('#cN').value) || 0, w = num($('#cW').value);
  $('#cTot').textContent = fmt(T, 1) || '0';
  const port = w && T ? w * 1000 * n / T : null;
  $('#cPort').textContent = port ? fmt(port, 1) + ' г' : '—';
  const R = $('#cRows'); R.innerHTML = '';
  let sum = 0;
  calc.rows.forEach((r, i) => {
    const tot = toBase(num(r.q), r.u), lp = num(r.loss) || 0;
    const br = tot !== null && T ? tot / T : null, nt = br !== null ? br * (1 - lp / 100) : null, uu = baseU(r.u);
    if (nt !== null) { if (uu === 'г' || uu === 'мл') sum += nt; else if (uu === 'шт' && isEgg(r.p)) sum += nt * 60; }
    const row = document.createElement('div'); row.className = 'calcRow';
    row.innerHTML = `<div class="cb${r.p && !PROD[r.p] ? ' unknown' : ''}"><input value="${esc(shortName(r.p))}" placeholder="Найти продукт…" autocomplete="off" aria-label="Продукт ${i + 1}"></div>
      <input class="v q" inputmode="decimal" value="${esc(r.q ?? '')}" aria-label="Всего ${i + 1}">
      <select class="u" aria-label="Единица ${i + 1}">${['кг', 'г', 'л', 'мл', 'шт'].map(u => `<option${u === r.u ? ' selected' : ''}>${u}</option>`).join('')}</select>
      <input class="v l" inputmode="decimal" value="${esc(r.loss ?? '')}" placeholder="0" aria-label="Потери ${i + 1}">
      <span class="res">${br === null ? '—' : fmt(br) + ' ' + uu}<small>брутто</small></span>
      <span class="res">${nt === null ? '—' : fmt(nt) + ' ' + uu}<small>нетто</small></span>
      <button class="del" aria-label="Удалить строку ${i + 1}">×</button>`;
    prodCombo($('.cb input', row), it => { r.p = it.d; if (!r.q) r.u = big(it.u); renderCalc(); R.children[i]?.querySelector('.q')?.focus(); });
    $('.q', row).onchange = ev => { r.q = ev.target.value; renderCalc(); };
    $('.u', row).onchange = ev => { r.u = ev.target.value; renderCalc(); };
    $('.l', row).onchange = ev => { r.loss = ev.target.value; renderCalc(); };
    $('.del', row).onclick = () => { calc.rows.splice(i, 1); renderCalc(); };
    R.appendChild(row);
  });
  if (!calc.rows.length) R.innerHTML = '<div class="empty">Добавьте продукты или нажмите «Посчитать закладку по карте»</div>';
  const c = calc.code ? effective(calc.code) : null;
  let h = `<div>Сумма нетто на 1 порцию: <b class="num">${fmt(sum, 1)} г</b>${c ? ` · по карте выход <b class="num">${fmt(num(c.out), 1)} ${esc(c.ou)}</b>` : ''}</div>`;
  if (port) h += `<div>По весу готового: <b class="num">${fmt(port, 1)} г</b> на порцию → ${sum > port ? 'при готовке уходит' : 'привар'} <b>${fmt(Math.abs(1 - port / (sum || port)) * 100, 0)}%</b></div>`;
  else h += '<div class="muted">Впишите вес готового блюда в мармитке — увидите реальный выход порции.</div>';
  $('#cSum').innerHTML = h;
}
function showTab(t) { $('#tabCards').setAttribute('aria-selected', t === 'cards'); $('#tabCalc').setAttribute('aria-selected', t === 'calc'); $('#viewCards').hidden = t !== 'cards'; $('#viewCalc').hidden = t !== 'calc'; dd.hidden = true; scrollTo(0, 0); }

// ---------- boot ----------
async function refreshEdits(silent) {
  try {
    const e = await api('/api/edits');
    const changedCurrent = current && JSON.stringify(e[current] || null) !== JSON.stringify(edits[current] || null);
    edits = e; online = true;
    setSync('ok', `Онлайн · изменено карт: ${Object.keys(e).length}`);
    if (changedCurrent && !drafts[current]) renderEditor();
    else if (changedCurrent && drafts[current] && $('#conflict')) $('#conflict').innerHTML = `<div class="banner">Эту карту только что сохранил(а) ${esc((e[current] || {}).by || 'другой сотрудник')}. Ваши правки не потеряны — при сохранении появится выбор.</div>`;
    renderList();
  } catch (err) { if (err.message !== 'auth') { online = false; setSync('bad', 'Нет связи — правки сохраняются на устройстве'); if (!silent) toast('Нет связи с сервером'); } }
}
async function boot() {
  try { ME = await api('/api/me'); } catch (e) { return; }
  $('#meName').textContent = ME.name; $('#meWho').textContent = 'Вы вошли как ' + ME.name;
  try { BASE = await api('/api/base'); } catch (e) { $('#editor').innerHTML = '<div class="empty">Не удалось загрузить карты. Обновите страницу.</div>'; return; }
  BASE.cards.sort((a, b) => (a.cat || 'я').localeCompare(b.cat || 'я', 'ru') || a.name.localeCompare(b.name, 'ru'));
  BASE.cards.forEach(c => BYCODE[c.code] = c);
  PRODLIST = BASE.products; PRODLIST.forEach(p => PROD[p.d] = p);
  DISHES = BASE.cards.map(c => ({ code: c.code, name: c.name, cat: c.cat }));
  $('#cat').innerHTML += [...new Set(BASE.cards.map(c => c.cat).filter(Boolean))].sort().map(c => `<option>${esc(c)}</option>`).join('');
  await refreshEdits(true);
  const h = decodeURIComponent(location.hash.slice(1));
  openCard(BYCODE[h] ? h : BASE.cards[0].code);
  if (h === 'calc') setTimeout(() => showTab('calc'));
  attachCombo($('#cDish'), { list: () => DISHES, key: d => d.name + ' ' + d.code + ' ' + d.cat, label: d => effective(d.code).name, sub: d => d.cat, onPick: d => setCalcDish(d.code) });
  setCalcDish(current); calc.rows = [];
  renderCalc();
  setInterval(() => { if (!document.hidden) refreshEdits(true); }, 20000);
  addEventListener('focus', () => refreshEdits(true));
}
$('#tabCards').onclick = () => showTab('cards');
$('#tabCalc').onclick = () => showTab('calc');
$('#q').oninput = renderList; $('#cat').onchange = renderList;
$('#seg').onclick = e => { const b = e.target.closest('button'); if (!b) return; filter = b.dataset.f; [...$('#seg').children].forEach(x => x.setAttribute('aria-pressed', x === b)); renderList(); };
$('#menuBtn').onclick = e => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', !m.hidden); };
document.addEventListener('click', e => { if (!e.target.closest('.menuWrap')) $('#menu').hidden = true; });
$('#logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };
['#cN', '#cK', '#cW'].forEach(s => $(s).oninput = renderCalc);
$('#cAdd').onclick = () => { calc.rows.push({ p: '', q: '', u: 'кг', loss: '' }); renderCalc(); const ins = $('#cRows').querySelectorAll('.cb input'); ins[ins.length - 1]?.focus(); };
$('#cClear').onclick = () => { calc.rows = []; renderCalc(); };
$('#cFromCard').onclick = () => {
  if (!calc.code) return toast('Сначала выберите блюдо');
  const c = effective(calc.code), T = cTotal(); if (!T) return toast('Укажите мармитки и порции');
  calc.rows = c.ing.map(r => { const b = num(r.br) || 0, n = num(r.nt) || 0, u = unitOf(r), tot = b * T, bu = big(u); return { p: r.p, q: fmt(bu === u ? tot : tot / 1000, 3), u: bu, loss: b ? fmt((1 - n / b) * 100, 1) : '' }; });
  const n = num($('#cN').value); if (num(c.out) && n) $('#cW').value = fmt(num(c.out) * T / n / 1000, 2);
  renderCalc(); toast(`Закладка посчитана на ${fmt(T, 0)} порций`);
};
$('#cToCard').onclick = async () => {
  if (!calc.code) return toast('Сначала выберите блюдо');
  const T = cTotal(); if (!T) return toast('Укажите мармитки и порции');
  const rows = calc.rows.filter(r => r.p && num(r.q) !== null); if (!rows.length) return toast('Внесите продукты и количество');
  const n = num($('#cN').value), k = num($('#cK').value), w = num($('#cW').value);
  if (!(await confirmBox('Записать нормы в карту?', `Количество на ${fmt(T, 0)} порций будет разделено на число порций и записано в «${effective(calc.code).name}». Карту потом нужно сохранить.`, 'Записать'))) return;
  const tag = `Из калькулятора (${ME.name}): ${fmt(n, 0)} × ${fmt(k, 0)} порц.`;
  const d = getDraft(calc.code), byP = {}; d.ing.forEach(r => byP[r.p] = r);
  rows.forEach(r => {
    const tot = toBase(num(r.q), r.u), lp = num(r.loss) || 0, br = +(tot / T).toFixed(3), nt = +(br * (1 - lp / 100)).toFixed(3), p = PROD[r.p], ex = byP[r.p];
    if (ex) { ex.note = ((ex.note || '') + ` ${tag} было ${fmt(num(ex.br))} / ${fmt(num(ex.nt))} → стало ${fmt(br)} / ${fmt(nt)}.`).trim(); ex.br = br; ex.nt = nt; }
    else d.ing.push({ p: r.p, code: p ? p.code : '', u: p ? p.u : baseU(r.u), br, nt, note: `Добавлено. ${tag}` });
  });
  if (w && T) d.out = +(w * 1000 * n / T).toFixed(1);
  persistDraft(calc.code); current = calc.code; showTab('cards'); renderEditor(); renderList(); toast('Нормы записаны в карту — проверьте и нажмите «Сохранить»', 4000);
};
$('#cCopy').onclick = () => {
  const T = cTotal(), lines = [`Закладка: ${$('#cN').value} × ${$('#cK').value} = ${fmt(T, 0)} порций${calc.code ? ' · ' + effective(calc.code).name : ''}`, 'Продукт\tВсего\tЕд.\t1 порция брутто\t1 порция нетто'];
  calc.rows.forEach(r => { const tot = toBase(num(r.q), r.u), lp = num(r.loss) || 0, br = tot !== null && T ? tot / T : null, uu = baseU(r.u); lines.push([shortName(r.p), r.q, r.u, br === null ? '' : fmt(br) + ' ' + uu, br === null ? '' : fmt(br * (1 - lp / 100)) + ' ' + uu].join('\t')); });
  navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Скопировано'), () => toast('Браузер не дал скопировать'));
};
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' || (e.ctrlKey || e.metaKey) && e.key === 'ы') { e.preventDefault(); if (drafts[current]) save(); } });
addEventListener('beforeunload', e => { if (Object.keys(drafts).length) { e.preventDefault(); e.returnValue = ''; } });
boot();
})();
