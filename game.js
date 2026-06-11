'use strict';
/*
 * niva 音樂節奏遊戲 — 原生引擎版(脫離 Scratch 引擎)
 * 遊戲邏輯 1:1 重現自 Scratch 專案 #1317527604 的積木(見 _decompiled/):
 *   - 軌道 X: A=-120 S=-80 D=-40 J=0 K=40 L=80,生成 y=200,判定線 y=-120
 *   - 音符在 t > noteTime - speedTime*1.2 生成,滑行 speedTime 秒到判定線
 *   - 判定窗(等效毫秒): <40 Conquer / <60 Perfect / <85 NooB / <100 tarsh,落底 Lost
 *   - 計分: Conquer +ns(combo+1) / Perfect +0.8ns(combo+1) / NooB +0.5ns / tarsh,Lost combo歸零
 *   - ns = level含'+' ? 500+toNum(level)*20 : 600+17*toNum(level) (Scratch toNum('9+')=0)
 *   - 難度: 1 HARD(每4取1) 2 MASTER(每2取1) 3 HELL(全) 4 SCHIZO(全+ninja隨機加註)
 *   - 全Conquer且非SCHIZO → 分數=1,000,000
 */
(function () {
  const CORE = window.__CORE;
  const W = 480, H = 360;
  const LANE_X = [-120, -80, -40, 0, 40, 80];
  const KEYS = ['a', 's', 'd', 'j', 'k', 'l'];
  const SPAWN_Y = 200, LINE_Y = -120, TRAVEL = 320;
  const DIFF_NAMES = ['HARD', 'MASTER', 'HELL', 'SCHIZO'];
  const DIFF_STEP = [4, 2, 1, 1];

  // ---------- canvas ----------
  const canvas = document.getElementById('game');
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * DPR; canvas.height = H * DPR;
  const ctx2d = canvas.getContext('2d');
  ctx2d.scale(DPR, DPR);
  // scratch coord -> canvas: cx=240+x, cy=180-y

  // ---------- images ----------
  const IMG = {};
  let imagesPending = 0;
  function loadImg(key, rec) {
    imagesPending++;
    const im = new Image();
    im.onload = () => { imagesPending--; };
    im.onerror = () => { imagesPending--; console.error('img fail', key); };
    im.src = rec.u;
    IMG[key] = { im, cx: rec.cx, cy: rec.cy };
  }
  for (const [k, rec] of Object.entries(CORE.img)) loadImg(k, rec);

  // draw a costume at scratch (x,y) with size% and alpha; rot in degrees
  function draw(key, x, y, size, alpha, rot) {
    const r = IMG[key]; if (!r || !r.im.complete || !r.im.naturalWidth) return;
    const s = (size == null ? 100 : size) / 100;
    ctx2d.save();
    ctx2d.globalAlpha = alpha == null ? 1 : alpha;
    ctx2d.translate(240 + x, 180 - y);
    if (rot) ctx2d.rotate(rot * Math.PI / 180);
    ctx2d.drawImage(r.im, -r.cx * s, -r.cy * s, r.im.naturalWidth * s, r.im.naturalHeight * s);
    ctx2d.restore();
  }
  function drawBG(key) {
    const r = IMG[key]; if (!r || !r.im.complete) return;
    ctx2d.drawImage(r.im, 0, 0, W, H);
  }
  function imgBox(key, x, y, size) { // approx bounding box for click tests
    const r = IMG[key]; if (!r || !r.im.naturalWidth) return null;
    const s = (size == null ? 100 : size) / 100;
    const left = 240 + x - r.cx * s, top = 180 - y - r.cy * s;
    return { l: left, t: top, r: left + r.im.naturalWidth * s, b: top + r.im.naturalHeight * s };
  }

  // ---------- lazy loaders (script injection — file:// safe, no fetch) ----------
  window.__COVER = window.__COVER || {};
  window.__AUDIO = window.__AUDIO || {};
  const coverImgs = {};   // n -> Image
  const coverLoading = {};
  function ensureCover(n) {
    if (coverImgs[n] || coverLoading[n]) return;
    coverLoading[n] = true;
    const s = document.createElement('script');
    s.src = 'covers/cover-' + n + '.js';
    s.onload = () => {
      const rec = window.__COVER[n];
      const im = new Image();
      im.onload = () => { coverImgs[n] = { im, cx: rec.cx, cy: rec.cy }; };
      im.src = rec.u;
    };
    s.onerror = () => { coverLoading[n] = false; };
    document.head.appendChild(s);
  }
  const audioLoading = {};
  function loadAudioJs(n) {
    return new Promise((res, rej) => {
      if (window.__AUDIO[n]) return res();
      if (audioLoading[n]) { audioLoading[n].push([res, rej]); return; }
      audioLoading[n] = [[res, rej]];
      const s = document.createElement('script');
      s.src = 'audio/audio-' + n + '.js';
      s.onload = () => { audioLoading[n].forEach(p => p[0]()); audioLoading[n] = null; };
      s.onerror = () => { audioLoading[n].forEach(p => p[1](new Error('audio js load fail'))); audioLoading[n] = null; };
      document.head.appendChild(s);
    });
  }
  function b64ToBuf(uri) {
    const b64 = uri.slice(uri.indexOf(',') + 1);
    const bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  // ---------- audio ----------
  let AC = null;
  let curSource = null, curBuffer = null, audioT0 = 0;
  function audioCtx() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
  async function startSong(n) {
    const ctx = audioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await loadAudioJs(n);
    const buf = await ctx.decodeAudioData(b64ToBuf(window.__AUDIO[n]));
    delete window.__AUDIO[n];          // free the base64 copy
    stopSong();
    curBuffer = buf;
    curSource = ctx.createBufferSource();
    curSource.buffer = buf;
    curSource.connect(ctx.destination);
    curSource.start();
    audioT0 = ctx.currentTime;
    return buf.duration;
  }
  function stopSong() {
    if (curSource) { try { curSource.stop(); } catch (e) {} curSource.disconnect(); curSource = null; }
    curBuffer = null;
  }
  function songTime() { return AC ? AC.currentTime - audioT0 : 0; }

  // ---------- helpers (Scratch semantics) ----------
  const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
  function noteScoreFor(level) {
    const s = String(level);
    return Math.floor(s.includes('+') ? 500 + toNum(s) * 20 : 600 + 17 * toNum(s));
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));

  // ---------- game state ----------
  const G = {
    scene: 'menu',            // menu | loading | play | result
    speed: 6,                 // SPEED (W/S 調整)
    diff: 1,                  // 普面 1-4
    page: 0,                  // 選歌頁 (0-6, 每頁8首)
    hoverSong: 1, song: 1,
    // play state
    st: 4 / 6, idx: 0, chart: null, ns: 0, level: '',
    score: 0, combo: 0, maxCombo: 0,
    cnt: { C: 0, P: 0, N: 0, T: 0, L: 0 },
    allConquer: true,
    notes: [],                // {lane, ts, judged, born}
    lanes: [[], [], [], [], [], []],
    effects: [],              // {kind:'flash'|'pop', lane|judge, t0}
    taps: [],                 // {lane, t0} 按鍵確認點
    ninjaNext: Infinity,
    endAt: Infinity, resultAt: Infinity,
    spawnDone: false,
    startSeq: 0,
  };
  const st = () => 4 / Math.max(1, G.speed);
  // 除錯出口(不影響遊戲)
  window.__G = G;
  window.__dbg = { songTime: () => songTime(), begin: (n) => beginSong(n), menu: () => backToMenu() };

  function pageSongs() {
    const base = G.page * 8;
    const out = [];
    for (let i = 0; i < 8; i++) out.push((base + i) % 56 + 1);
    return out;
  }
  function levelOf(n, diff) {
    const m = CORE.songs[n - 1];
    return diff < 4 ? m.lv[diff - 1] : m.lvS;
  }

  // ---------- menu ----------
  function menuLayout() {
    const songs = pageSongs();
    const cells = [];
    for (let i = 0; i < 8; i++) {
      const x = -180 + (i % 4) * 120, y = i < 4 ? 60 : -80;
      cells.push({ n: songs[i], x, y });
    }
    return cells;
  }
  function drawMenu() {
    drawBG('bgMenu');
    draw('menuFrame', 0, 0, 100, 1);
    const cells = menuLayout();
    for (const c of cells) {
      ensureCover(c.n);
      const meta = CORE.songs[c.n - 1];
      const dim = (G.diff === 4 && !meta.schizo);
      const cov = coverImgs[c.n];
      if (cov) {
        const s = 1;
        ctx2d.save();
        ctx2d.globalAlpha = dim ? 0.5 : 1;
        ctx2d.translate(240 + c.x, 180 - c.y);
        ctx2d.drawImage(cov.im, -cov.cx * s, -cov.cy * s, cov.im.naturalWidth * s, cov.im.naturalHeight * s);
        ctx2d.restore();
      } else {
        ctx2d.save();
        ctx2d.globalAlpha = dim ? 0.4 : 0.85;
        ctx2d.fillStyle = '#222a3d';
        ctx2d.fillRect(240 + c.x - 52, 180 - c.y - 38, 104, 76);
        ctx2d.fillStyle = '#9aa3b6';
        ctx2d.font = '10px sans-serif'; ctx2d.textAlign = 'center';
        ctx2d.fillText(String(meta.name).slice(0, 14), 240 + c.x, 180 - c.y + 3);
        ctx2d.restore();
      }
    }
    // 難度鈕 (127,148)
    draw(['btnHard', 'btnMaster', 'btnHell', 'btnSchizo'][G.diff - 1], 127, 148, 100, 1);
    // SPEED / level 顯示(Scratch 變數監視器樣式)
    monitor(155, 168, 'SPEED', G.speed);
    monitor(155, 146, 'level', levelOf(G.hoverSong, G.diff) || '');
  }
  function monitor(x, y, label, val) {
    const cx = 240 + x, cy = 180 - y;
    ctx2d.save();
    ctx2d.font = '10px sans-serif';
    const w = ctx2d.measureText(label).width + ctx2d.measureText(String(val)).width + 26;
    ctx2d.fillStyle = 'rgba(230,240,255,.85)';
    ctx2d.strokeStyle = '#b3b3b3';
    ctx2d.beginPath(); ctx2d.roundRect(cx, cy, w, 16, 3); ctx2d.fill(); ctx2d.stroke();
    ctx2d.fillStyle = '#575e75';
    ctx2d.fillText(label, cx + 5, cy + 11);
    const lw = ctx2d.measureText(label).width;
    ctx2d.fillStyle = '#ff8c1a';
    ctx2d.beginPath(); ctx2d.roundRect(cx + lw + 10, cy + 2, w - lw - 14, 12, 3); ctx2d.fill();
    ctx2d.fillStyle = '#fff'; ctx2d.textAlign = 'center';
    ctx2d.fillText(String(val), cx + lw + 10 + (w - lw - 14) / 2, cy + 11.5);
    ctx2d.restore();
  }

  // ---------- play ----------
  async function beginSong(n) {
    G.song = n;
    ensureCover(n);            // 結算畫面要用封面
    G.scene = 'loading';
    const seq = ++G.startSeq;
    const meta = CORE.songs[n - 1];
    G.level = levelOf(n, G.diff);
    G.ns = noteScoreFor(G.level);
    try {
      await startSong(n);
    } catch (e) {
      console.error(e);
      G.scene = 'menu';
      return;
    }
    if (seq !== G.startSeq) return;   // 中途被取消
    G.st = st();
    G.idx = 0;
    G.chart = CORE.charts[n - 1];
    G.score = 0; G.combo = 0; G.maxCombo = 0;
    G.cnt = { C: 0, P: 0, N: 0, T: 0, L: 0 };
    G.allConquer = true;
    G.notes = []; G.lanes = [[], [], [], [], [], []]; G.effects = []; G.taps = [];
    G.spawnDone = false;
    G.endAt = Infinity; G.resultAt = Infinity;
    G.ninjaNext = (G.diff === 4 && meta.nj) ? rand(0, 1) : Infinity;
    G.scene = 'play';
  }
  function backToMenu() {
    G.startSeq++;
    stopSong();
    G.scene = 'menu';
  }

  function spawnNote(lane) {
    const note = { lane, ts: songTime(), gone: false };
    G.notes.push(note);
    G.lanes[lane].push(note);
  }
  function judgeText(j) { return ['judge1', 'judge2', 'judge3', 'judge4', 'judge5'][j]; }
  function applyJudge(j) { // 0 C,1 P,2 N,3 T,4 L  (判定縣 COMBLE 積木)
    if (j === 0) { G.cnt.C++; G.combo++; G.score = Math.floor(G.score + G.ns); }
    if (j === 1) { G.cnt.P++; G.combo++; G.score = Math.floor(G.score + G.ns * 0.8); G.allConquer = false; }
    if (j === 2) { G.cnt.N++; G.score = Math.floor(G.score + G.ns * 0.5); G.allConquer = false; }
    if (j === 3) { G.cnt.T++; G.combo = 0; G.allConquer = false; }
    if (j === 4) { G.cnt.L++; G.combo = 0; G.allConquer = false; }
    if (G.combo > G.maxCombo) G.maxCombo = G.combo;
    G.effects.push({ kind: 'pop', judge: j, t0: performance.now() / 1000 });
  }
  function noteY(note, t) {
    const p = (t - note.ts) / G.st;
    if (p <= 1) return SPAWN_Y - TRAVEL * p;
    // 滑行結束後:5 影格(30fps)往下掉 SPEED px/影格,然後 Lost
    const over = (t - note.ts - G.st) * 30;
    return LINE_Y - Math.min(5, over) * G.speed;
  }
  function noteAlpha(note, t) {
    const over = (t - note.ts - G.st) * 30;
    if (over <= 0) return 1;
    return Math.max(0, 1 - over * 0.2);
  }

  function keyHit(lane) {
    if (G.scene !== 'play') return;
    // 總是記錄按鍵確認點（無論有無命中音符）
    G.taps.push({ lane, t0: performance.now() / 1000 });
    const q = G.lanes[lane];
    if (!q.length) return;
    const t = songTime();
    const note = q[0];                       // 只判定最舊的(該死a/分身影 機制)
    const distMs = Math.abs(noteY(note, t) - LINE_Y) * G.st / 0.32;
    let j = -1;
    if (distMs < 40) j = 0; else if (distMs < 60) j = 1;
    else if (distMs < 85) j = 2; else if (distMs < 100) j = 3;
    if (j < 0) return;                       // 窗外:按了沒事
    q.shift(); note.gone = true;
    applyJudge(j);
    G.effects.push({ kind: 'flash', lane, t0: performance.now() / 1000 });
  }

  function tickPlay() {
    const t = songTime();
    const meta = CORE.songs[G.song - 1];
    // 生成(while:同影格可生成和弦)
    if (!G.spawnDone && G.chart) {
      const lead = G.st * 1.2;
      while (G.idx < G.chart.t.length && t > G.chart.t[G.idx] - lead) {
        const lane = (G.chart.k[G.idx] | 0) - 1;
        if (lane >= 0 && lane < 6) spawnNote(lane);
        G.idx += DIFF_STEP[G.diff - 1];
      }
      if (G.idx >= G.chart.t.length) {
        G.spawnDone = true;
        G.endAt = t + 2;                     // 原作:結束後等2秒
      }
    }
    // ninja(SCHIZO 隨機加註)
    if (t >= G.ninjaNext && !G.spawnDone) {
      const re = meta.nj ? meta.nj[1] : 3;
      const burst = randInt(1, re);
      for (let i = 0; i < burst; i++) spawnNote(randInt(0, 5));
      G.ninjaNext = t + rand(0, 1);
    }
    // 漏接
    for (let l = 0; l < 6; l++) {
      const q = G.lanes[l];
      while (q.length && (t - q[0].ts - G.st) * 30 > 5) {
        const n = q.shift(); n.gone = true;
        applyJudge(4);
      }
    }
    // 結束
    if (t >= G.endAt && G.scene === 'play') {
      G.scene = 'result';
      G.resultAt = performance.now() / 1000;
      // 全Conquer獎勵(判定縣 end 積木)
      if (G.cnt.P === 0 && G.cnt.N === 0 && G.cnt.T === 0 && G.cnt.L === 0 && G.diff !== 4)
        G.score = 1000000;
    }
  }

  function digits(val, n) {
    const s = String(Math.floor(Math.max(0, val)));
    const out = [];
    for (let p = n; p >= 1; p--) out.push(p <= s.length ? +s[s.length - p] : 0);
    return out;
  }
  function drawDigits(val, n, x, y, step, size, alpha) {
    const d = digits(val, n);
    for (let i = 0; i < n; i++) draw('digit' + d[i], x + step * i, y, size, alpha);
  }

  // 歌曲視覺干擾(SCHIZO/特定歌曲;近似重現主要幾種)
  function gimmickOffset(t) {
    const s = G.song, d = G.diff;
    let dx = 0, rot = 0, alpha = 1;
    if (s === 3) dx = (Math.random() < 0.25 ? rand(-50, 50) : rand(-20, 20));
    if (s === 12) rot = Math.sin(t * 13) * 20;
    if (s === 42) rot = (t * 270) % 360;
    if (s === 11 && d === 4) alpha = (Math.sin(t * 17) > -0.3 ? 1 : 0.15);
    if (s === 26) alpha = (Math.random() < 0.08 ? 0.4 : 1);
    return { dx, rot, alpha };
  }

  function drawPlay() {
    drawBG('bgPlay');
    const t = songTime();
    const gm = gimmickOffset(t);
    // 判定線 (y=-120, 全畫面延伸 + 打擊確認)
    ctx2d.save();
    const jlx1 = 240 + (-220), jlx2 = 240 + 180, jly = 180 - LINE_Y;
    ctx2d.shadowColor = 'rgba(255,255,255,.7)';
    ctx2d.shadowBlur = 6;
    ctx2d.strokeStyle = 'rgba(255,255,255,.9)';
    ctx2d.lineWidth = 2.5;
    ctx2d.beginPath();
    ctx2d.moveTo(jlx1, jly);
    ctx2d.lineTo(jlx2, jly);
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;
    ctx2d.strokeStyle = 'rgba(200,230,255,.95)';
    ctx2d.lineWidth = 1.2;
    ctx2d.beginPath();
    ctx2d.moveTo(jlx1, jly);
    ctx2d.lineTo(jlx2, jly);
    ctx2d.stroke();
    ctx2d.restore();
    // 按鍵確認點: 於判定線與軌道交點顯示打擊指示
    const now2 = performance.now() / 1000;
    for (const tp of G.taps) {
      const age = now2 - tp.t0;
      if (age > 0.2) continue;
      const k = 1 - age / 0.2;
      const lx = 240 + LANE_X[tp.lane], ly = jly;
      ctx2d.save();
      ctx2d.globalAlpha = k;
      ctx2d.shadowColor = 'rgba(255,255,200,.8)';
      ctx2d.shadowBlur = 8 * k;
      ctx2d.fillStyle = 'rgba(255,255,255,.35)';
      ctx2d.beginPath();
      ctx2d.arc(lx, ly, 14 * k, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.shadowBlur = 0;
      ctx2d.fillStyle = 'rgba(255,255,255,.7)';
      ctx2d.beginPath();
      ctx2d.arc(lx, ly, 5 * k, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.restore();
    }
    // notes
    for (const note of G.notes) {
      if (note.gone) continue;
      const y = noteY(note, t);
      const a = noteAlpha(note, t) * gm.alpha;
      if (a <= 0) continue;
      draw('note' + note.lane, LANE_X[note.lane] + gm.dx, y, 100, a, gm.rot);
    }
    G.notes = G.notes.filter(n => !n.gone || true); // keep; cleaned below
    if (G.notes.length > 400) G.notes = G.notes.filter(n => !n.gone);
    // effects
    const now = performance.now() / 1000;
    G.effects = G.effects.filter(e => now - e.t0 < 0.5);
    G.taps = G.taps.filter(tp => now - tp.t0 < 0.25);
    for (const e of G.effects) {
      const p = (now - e.t0);
      if (e.kind === 'flash') { // 特效X: size5→305, ghost0→100 (10影格)
        const k = Math.min(1, p / 0.33);
        draw('flash' + e.lane, LANE_X[e.lane], LINE_Y, 5 + 300 * k, 1 - k);
      } else {                  // 判定特效: (-10,-150)→(-10,-120) 0.15s, 再下落淡出
        let y, a;
        if (p < 0.15) { y = -150 + 30 * (p / 0.15); a = 0.7; }
        else { const k = Math.min(1, (p - 0.15) / 0.33); y = -120 - 20 * k; a = 0.7 - 0.5 * k; }
        draw(judgeText(e.judge), -10, y, 80, a);
      }
    }
    // HUD: 分數7位 (-224,147) 步距12 / COMBO5位 (-70,0) 步距30 size250 半透明置底
    drawDigits(G.combo, 5, -70, 0, 30, 250, 0.35);
    drawDigits(G.score, 7, -224, 147, 12, 100, 1);
  }

  function drawResult() {
    drawBG('bgPlay');
    const now = performance.now() / 1000;
    const dt = now - G.resultAt;
    // 徽章先停在判定線3秒(判定縣 end 積木)
    let badge = 'badge6';
    const c = G.cnt;
    if (c.N === 0 && c.T === 0 && c.L === 0) badge = (c.P === 0 ? 'badge3' : 'badge4');
    else badge = (G.score >= 695000 ? 'badge5' : 'badge6');
    if (dt < 3) {
      drawDigits(G.score, 7, -224, 147, 12, 100, 1);
      draw(badge, 0, LINE_Y, 100, 1);
      return;
    }
    draw('endFrame', 0, 0, 100, 1);
    // 計數面板(分數 sprite end 積木)
    drawDigits(c.C, 5, 35, 55, 20, 100, 1);
    drawDigits(c.P, 5, 35, 10, 20, 100, 1);
    drawDigits(c.N, 5, 35, -35, 20, 100, 1);
    drawDigits(c.T, 5, 35, -80, 20, 100, 1);
    drawDigits(c.L, 5, 35, -140, 20, 100, 1);
    drawDigits(G.maxCombo, 5, 143, 10, 20, 100, 1);
    drawDigits(G.score, 7, -223, 71, 20, 100, 1);
    // rank
    let rank = 'rank5';
    if (G.score >= 1000000) rank = 'rank0';
    else if (G.score >= 920000) rank = 'rank1';
    else if (G.score >= 850000) rank = 'rank2';
    else if (G.score >= 784000) rank = 'rank3';
    else if (G.score >= 695000) rank = 'rank4';
    const jig = rank === 'rank0' ? { x: rand(-3, 3), y: rand(-3, 3) } : { x: 0, y: 0 };
    draw(rank, 177 + jig.x, -120 + jig.y, 100, 1);
    draw('diffbadge' + G.diff, 173, 99, 100, 1);
    draw(badge, 6, 48, 150, 1);
    const cov = coverImgs[G.song];
    if (cov) {
      const s = 1.5;
      ctx2d.save(); ctx2d.translate(240 - 157, 180 + 16);
      ctx2d.drawImage(cov.im, -cov.cx * s, -cov.cy * s, cov.im.naturalWidth * s, cov.im.naturalHeight * s);
      ctx2d.restore();
    }
  }

  function drawLoading() {
    drawBG('bgMenu');
    ctx2d.save();
    ctx2d.fillStyle = 'rgba(8,10,16,.7)'; ctx2d.fillRect(0, 0, W, H);
    ctx2d.fillStyle = '#cfd5e3'; ctx2d.font = '16px sans-serif'; ctx2d.textAlign = 'center';
    ctx2d.fillText('載入歌曲中…', W / 2, H / 2);
    ctx2d.restore();
  }

  // ---------- input ----------
  const heldPage = { a: false, d: false };
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (G.scene === 'play') {
      const lane = KEYS.indexOf(k);
      if (lane >= 0 && !e.repeat) keyHit(lane);
      if (k === 'escape') backToMenu();
      return;
    }
    if (G.scene === 'result' && k === 'escape') { backToMenu(); return; }
    if (G.scene !== 'menu' || e.repeat) return;
    if (k === 'w') { G.speed += 1; }
    if (k === 's' && !heldPage.s) { G.speed = Math.max(1, G.speed - 1); }
    if (k === 'a' || k === 'd') {
      // 原作怪癖:SCHIZO 模式翻頁會切回 HELL
      if (G.diff === 4) G.diff = 3;
      G.page = (G.page + (k === 'd' ? 1 : -1) + 7) % 7;
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    if (G.scene !== 'menu') return;
    const pt = canvasPoint(e);
    for (const c of menuLayout()) {
      if (Math.abs(pt.x - (240 + c.x)) < 55 && Math.abs(pt.y - (180 - c.y)) < 45) { G.hoverSong = c.n; break; }
    }
  });
  canvas.addEventListener('click', (e) => {
    const pt = canvasPoint(e);
    if (G.scene === 'menu') {
      // 難度鈕
      const bb = imgBox(['btnHard', 'btnMaster', 'btnHell', 'btnSchizo'][G.diff - 1], 127, 148, 100);
      if (bb && pt.x >= bb.l && pt.x <= bb.r && pt.y >= bb.t && pt.y <= bb.b) {
        G.diff = G.diff % 4 + 1;
        return;
      }
      for (const c of menuLayout()) {
        if (Math.abs(pt.x - (240 + c.x)) < 55 && Math.abs(pt.y - (180 - c.y)) < 45) {
          const meta = CORE.songs[c.n - 1];
          if (G.diff === 4 && !meta.schizo) return;   // 無SCHIZO譜
          beginSong(c.n);
          return;
        }
      }
    } else if (G.scene === 'result') {
      const now = performance.now() / 1000;
      if (now - G.resultAt >= 3) backToMenu();
    }
  });
  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }

  // ---------- main loop ----------
  function frame() {
    ctx2d.clearRect(0, 0, W, H);
    if (G.scene === 'menu') drawMenu();
    else if (G.scene === 'loading') drawLoading();
    else if (G.scene === 'play') { tickPlay(); if (G.scene === 'play') drawPlay(); else drawResult(); }
    else if (G.scene === 'result') drawResult();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 預載第一頁封面
  for (const c of menuLayout()) ensureCover(c.n);
})();
