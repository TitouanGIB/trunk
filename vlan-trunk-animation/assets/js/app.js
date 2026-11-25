/* ==========================================================================
   app.js — Rendu SVG de la topologie, moteur d'animation et interface
   ========================================================================== */
'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
     Géométrie de la topologie (viewBox 900 x 565)
     ------------------------------------------------------------------------ */
  const POS = { r: { x: 450, y: 95 }, sw: { x: 450, y: 285 }, pc1: { x: 180, y: 462 }, pc2: { x: 720, y: 462 } };
  const LINKS = {
    'r-sw':   { a: 'r',  b: 'sw',  pa: { x: 450, y: 150 }, pb: { x: 450, y: 252 } },
    'sw-pc1': { a: 'sw', b: 'pc1', pa: { x: 382, y: 318 }, pb: { x: 224, y: 428 } },
    'sw-pc2': { a: 'sw', b: 'pc2', pa: { x: 518, y: 318 }, pb: { x: 676, y: 428 } },
  };
  const NOTE_POS = { r: { x: 450, y: 30 }, sw: { x: 650, y: 285 }, pc1: { x: 180, y: 398 }, pc2: { x: 720, y: 398 } };
  const DROP_POS = { r: { x: 450, y: 160 }, 'sw-top': { x: 450, y: 234 }, sw: { x: 450, y: 285 }, pc1: { x: 180, y: 455 }, pc2: { x: 720, y: 455 } };
  const BLOCK_POS = {
    'r-sw':   { x: 450, y: 194, tx: 428, ty: 199, anchor: 'end' },
    'sw-pc1': { x: 303, y: 373, tx: 318, ty: 402, anchor: 'start' },
    'sw-pc2': { x: 597, y: 373, tx: 582, ty: 402, anchor: 'end' },
  };

  function linkEnds(from, to) {
    for (const L of Object.values(LINKS)) {
      if (L.a === from && L.b === to) return [L.pa, L.pb];
      if (L.b === from && L.a === to) return [L.pb, L.pa];
    }
    throw new Error(`Lien inconnu ${from} → ${to}`);
  }
  const linkName = (from, to) => {
    const names = { r: 'R1 G0/0', sw: 'SW1', pc1: 'PC1', pc2: 'PC2' };
    const port = (a, b) => {
      if (a === 'sw' && b === 'r') return 'SW1 Gi0/1';
      if (a === 'sw' && b === 'pc1') return 'SW1 Fa0/1';
      if (a === 'sw' && b === 'pc2') return 'SW1 Fa0/2';
      return names[a];
    };
    return `${port(from, to)} → ${port(to, from)}`;
  };

  /* ------------------------------------------------------------------------
     Construction du SVG
     ------------------------------------------------------------------------ */
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  function buildTopology(cfg) {
    const svg = $('#topo');
    const vcol = (v) => `var(--v${v})`;
    const trunkLines = [10, 20].map((v, i) => {
      const x = 450 + (i === 0 ? -5 : 5);
      const on = cfg.allowed.includes(v);
      return `<line x1="${x}" y1="136" x2="${x}" y2="252" class="vline ${on ? '' : 'off'}" style="stroke:${on ? vcol(v) : 'var(--muted)'}"/>`;
    }).join('');

    const subLabel = (v, side) => {
      const on = cfg.subs.includes(v);
      const x = side === 'l' ? 398 : 502;
      const anchor = side === 'l' ? 'end' : 'start';
      return `<g class="sublabel ${on ? '' : 'off'}">
        <text x="${x}" y="88" text-anchor="${anchor}" class="lbl-strong" style="fill:${vcol(v)}">G0/0.${v}${on ? '' : ' (absente)'}</text>
        <text x="${x}" y="105" text-anchor="${anchor}" class="lbl-mono">${on ? NET.vlans[v].gw + '/24' : '—'}</text>
        <text x="${x}" y="120" text-anchor="${anchor}" class="lbl-tiny">${on ? 'encapsulation dot1Q ' + v : ''}</text>
      </g>`;
    };

    const pc = (id, p, v) => {
      const d = NET[id];
      const { x, y } = POS[id];
      return `
      <rect class="zone" x="${x - 125}" y="382" width="250" height="175" rx="18" style="fill:${vcol(v)};stroke:${vcol(v)}"/>
      <text class="zone-lbl" x="${x - 113}" y="550" style="fill:${vcol(v)}">VLAN ${v} · ${NET.vlans[v].name}</text>
      <g class="dev" id="dev-${id}" data-dev="${id}">
        <rect class="ring" x="${x - 52}" y="${y - 42}" width="104" height="84" rx="14"/>
        <rect class="pc-screen" x="${x - 38}" y="${y - 32}" width="76" height="50" rx="5"/>
        <rect class="pc-glass" x="${x - 32}" y="${y - 26}" width="64" height="38" rx="2"/>
        <path class="pc-stand" d="M${x - 10} ${y + 18} h20 l5 12 h-30 z"/>
        <text x="${x}" y="${y - 2}" text-anchor="middle" class="pc-txt">${d.name}</text>
      </g>
      <text x="${x}" y="506" text-anchor="middle" class="lbl-strong">${d.name} · ${d.ip}/24</text>
      <text x="${x}" y="522" text-anchor="middle" class="lbl-mono">passerelle ${d.gw}</text>
      <text x="${x}" y="537" text-anchor="middle" class="lbl-mono dim">${d.mac}</text>`;
    };

    svg.innerHTML = `
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g id="layer-zones">${pc('pc1', POS.pc1, cfg.p1)}${pc('pc2', POS.pc2, cfg.p2)}</g>

      <!-- Câbles -->
      <g id="layer-links">
        <line class="cable" x1="450" y1="136" x2="450" y2="252"/>
        ${trunkLines}
        <line class="cable" x1="382" y1="318" x2="224" y2="428"/>
        <line class="vline" x1="382" y1="318" x2="224" y2="428" style="stroke:${vcol(cfg.p1)}"/>
        <line class="cable" x1="518" y1="318" x2="676" y2="428"/>
        <line class="vline" x1="518" y1="318" x2="676" y2="428" style="stroke:${vcol(cfg.p2)}"/>

        <text x="472" y="182" class="lbl-strong trunk-lbl">TRUNK 802.1Q</text>
        <text x="472" y="199" class="lbl-mono">VLAN autorisés : ${cfg.allowed.length ? [...cfg.allowed].sort().join(', ') : 'aucun'}</text>
        <text x="472" y="215" class="lbl-tiny">VLAN natif 99 · trames taguées</text>

        <text x="390" y="155" text-anchor="end" class="port">G0/0</text>
        <text x="440" y="246" text-anchor="end" class="port">Gi0/1</text>
        <text x="366" y="330" text-anchor="end" class="port">Fa0/1</text>
        <text x="534" y="330" text-anchor="start" class="port">Fa0/2</text>
        <text x="282" y="362" text-anchor="end" class="lbl-tiny" style="fill:${vcol(cfg.p1)}">ACCESS · VLAN ${cfg.p1}</text>
        <text x="618" y="362" text-anchor="start" class="lbl-tiny" style="fill:${vcol(cfg.p2)}">ACCESS · VLAN ${cfg.p2}</text>
      </g>

      <!-- Routeur -->
      ${subLabel(10, 'l')}${subLabel(20, 'r')}
      <g class="dev" id="dev-r" data-dev="r">
        <circle class="ring" cx="450" cy="95" r="50"/>
        <circle class="router" cx="450" cy="95" r="38"/>
        <g class="router-arrows" transform="translate(450 95)">
          <path d="M-6 -6 L-20 -20 M-20 -20 h8 M-20 -20 v8"/>
          <path d="M6 6 L20 20 M20 20 h-8 M20 20 v-8"/>
          <path d="M6 -6 L20 -20 M20 -20 h-8 M20 -20 v8" />
          <path d="M-6 6 L-20 20 M-20 20 h8 M-20 20 v-8" />
        </g>
      </g>
      <text x="512" y="152" class="lbl-strong">R1 · routeur</text>

      <!-- Switch -->
      <g class="dev" id="dev-sw" data-dev="sw">
        <rect class="ring" x="362" y="247" width="176" height="76" rx="16"/>
        <rect class="switch" x="370" y="255" width="160" height="60" rx="10"/>
        <g class="switch-arrows">
          <path d="M392 274 h40 m-8 -6 l8 6 l-8 6"/>
          <path d="M432 296 h-40 m8 -6 l-8 6 l8 6"/>
        </g>
        <text x="482" y="280" text-anchor="middle" class="sw-txt">SW1</text>
        <text x="482" y="298" text-anchor="middle" class="sw-sub">Switch L2</text>
      </g>

      <g id="layer-markers"></g>
      <g id="layer-packets"></g>
      <g id="layer-notes"></g>`;
  }

  /* ------------------------------------------------------------------------
     Paquets, bulles, marqueurs
     ------------------------------------------------------------------------ */
  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  function frameShort(f) {
    if (f.proto === 'ARP') return f.arp.op === 'request' ? 'ARP ?' : 'ARP ✓';
    return f.ip.icmp === 'echo-request' ? 'PING' : 'PONG';
  }

  function makePacket(frame) {
    const g = el('g', { class: `pkt ${frame.tag ? 'tagged t' + frame.tag : 'untagged'}` });
    const W = frame.tag ? 108 : 60;
    let x = -W / 2;
    if (frame.tag) {
      el('rect', { x, y: -14, width: 46, height: 28, rx: 6, class: 'pkt-tag', style: `fill:var(--v${frame.tag})` }, g);
      const t = el('text', { x: x + 23, y: 4.5, 'text-anchor': 'middle', class: 'pkt-tag-txt' }, g);
      t.textContent = `VID ${frame.tag}`;
      x += 48;
    }
    el('rect', { x, y: -14, width: 60, height: 28, rx: 6, class: 'pkt-body', style: `stroke:var(--v${frame.vlan})` }, g);
    const t2 = el('text', { x: x + 30, y: 4.5, 'text-anchor': 'middle', class: 'pkt-txt' }, g);
    t2.textContent = frameShort(frame);
    if (frame.dst === NET.bcast) {
      el('circle', { cx: x + 56, cy: -12, r: 6, class: 'pkt-bcast' }, g);
      const b = el('text', { x: x + 56, y: -9.5, 'text-anchor': 'middle', class: 'pkt-bcast-txt' }, g);
      b.textContent = '∗';
    }
    return g;
  }

  function addNote(note) {
    const layer = $('#layer-notes');
    const p = NOTE_POS[note.at];
    const w = Math.max(60, note.text.length * 6.7 + 22);
    const g = el('g', { class: 'note', transform: `translate(${p.x} ${p.y})` }, layer);
    el('rect', { x: -w / 2, y: -13, width: w, height: 26, rx: 13 }, g);
    const t = el('text', { x: 0, y: 4.5, 'text-anchor': 'middle' }, g);
    t.textContent = note.text;
  }

  function addDrop(d) {
    const layer = $('#layer-markers');
    const p = DROP_POS[d.at];
    const g = el('g', { class: 'drop', transform: `translate(${p.x} ${p.y})` }, layer);
    el('circle', { r: 15 }, g);
    el('path', { d: 'M-6 -6 L6 6 M6 -6 L-6 6' }, g);
    const t = el('text', { x: 22, y: 5 }, g);
    t.textContent = d.text;
  }

  function addBlock(b) {
    const layer = $('#layer-markers');
    const p = BLOCK_POS[b.link];
    const g = el('g', { class: 'block' }, layer);
    el('circle', { cx: p.x, cy: p.y, r: 13 }, g);
    el('path', { d: `M${p.x - 8} ${p.y + 8} L${p.x + 8} ${p.y - 8}` }, g);
    const t = el('text', { x: p.tx, y: p.ty, 'text-anchor': p.anchor }, g);
    t.textContent = b.text;
  }

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /* ------------------------------------------------------------------------
     État de la simulation
     ------------------------------------------------------------------------ */
  const sim = {
    steps: [], idx: 0, cfg: cloneCfg(DEFAULT_CFG), presetId: 'arp',
    playing: false, speed: 1, token: 0, timer: null,
  };

  function computeState(upto) {
    const st = { mac: [], arp: { pc1: [], pc2: [], r: [] } };
    for (let i = 0; i <= upto; i++) {
      for (const e of sim.steps[i].effects || []) {
        const fresh = i === upto;
        if (e.t === 'mac') {
          const ex = st.mac.find((m) => m.vlan === e.vlan && m.mac === e.mac);
          if (ex) { ex.port = e.port; ex.fresh = ex.fresh || fresh; } else st.mac.push({ ...e, fresh });
        } else if (e.t === 'arp') {
          const list = st.arp[e.dev];
          const ex = list.find((a) => a.ip === e.ip);
          if (ex) { ex.mac = e.mac; } else list.push({ ...e, fresh });
        }
      }
    }
    st.mac.sort((a, b) => a.vlan - b.vlan);
    return st;
  }

  function renderTables() {
    const st = computeState(sim.idx);
    const row = (cells, fresh) => `<tr class="${fresh ? 'fresh' : ''}">${cells.map((x) => `<td>${x}</td>`).join('')}</tr>`;
    const empty = (n, txt) => `<tr class="empty"><td colspan="${n}">${txt}</td></tr>`;

    $('#tbl-mac tbody').innerHTML = st.mac.length
      ? st.mac.map((m) => row([`<span class="vchip v${m.vlan}">${m.vlan}</span>`, `<code>${macCisco(m.mac)}</code>`, m.port, 'DYNAMIC'], m.fresh)).join('')
      : empty(4, 'Table vide : le switch n\'a encore rien appris.');

    const arpRows = (list, withItf) => (list.length
      ? list.map((a) => row([`<code>${a.ip}</code>`, `<code>${a.mac}</code>`].concat(withItf ? [a.itf] : []), a.fresh)).join('')
      : empty(withItf ? 3 : 2, 'Cache ARP vide'));
    $('#tbl-arp-pc1 tbody').innerHTML = arpRows(st.arp.pc1, false);
    $('#tbl-arp-pc2 tbody').innerHTML = arpRows(st.arp.pc2, false);
    $('#tbl-arp-r tbody').innerHTML = arpRows(st.arp.r, true);

    const routes = [10, 20].filter((v) => sim.cfg.subs.includes(v))
      .map((v) => row(['C', `<code>${NET.vlans[v].subnet}</code>`, `G0/0.${v}`], false)).join('');
    $('#tbl-route tbody').innerHTML = routes || empty(3, 'Aucune route');
  }

  /* ------------------------------------------------------------------------
     Inspecteur de trame
     ------------------------------------------------------------------------ */
  function pickInspect(step) {
    if (!step.moves || !step.moves.length) return null;
    return step.moves.find((m) => m.frame.tag) || step.moves[0];
  }

  function renderInspector(step) {
    const box = $('#inspector');
    const m = pickInspect(step);
    if (!m) {
      box.innerHTML = `<div class="insp-empty"><span>⚙</span><p>Aucune trame sur le fil à cette étape :
        l'équipement mis en évidence traite l'information.</p></div>`;
      return;
    }
    const f = m.frame;
    const tag = f.tag;
    const isTrunk = (m.from === 'r' || m.to === 'r');
    const pcp = 0; const dei = 0;
    const tci = tag ? ((pcp << 13) | (dei << 12) | tag) : 0;
    const vidBin = tag ? tag.toString(2).padStart(12, '0').replace(/(\d{4})(?=\d)/g, '$1 ') : '';

    const seg = (cls, name, size, val) => `<div class="seg ${cls}" style="flex:${size}">
      <span class="seg-name">${name}</span><span class="seg-val">${val}</span><span class="seg-size">${size === 9 ? '46–1500 o' : size + ' o'}</span></div>`;

    let payload = '';
    if (f.proto === 'ARP') {
      payload = `<dl class="kv">
        <dt>Opération</dt><dd>${f.arp.op === 'request' ? '1 · Request (qui a… ?)' : '2 · Reply (c\'est moi)'}</dd>
        <dt>MAC émetteur</dt><dd><code>${f.arp.sha}</code></dd>
        <dt>IP émetteur</dt><dd><code>${f.arp.spa}</code></dd>
        <dt>MAC cible</dt><dd><code>${f.arp.tha}</code></dd>
        <dt>IP cible</dt><dd><code>${f.arp.tpa}</code></dd></dl>`;
    } else {
      payload = `<dl class="kv">
        <dt>IP source</dt><dd><code>${f.ip.src}</code></dd>
        <dt>IP destination</dt><dd><code>${f.ip.dst}</code></dd>
        <dt>TTL</dt><dd><code>${f.ip.ttl}</code></dd>
        <dt>Protocole</dt><dd>ICMP (1)</dd>
        <dt>Type ICMP</dt><dd>${f.ip.icmp === 'echo-request' ? '8 · Echo Request' : '0 · Echo Reply'}</dd></dl>`;
    }

    box.innerHTML = `
      <div class="insp-head">
        <span class="insp-link">${linkName(m.from, m.to)}</span>
        <span class="badge ${tag ? 'b-tag' : 'b-untag'}" style="${tag ? `--bc:var(--v${tag});--bi:var(--v${tag}-ink)` : ''}">
          ${tag ? `Taguée 802.1Q · VID ${tag}` : 'Non taguée'}</span>
        <span class="badge b-kind">${isTrunk ? 'lien trunk' : 'lien access'}</span>
      </div>
      <div class="framebar" style="${tag ? `--bc:var(--v${tag});--bi:var(--v${tag}-ink)` : ''}">
        ${seg('s-mac', 'MAC dest.', 6, `<code>${f.dst === NET.bcast ? 'broadcast' : f.dst.slice(-8)}</code>`)}
        ${seg('s-mac', 'MAC source', 6, `<code>${f.src.slice(-8)}</code>`)}
        ${tag ? seg('s-tag', '802.1Q', 4, `VID ${tag}`) : ''}
        ${seg('s-type', 'Type', 2, `<code>${f.type}</code>`)}
        ${seg('s-data', f.proto === 'ARP' ? 'ARP' : 'IPv4 + ICMP', 9, '…')}
        ${seg('s-fcs', 'FCS', 4, 'CRC')}
      </div>
      ${tag ? `<div class="tagdetail" style="--bc:var(--v${tag})">
        <div><span>TPID</span><code>0x8100</code><small>16 bits</small></div>
        <div><span>PCP</span><code>${pcp.toString(2).padStart(3, '0')}</code><small>3 bits · priorité</small></div>
        <div><span>DEI</span><code>${dei}</code><small>1 bit</small></div>
        <div class="vid"><span>VID</span><code>${vidBin}</code><small>12 bits = ${tag} · TCI 0x${tci.toString(16).toUpperCase().padStart(4, '0')}</small></div>
      </div>` : `<p class="insp-note">Pas de champ 802.1Q : la trame est au format Ethernet II standard.
        Son appartenance au VLAN ${f.vlan} n'existe que dans la tête du switch, d'après le port.</p>`}
      <div class="insp-cols">
        <dl class="kv"><dt>MAC destination</dt><dd><code>${f.dst}</code>${f.dst === NET.bcast ? ' <em>(broadcast)</em>' : ''}</dd>
        <dt>MAC source</dt><dd><code>${f.src}</code></dd>
        <dt>EtherType</dt><dd><code>${f.type}</code> ${f.type === '0x0806' ? 'ARP' : 'IPv4'}</dd></dl>
        ${payload}
      </div>`;
  }

  /* ------------------------------------------------------------------------
     Rendu d'une étape
     ------------------------------------------------------------------------ */
  function clearDynamic() {
    $('#layer-packets').innerHTML = '';
    $('#layer-notes').innerHTML = '';
    $('#layer-markers').innerHTML = '';
    $$('#topo .dev').forEach((d) => d.classList.remove('focus'));
  }

  function animateMoves(moves, token) {
    return new Promise((resolve) => {
      if (!moves || !moves.length) return resolve();
      const layer = $('#layer-packets');
      const items = moves.map((m) => {
        const [a, b] = linkEnds(m.from, m.to);
        const g = makePacket(m.frame);
        g.setAttribute('transform', `translate(${a.x} ${a.y})`);
        layer.appendChild(g);
        return { g, a, b };
      });
      const dur = reduceMotion ? 1 : 1300 / sim.speed;
      const t0 = performance.now();
      const tick = (now) => {
        if (token !== sim.token) return resolve();
        const t = Math.min(1, (now - t0) / dur);
        const k = ease(t);
        for (const it of items) {
          it.g.setAttribute('transform', `translate(${it.a.x + (it.b.x - it.a.x) * k} ${it.a.y + (it.b.y - it.a.y) * k})`);
        }
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  async function goTo(i, { animate = true } = {}) {
    if (!sim.steps.length) return;
    i = Math.max(0, Math.min(sim.steps.length - 1, i));
    sim.idx = i;
    const token = ++sim.token;
    clearTimeout(sim.timer);
    const step = sim.steps[i];

    clearDynamic();
    (step.focus || []).forEach((d) => $(`#dev-${d}`)?.classList.add('focus'));
    renderExplain(step);
    renderInspector(step);
    renderTables();
    renderLog();
    updateControls();

    if (animate) await animateMoves(step.moves, token);
    else if (step.moves) {
      for (const m of step.moves) {
        const [, b] = linkEnds(m.from, m.to);
        const g = makePacket(m.frame);
        g.setAttribute('transform', `translate(${b.x} ${b.y})`);
        $('#layer-packets').appendChild(g);
      }
    }
    if (token !== sim.token) return;
    (step.blocks || []).forEach(addBlock);
    (step.drops || []).forEach(addDrop);
    (step.notes || []).forEach(addNote);

    if (sim.playing) {
      if (i >= sim.steps.length - 1) { setPlaying(false); return; }
      const words = (step.html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).length;
      const wait = Math.min(9000, 1800 + words * 70) / sim.speed;
      sim.timer = setTimeout(() => { if (token === sim.token && sim.playing) goTo(i + 1); }, wait);
    }
  }

  function renderExplain(step) {
    const box = $('#explain');
    box.className = `card explain ${step.status ? 'st-' + step.status : ''}`;
    $('#ex-phase').textContent = step.phase;
    $('#ex-count').textContent = `Étape ${sim.idx + 1} / ${sim.steps.length}`;
    $('#ex-title').textContent = step.title;
    $('#ex-body').innerHTML = step.html || '';
    $('#progress-fill').style.width = `${((sim.idx + 1) / sim.steps.length) * 100}%`;
  }

  function renderLog() {
    const ol = $('#steplog');
    ol.innerHTML = sim.steps.map((s, k) => `<li class="${k === sim.idx ? 'cur' : ''} ${k < sim.idx ? 'done' : ''} ${s.status ? 'st-' + s.status : ''}">
      <button type="button" data-step="${k}"><span class="ph">${esc(s.phase)}</span>${esc(s.title)}</button></li>`).join('');
    const cur = ol.querySelector('.cur');
    if (cur) {
      const top = cur.offsetTop - ol.clientHeight / 2 + cur.clientHeight / 2;
      ol.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function updateControls() {
    $('#btn-prev').disabled = sim.idx === 0;
    $('#btn-next').disabled = sim.idx >= sim.steps.length - 1;
    $('#btn-play').innerHTML = sim.playing ? '<span aria-hidden="true">❚❚</span> Pause' : '<span aria-hidden="true">▶</span> Lecture';
    $('#btn-play').setAttribute('aria-pressed', String(sim.playing));
  }

  function setPlaying(p) {
    sim.playing = p;
    clearTimeout(sim.timer);
    updateControls();
  }

  function loadScenario(cfg, opts, presetId) {
    setPlaying(false);
    sim.cfg = cloneCfg(cfg);
    sim.presetId = presetId;
    sim.steps = buildScenario(sim.cfg, opts);
    buildTopology(sim.cfg);
    $$('#scenarios button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.preset === presetId)));
    goTo(0);
  }

  /* ------------------------------------------------------------------------
     Interface : scénarios, contrôles, clavier
     ------------------------------------------------------------------------ */
  function initSimulator() {
    const tabs = $('#scenarios');
    tabs.innerHTML = PRESETS.map((p, k) => `<button type="button" role="tab" data-preset="${p.id}">
      <span class="sc-num">${k + 1}</span><span class="sc-txt"><strong>${p.label}</strong><small>${p.sub}</small></span></button>`).join('')
      + `<button type="button" role="tab" data-preset="lab"><span class="sc-num">⚗</span><span class="sc-txt"><strong>Labo</strong><small>Votre configuration</small></span></button>`;
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.preset === 'lab') { runLab(); return; }
      const p = PRESETS.find((x) => x.id === b.dataset.preset);
      loadScenario(p.cfg, p.opts, p.id);
    });

    $('#btn-prev').addEventListener('click', () => { setPlaying(false); goTo(sim.idx - 1); });
    $('#btn-next').addEventListener('click', () => { setPlaying(false); goTo(sim.idx + 1); });
    $('#btn-restart').addEventListener('click', () => { setPlaying(false); goTo(0); });
    $('#btn-replay').addEventListener('click', () => goTo(sim.idx));
    $('#btn-play').addEventListener('click', togglePlay);
    $('#speed').addEventListener('change', (e) => { sim.speed = parseFloat(e.target.value); });
    $('#steplog').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-step]');
      if (b) { setPlaying(false); goTo(parseInt(b.dataset.step, 10)); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      const r = $('#simulateur').getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); goTo(sim.idx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); goTo(sim.idx - 1); }
      else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Home') { e.preventDefault(); setPlaying(false); goTo(0); }
    });

    const p = PRESETS[0];
    loadScenario(p.cfg, p.opts, p.id);
  }

  function togglePlay() {
    if (sim.playing) { setPlaying(false); return; }
    if (sim.idx >= sim.steps.length - 1) goTo(0);
    setPlaying(true);
    goTo(sim.idx === sim.steps.length - 1 ? 0 : sim.idx + 1);
  }

  /* ------------------------------------------------------------------------
     Labo de dépannage
     ------------------------------------------------------------------------ */
  function readLab() {
    const f = $('#lab-form');
    return {
      p1: parseInt(f.p1.value, 10),
      p2: parseInt(f.p2.value, 10),
      allowed: $$('input[name="allowed"]:checked', f).map((x) => parseInt(x.value, 10)),
      subs: $$('input[name="subs"]:checked', f).map((x) => parseInt(x.value, 10)),
    };
  }
  function writeLab(cfg) {
    const f = $('#lab-form');
    f.p1.value = String(cfg.p1);
    f.p2.value = String(cfg.p2);
    $$('input[name="allowed"]', f).forEach((x) => { x.checked = cfg.allowed.includes(parseInt(x.value, 10)); });
    $$('input[name="subs"]', f).forEach((x) => { x.checked = cfg.subs.includes(parseInt(x.value, 10)); });
    updateLabPreview();
  }
  function updateLabPreview() {
    const cfg = readLab();
    const conf = genConfig(cfg);
    $('#lab-sw').innerHTML = highlight(conf.switch);
    $('#lab-r').innerHTML = highlight(conf.router);
    const ok = cfg.p1 === 10 && cfg.p2 === 20 && cfg.allowed.includes(10) && cfg.allowed.includes(20) && cfg.subs.includes(10) && cfg.subs.includes(20);
    $('#lab-status').textContent = ok ? 'Configuration conforme au plan d\'adressage' : 'Configuration modifiée : le ping va-t-il passer ?';
    $('#lab-status').className = `lab-status ${ok ? 'ok' : 'warn'}`;
  }
  function runLab() {
    loadScenario(readLab(), { arp: true, reply: true }, 'lab');
    $('#simulateur').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
  function initLab() {
    const f = $('#lab-form');
    f.addEventListener('change', updateLabPreview);
    f.addEventListener('submit', (e) => { e.preventDefault(); runLab(); });
    $('#lab-reset').addEventListener('click', () => writeLab(DEFAULT_CFG));
    $('#lab-random').addEventListener('click', () => {
      const faults = [
        { p1: 10, p2: 20, allowed: [10], subs: [10, 20] },
        { p1: 10, p2: 20, allowed: [20], subs: [10, 20] },
        { p1: 10, p2: 10, allowed: [10, 20], subs: [10, 20] },
        { p1: 20, p2: 20, allowed: [10, 20], subs: [10, 20] },
        { p1: 10, p2: 20, allowed: [10, 20], subs: [10] },
        { p1: 10, p2: 20, allowed: [10, 20], subs: [20] },
        { p1: 20, p2: 10, allowed: [10, 20], subs: [10, 20] },
      ];
      writeLab(faults[Math.floor(Math.random() * faults.length)]);
      $('#lab-status').textContent = 'Panne générée : trouvez-la dans la config, puis lancez la simulation pour vérifier.';
      $('#lab-status').className = 'lab-status warn';
    });
    writeLab(DEFAULT_CFG);
  }

  /* ------------------------------------------------------------------------
     Blocs de configuration
     ------------------------------------------------------------------------ */
  function highlight(code) {
    return code.split('\n').map((line) => {
      const e = esc(line);
      if (/^\s*[!#]/.test(line)) return `<span class="c-com">${e}</span>`;
      const m = e.match(/^(\s*)(.*?)(\s+(?:!|#|&lt;-).*)?$/);
      let body = m ? m[2] : e;
      const tail = m && m[3] ? `<span class="c-com">${m[3]}</span>` : '';
      body = body
        .replace(/^([A-Za-z0-9]+(?:\([a-z-]+\))?(?:#|&gt;))/, '<span class="c-prompt">$1</span>')
        .replace(/\b(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d+)?)\b/g, '<span class="c-ip">$1</span>')
        .replace(/\b(vlan|dot1Q|dot1q|trunk|access|native|encapsulation|switchport|interface|type vlan id)\b/g, '<span class="c-kw">$1</span>');
      return (m ? m[1] : '') + body + tail;
    }).join('\n');
  }

  function initConfig() {
    const conf = genConfig(DEFAULT_CFG);
    const map = { switch: conf.switch, router: conf.router, pcs: conf.pcs, linux: conf.linux, verify: conf.verify };
    const tabs = $$('#cfg-tabs button[data-cfg]');
    const pre = $('#cfg-code');
    const show = (k) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.cfg === k)));
      pre.innerHTML = highlight(map[k]);
      pre.dataset.raw = map[k];
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.cfg)));
    show('switch');

    $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
      const target = $(btn.dataset.copy);
      const text = target.dataset.raw || target.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copié ✓';
      } catch {
        const r = document.createRange(); r.selectNodeContents(target);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        btn.textContent = 'Sélectionné';
      }
      setTimeout(() => { btn.textContent = 'Copier'; }, 1600);
    }));
  }

  /* ------------------------------------------------------------------------
     Quiz
     ------------------------------------------------------------------------ */
  const QUIZ = [
    { q: 'Où le tag 802.1Q est-il inséré dans la trame Ethernet ?',
      a: ['Avant le préambule', 'Entre la MAC source et l\'EtherType', 'Juste avant le FCS', 'Dans l\'en-tête IP'], ok: 1,
      ex: 'Les 4 octets du tag se placent après la MAC source, à l\'endroit où l\'on attendrait l\'EtherType. Le TPID 0x8100 annonce leur présence.' },
    { q: 'Quelle valeur de TPID identifie une trame taguée 802.1Q ?',
      a: ['0x0800', '0x0806', '0x8100', '0x86DD'], ok: 2,
      ex: '0x0800 = IPv4, 0x0806 = ARP, 0x86DD = IPv6. 0x8100 signale un tag 802.1Q.' },
    { q: 'Combien d\'octets le tag 802.1Q ajoute-t-il à la trame ?',
      a: ['2', '4', '8', '12'], ok: 1,
      ex: 'TPID (2 octets) + TCI (2 octets : PCP 3 bits, DEI 1 bit, VID 12 bits) = 4 octets.' },
    { q: 'PC1 pingue PC2. Quelle adresse MAC de destination met-il dans sa trame ?',
      a: ['Celle de PC2', 'ff:ff:ff:ff:ff:ff', 'Celle de sa passerelle (le routeur)', 'Celle du switch'], ok: 2,
      ex: 'PC2 est sur un autre réseau IP : PC1 adresse la trame à sa passerelle. L\'IP de destination reste celle de PC2.' },
    { q: 'Pourquoi le broadcast ARP de PC1 n\'atteint-il jamais PC2 ?',
      a: ['Le switch bloque tous les broadcasts', 'PC2 est dans un autre VLAN, donc un autre domaine de broadcast', 'Le routeur filtre les broadcasts', 'ARP ne fonctionne qu\'en unicast'], ok: 1,
      ex: 'Un VLAN = un domaine de broadcast. Le switch ne diffuse que sur les ports du VLAN d\'origine, trunks compris.' },
    { q: 'Sur le port access Fa0/2, la trame qui arrive à PC2 est…',
      a: ['Taguée VID 20', 'Taguée VID 1', 'Non taguée', 'Doublement taguée'], ok: 2,
      ex: 'Le switch retire le tag avant d\'envoyer sur un port access. Les PC ne voient jamais de tag.' },
    { q: 'Pour un ping aller (PC1 → PC2), combien de fois la trame traverse-t-elle le trunk SW1–R1 ?',
      a: ['0', '1', '2', '4'], ok: 2,
      ex: 'Une montée taguée VID 10, puis une descente taguée VID 20 : c\'est le principe du « router-on-a-stick ». L\'aller-retour en fait 4.' },
    { q: 'Comment circulent les trames du VLAN natif sur un trunk 802.1Q ?',
      a: ['Taguées avec le VID natif', 'Non taguées', 'Chiffrées', 'Elles sont interdites'], ok: 1,
      ex: 'Le VLAN natif est le seul transporté sans tag. Bonne pratique : choisir un VLAN natif inutilisé (ex. 99) pour limiter le VLAN hopping.' },
    { q: 'Quelle commande associe la sous-interface G0/0.20 au VLAN 20 ?',
      a: ['switchport access vlan 20', 'encapsulation dot1Q 20', 'vlan 20', 'ip vlan 20'], ok: 1,
      ex: 'Sur le routeur, « encapsulation dot1Q 20 » indique que la sous-interface traite les trames taguées VID 20.' },
    { q: 'Avec un VID sur 12 bits, combien de VLAN sont utilisables ?',
      a: ['256', '1024', '4094', '4096'], ok: 2,
      ex: '2¹² = 4096 valeurs, mais 0 et 4095 sont réservés : 1 à 4094 sont utilisables.' },
  ];

  function initQuiz() {
    const root = $('#quiz-list');
    root.innerHTML = QUIZ.map((item, i) => `<li class="q" data-q="${i}">
      <p class="q-title"><span>${i + 1}</span>${esc(item.q)}</p>
      <div class="q-opts">${item.a.map((opt, j) => `<button type="button" data-a="${j}">${esc(opt)}</button>`).join('')}</div>
      <p class="q-ex" hidden></p></li>`).join('');
    const answered = new Map();
    const score = () => {
      const good = [...answered.values()].filter(Boolean).length;
      $('#quiz-score').textContent = `${good} / ${QUIZ.length}`;
      $('#quiz-done').hidden = answered.size !== QUIZ.length;
      if (answered.size === QUIZ.length) {
        $('#quiz-done').textContent = good === QUIZ.length ? 'Sans faute ! Vous maîtrisez les VLAN et le trunk 802.1Q.'
          : good >= 7 ? 'Très bien ! Relisez les explications des questions manquées.'
            : 'Rejouez le scénario complet dans le simulateur, puis retentez le quiz.';
      }
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const li = b.closest('.q');
      const qi = parseInt(li.dataset.q, 10);
      if (answered.has(qi)) return;
      const item = QUIZ[qi];
      const pick = parseInt(b.dataset.a, 10);
      answered.set(qi, pick === item.ok);
      $$('button', li).forEach((x, j) => {
        x.disabled = true;
        if (j === item.ok) x.classList.add('right');
        else if (j === pick) x.classList.add('wrong');
      });
      const ex = $('.q-ex', li);
      ex.hidden = false;
      ex.innerHTML = `<strong>${pick === item.ok ? 'Exact.' : 'Pas tout à fait.'}</strong> ${esc(item.ex)}`;
      li.classList.add(pick === item.ok ? 'is-right' : 'is-wrong');
      score();
    });
    $('#quiz-reset').addEventListener('click', () => { answered.clear(); initQuizReset(); });
    function initQuizReset() {
      $$('.q', root).forEach((li) => {
        li.classList.remove('is-right', 'is-wrong');
        $$('button', li).forEach((x) => { x.disabled = false; x.classList.remove('right', 'wrong'); });
        $('.q-ex', li).hidden = true;
      });
      score();
    }
    score();
  }

  /* ------------------------------------------------------------------------
     Thème clair / sombre + navigation
     ------------------------------------------------------------------------ */
  function initTheme() {
    const root = document.documentElement;
    let saved = null;
    try { saved = localStorage.getItem('vlan-theme'); } catch { /* stockage indisponible */ }
    if (saved) root.dataset.theme = saved;
    $('#theme-toggle').addEventListener('click', () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem('vlan-theme', next); } catch { /* ignore */ }
    });
  }

  function initNav() {
    const links = $$('.nav a[href^="#"]');
    const sections = links.map((a) => $(a.getAttribute('href'))).filter(Boolean);
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${en.target.id}`));
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach((s) => io.observe(s));
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initNav();
    initSimulator();
    initLab();
    initConfig();
    initQuiz();
    $('#year').textContent = new Date().getFullYear();
  });

  /* Exposé pour les tests / la console */
  window.VLANSim = { sim, goTo, loadScenario, buildScenario, PRESETS };
})();
