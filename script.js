(() => {
  "use strict";

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);

  /* =========================================================
     Swarm: one set of particles that redraws itself per section
     ========================================================= */
  const canvas = $("#swarm");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  const mobile = () => window.innerWidth < 860;
  const N = mobile() ? 800 : 2400;

  const P = new Float32Array(N * 6); // x, y, vx, vy, k(spring), size
  const tx = new Float32Array(N), ty = new Float32Array(N), ta = new Float32Array(N);
  const grp = new Int8Array(N); // -1 none, >=0 graph node index
  const alpha = new Float32Array(N);

  // per-shape local data
  const sphere = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    sphere[i * 3] = Math.cos(th) * r; sphere[i * 3 + 1] = y; sphere[i * 3 + 2] = Math.sin(th) * r;
  }
  const jitter = new Float32Array(N * 2).map(() => Math.random() - 0.5);
  const phase = new Float32Array(N).map(() => Math.random() * TAU);

  let graphPts = null, graphBox = { w: 0, h: 0 };
  let shape = "orb", anchorEl = null, theme = "dark";
  let colorMix = 0, colorTarget = 0; // 0 = light particles (dark ground), 1 = ink particles
  let activeNode = 0;
  const pointer = { x: -9999, y: -9999 };

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, mobile() ? 1 : 1.5);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    graphPts = null;
  }

  // init scattered
  function seed() {
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      P[o] = rand(0, W); P[o + 1] = rand(0, H); P[o + 2] = 0; P[o + 3] = 0;
      P[o + 4] = rand(0.035, 0.075); P[o + 5] = Math.random() < 0.12 ? 2 : (Math.random() < 0.5 ? 1.4 : 1.1);
      alpha[i] = 0;
    }
  }

  /* ---- text sampling for graph labels ---- */
  const off = document.createElement("canvas");
  const octx = off.getContext("2d", { willReadFrequently: true });
  function sampleText(text, size, step) {
    octx.font = `600 ${size}px "General Sans", sans-serif`;
    const tw = Math.ceil(octx.measureText(text).width) + 4, th = Math.ceil(size * 1.3);
    off.width = tw; off.height = th;
    octx.font = `600 ${size}px "General Sans", sans-serif`;
    octx.fillStyle = "#fff"; octx.textBaseline = "middle";
    octx.fillText(text, 2, th / 2);
    const d = octx.getImageData(0, 0, tw, th).data, pts = [];
    for (let y = 0; y < th; y += step) for (let x = 0; x < tw; x += step) if (d[(y * tw + x) * 4 + 3] > 120) pts.push([x - tw / 2, y - th / 2]);
    return pts;
  }

  const NODES = ["Recorder", "Engine", "Model", "Middleware", "Website"];
  const nodeEls = $$(".eco__graph .node");
  function buildGraph(w, h) {
    const narrow = w < 520;
    const nodes = NODES.map((label, i) => {
      const t = i / (NODES.length - 1);
      const m = narrow ? 0 : 80;
      const x = narrow ? (i % 2 ? 0.68 : 0.32) * w : m + t * (w - 2 * m);
      const y = narrow ? (0.1 + t * 0.8) * h : (i % 2 ? 0.7 : 0.3) * h;
      const el = nodeEls[i];
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      const bw = el.offsetWidth + (narrow ? 30 : 40), bh = el.offsetHeight + (narrow ? 22 : 28);
      return { x, y, bw, bh, text: [] };
    });
    const pts = []; // [x, y, group]
    nodes.forEach((n, gi) => {
      // pill outline
      const r = n.bh / 2, straight = n.bw - n.bh, per = 2 * straight + TAU * r;
      const count = Math.round(per / 2.6);
      for (let k = 0; k < count; k++) {
        let s = (k / count) * per, x, y;
        if (s < straight) { x = -straight / 2 + s; y = -r; }
        else if ((s -= straight) < Math.PI * r) { const a = -Math.PI / 2 + s / r; x = straight / 2 + Math.cos(a) * r; y = Math.sin(a) * r; }
        else if ((s -= Math.PI * r) < straight) { x = straight / 2 - s; y = r; }
        else { s -= straight; const a = Math.PI / 2 + s / r; x = -straight / 2 + Math.cos(a) * r; y = Math.sin(a) * r; }
        pts.push([n.x + x, n.y + y, gi]);
      }
      n.text.forEach(([x, y]) => pts.push([n.x + x, n.y + y, gi]));
    });
    // edges
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const startOff = narrow ? a.bh * 0.6 : a.bw / 2 + 6, endOff = narrow ? b.bh * 0.6 : b.bw / 2 + 6;
      for (let s = startOff; s < len - endOff; s += 3.2) pts.push([a.x + ux * s, a.y + uy * s, -1]);
    }
    // loose glow around nodes with the remainder
    return { pts, nodes };
  }

  /* ---- hero device: a laptop with a dashboard, detail ranked so it can be shed ---- */
  let devicePts = null, deviceBox = { w: 0, h: 0 };
  function buildDevice(w, h) {
    const pts = []; // [x, y, priority] 0 = outline (never shed), 1 = layout, 2 = detail
    const sw = Math.min(w * 0.8, h * 1.2), sh = sw * 0.6;
    const x0 = (w - sw) / 2, y0 = (h - sh) / 2 - sh * 0.06;
    const rect = (x, y, rw, rh, step, pr) => {
      for (let s = 0; s < rw; s += step) { pts.push([x + s, y, pr]); pts.push([x + s, y + rh, pr]); }
      for (let s = 0; s < rh; s += step) { pts.push([x, y + s, pr]); pts.push([x + rw, y + s, pr]); }
    };
    const fill = (x, y, rw, rh, step, pr) => { for (let yy = y; yy < y + rh; yy += step) for (let xx = x; xx < x + rw; xx += step) pts.push([xx, yy, pr]); };
    rect(x0, y0, sw, sh, 3.2, 0); // lid
    rect(x0 + 10, y0 + 10, sw - 20, sh - 20, 7, 1); // bezel
    // base
    const bw = sw * 1.16, bx = (w - bw) / 2, by = y0 + sh + 4;
    for (let s = 0; s < bw; s += 2.6) pts.push([bx + s, by + 8, 0]);
    for (let s = 0; s < sw; s += 3) pts.push([x0 + s, by, 1]);
    // dashboard inside the screen
    const ix = x0 + 22, iy = y0 + 22, iw = sw - 44, ih = sh - 44;
    fill(ix, iy, iw, 6, 5, 1); // top bar
    rect(ix, iy + 18, iw * 0.18, ih - 18, 6, 1); // sidebar
    fill(ix + 8, iy + 30, iw * 0.18 - 16, ih - 44, 12, 2); // sidebar items
    const cx = ix + iw * 0.22, cw = iw * 0.78;
    const cardW = (cw - 16) / 3;
    for (let c = 0; c < 3; c++) { rect(cx + c * (cardW + 8), iy + 18, cardW, ih * 0.28, 4, 1); fill(cx + c * (cardW + 8) + 8, iy + 28, cardW - 16, ih * 0.28 - 20, 8, 2); }
    // chart panel with a line
    const py = iy + 26 + ih * 0.28, ph = ih - (py - iy);
    rect(cx, py, cw, ph, 4, 1);
    for (let s = 0; s < cw - 16; s += 2.2) pts.push([cx + 8 + s, py + ph * 0.55 + Math.sin(s * 0.035) * ph * 0.22 + Math.sin(s * 0.11) * ph * 0.06, 2]);
    fill(cx + 8, py + 10, cw - 16, ph - 20, 12, 2);
    return pts.sort((a, b) => a[2] - b[2]);
  }

  /* ---- About: a chip, nodding to the IoT side ---- */
  let chipPts = null, chipBox = { w: 0 };
  function buildChip(w, h) {
    const pts = [], s = Math.min(w, h) * 0.62, x0 = (w - s) / 2, y0 = (h - s) / 2;
    for (let k = 0; k < s; k += 2.4) { pts.push([x0 + k, y0]); pts.push([x0 + k, y0 + s]); pts.push([x0, y0 + k]); pts.push([x0 + s, y0 + k]); }
    const pins = 7, gap = s / (pins + 1), len = s * 0.14;
    for (let p = 1; p <= pins; p++) for (let k = 0; k < len; k += 2.4) {
      pts.push([x0 + p * gap, y0 - 6 - k]); pts.push([x0 + p * gap, y0 + s + 6 + k]);
      pts.push([x0 - 6 - k, y0 + p * gap]); pts.push([x0 + s + 6 + k, y0 + p * gap]);
    }
    const inner = s * 0.5, ix = x0 + (s - inner) / 2, iy = y0 + (s - inner) / 2;
    for (let yy = 0; yy < inner; yy += 7) for (let xx = 0; xx < inner; xx += 7) pts.push([ix + xx, iy + yy]);
    for (let a = 0; a < TAU; a += 0.3) pts.push([x0 + 16 + Math.cos(a) * 5, y0 + 16 + Math.sin(a) * 5]);
    return pts;
  }

  /* ---- pressure level: frame timing, plus PressureObserver where supported ---- */
  const LEVELS = ["nominal", "fair", "serious", "critical"];
  const KEEP = [[1, 1, 1], [1, 1, 0.45], [1, 0.55, 0], [1, 0.15, 0]];
  let level = 0, frameLevel = 0, observerLevel = 0, ema = 16.7, lastT = 0, lastLevelChange = 0;
  const levelEl = $("[data-level]"), levelDot = $("[data-level-dot]");
  const LEVEL_TEXT = ["Your device: nominal, full detail", "Your device: fair, shedding detail", "Your device: serious, layout only", "Your device: critical, outline only"];
  if ("PressureObserver" in window) {
    try {
      const po = new PressureObserver((recs) => { const r = recs[recs.length - 1]; observerLevel = Math.max(0, LEVELS.indexOf(r.state)); });
      po.observe("cpu").catch(() => {});
    } catch (e) { /* unsupported */ }
  }
  function updateLevel(t) {
    if (lastT) ema += ((t - lastT) - ema) * 0.05;
    lastT = t;
    frameLevel = ema > 40 ? 3 : ema > 28 ? 2 : ema > 21 ? 1 : 0;
    const want = Math.max(frameLevel, observerLevel);
    if (want !== level && t - lastLevelChange > 1200) {
      level = want; lastLevelChange = t;
      if (levelEl) levelEl.textContent = mobile() ? LEVEL_TEXT[level].replace("Your device: ", "Device: ") : LEVEL_TEXT[level];
      if (levelDot) levelDot.dataset.level = level;
    }
  }
  const keepHash = new Float32Array(N).map((_, i) => ((i * 2654435761) % 1000) / 1000);

  /* ---- Work: a mark per project, drawn when the visitor points at it ---- */
  let activeMarkEl = null; const markCache = new Map();
  function buildMark(name, s) {
    const p = [];
    const line = (x1, y1, x2, y2, st = 2.4) => { const L = Math.hypot(x2 - x1, y2 - y1); for (let d = 0; d <= L; d += st) p.push([x1 + (x2 - x1) * d / L, y1 + (y2 - y1) * d / L]); };
    const arc = (cx, cy, r, a0 = 0, a1 = TAU, st = 2.4) => { for (let a = a0; a <= a1; a += st / r) p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); };
    const box = (x, y, w, h, st) => { line(x, y, x + w, y, st); line(x + w, y, x + w, y + h, st); line(x + w, y + h, x, y + h, st); line(x, y + h, x, y, st); };
    const u = s / 10;
    switch (name) {
      case "receipt": {
        line(2 * u, u, 8 * u, u); line(2 * u, u, 2 * u, 8.6 * u); line(8 * u, u, 8 * u, 8.6 * u);
        for (let k = 0; k < 6; k++) { const x = 2 * u + k * u; line(x, 8.6 * u, x + 0.5 * u, 9.2 * u); line(x + 0.5 * u, 9.2 * u, x + u, 8.6 * u); }
        [2.6, 3.8, 5, 6.2].forEach((y, i) => line(3 * u, y * u, (i === 3 ? 5 : 7) * u, y * u, 3));
        line(5.6 * u, 7.4 * u, 7 * u, 7.4 * u, 2); break;
      }
      case "scout": { arc(4.2 * u, 4.2 * u, 2.8 * u); arc(4.2 * u, 4.2 * u, 1.6 * u, Math.PI * 1.1, Math.PI * 1.6, 3); line(6.3 * u, 6.3 * u, 9 * u, 9 * u, 2); line(6.6 * u, 6 * u, 9.3 * u, 8.7 * u, 2); break; }
      case "match": { arc(3.5 * u, 5 * u, 2.4 * u); arc(6.5 * u, 5 * u, 2.4 * u); arc(3.5 * u, 4.2 * u, 0.7 * u); arc(6.5 * u, 4.2 * u, 0.7 * u); arc(3.5 * u, 6.6 * u, 1.1 * u, Math.PI * 1.05, Math.PI * 1.95, 2.6); arc(6.5 * u, 6.6 * u, 1.1 * u, Math.PI * 1.05, Math.PI * 1.95, 2.6); break; }
      case "cap": { line(5 * u, 2 * u, 9.4 * u, 4 * u); line(9.4 * u, 4 * u, 5 * u, 6 * u); line(5 * u, 6 * u, 0.6 * u, 4 * u); line(0.6 * u, 4 * u, 5 * u, 2 * u); line(2.6 * u, 5 * u, 2.6 * u, 7.6 * u); line(7.4 * u, 5 * u, 7.4 * u, 7.6 * u); arc(5 * u, 7.6 * u, 2.4 * u, 0, Math.PI, 2.6); line(9.4 * u, 4 * u, 9.4 * u, 7 * u, 2); arc(9.4 * u, 7.3 * u, 0.3 * u); break; }
      case "phone": { box(3 * u, 0.8 * u, 4 * u, 8.4 * u, 2.4); line(4.4 * u, 1.6 * u, 5.6 * u, 1.6 * u, 2); arc(5 * u, 8.4 * u, 0.35 * u); for (let y = 3; y <= 6.6; y += 1.2) line(3.7 * u, y * u, (y % 2.4 < 1 ? 6.3 : 5.3) * u, y * u, 3); break; }
      case "server": { [1.2, 4.1, 7].forEach((y) => { box(1.6 * u, y * u, 6.8 * u, 2.2 * u, 2.4); arc(2.8 * u, (y + 1.1) * u, 0.35 * u); line(5 * u, (y + 1.1) * u, 7.4 * u, (y + 1.1) * u, 3); }); break; }
    }
    return p;
  }

  function anchorRect() {
    if (!anchorEl) return { left: 0, top: 0, width: W, height: H };
    return anchorEl.getBoundingClientRect();
  }

  function setTargets(t) {
    const r = anchorRect();
    const isDark = theme === "dark";
    if (r.width < 2 || r.height < 2) { for (let i = 0; i < N; i++) { tx[i] = P[i * 6]; ty[i] = P[i * 6 + 1]; ta[i] = 0; } return; }
    switch (shape) {
      case "device": {
        if (!devicePts || Math.abs(deviceBox.w - r.width) > 2 || Math.abs(deviceBox.h - r.height) > 2) {
          devicePts = buildDevice(r.width, r.height); deviceBox = { w: r.width, h: r.height };
        }
        const M = devicePts.length, keep = KEEP[level];
        const sway = reduce ? 0 : Math.sin(t * 0.0006) * 4;
        for (let i = 0; i < N; i++) {
          grp[i] = -1;
          if (i < M) {
            const p = devicePts[i];
            tx[i] = r.left + p[0]; ty[i] = r.top + p[1] + sway;
            ta[i] = keepHash[i] < keep[p[2]] ? (p[2] === 0 ? 0.95 : p[2] === 1 ? 0.7 : 0.45) : 0;
          } else {
            // spare particles drift as dust around the device and are the first thing shed
            const a = phase[i] + (reduce ? 0 : t * 0.00015);
            tx[i] = r.left + r.width / 2 + Math.cos(a) * r.width * (0.45 + jitter[i * 2] * 0.3);
            ty[i] = r.top + r.height / 2 + Math.sin(a * 1.3) * r.height * (0.45 + jitter[i * 2 + 1] * 0.3);
            ta[i] = level === 0 ? 0.22 : 0;
          }
        }
        break;
      }
      case "chip": {
        if (!chipPts || Math.abs(chipBox.w - r.width) > 2) { chipPts = buildChip(r.width, r.height); chipBox = { w: r.width }; }
        const M = chipPts.length;
        for (let i = 0; i < N; i++) {
          grp[i] = -1;
          if (i < M) { tx[i] = r.left + chipPts[i][0]; ty[i] = r.top + chipPts[i][1]; ta[i] = 0.85; }
          else { ta[i] = 0; }
        }
        break;
      }
      case "orb":
      case "mini": {
        const big = shape === "orb";
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const rad = Math.min(r.width, r.height) * (big ? 0.42 : 0.4);
        const rot = reduce ? 0.6 : t * 0.00012, tilt = 0.38;
        const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
        const every = big ? 1 : Math.ceil(N / 900);
        for (let i = 0; i < N; i++) {
          if (i % every) { ta[i] = 0; continue; }
          let x = sphere[i * 3], y = sphere[i * 3 + 1], z = sphere[i * 3 + 2];
          const x1 = x * cr + z * sr, z1 = -x * sr + z * cr;
          const y1 = y * ct - z1 * st, z2 = y * st + z1 * ct;
          const breathe = big ? 1 + Math.sin(t * 0.0009 + phase[i]) * 0.025 : 1;
          tx[i] = cx + x1 * rad * breathe + jitter[i * 2] * (big ? 10 : 4);
          ty[i] = cy + y1 * rad * breathe + jitter[i * 2 + 1] * (big ? 10 : 4);
          ta[i] = 0.25 + (z2 + 1) * 0.37;
          grp[i] = -1;
        }
        break;
      }
      case "graph": {
        if (!graphPts || Math.abs(graphBox.w - r.width) > 2 || Math.abs(graphBox.h - r.height) > 2) {
          graphPts = buildGraph(r.width, r.height); graphBox = { w: r.width, h: r.height };
        }
        const pts = graphPts.pts, M = pts.length, nodes = graphPts.nodes;
        for (let i = 0; i < N; i++) {
          if (i < M) {
            const p = pts[i];
            const wob = reduce ? 0 : Math.sin(t * 0.002 + phase[i]) * 0.6;
            tx[i] = r.left + p[0] + wob; ty[i] = r.top + p[1] + wob;
            grp[i] = p[2]; ta[i] = p[2] === -1 ? 0.55 : 0.95;
          } else {
            // drifting dust gathered around the active node
            const n = nodes[activeNode], a = phase[i] + (reduce ? 0 : t * 0.0004 * (1 + (i % 5) * 0.2));
            const rr = n.bw * 0.55 + 10 + ((i * 37) % 60);
            tx[i] = r.left + n.x + Math.cos(a) * rr; ty[i] = r.top + n.y + Math.sin(a) * rr * 0.55;
            grp[i] = activeNode; ta[i] = 0.16;
          }
        }
        break;
      }
      case "field": {
        const rows = mobile() ? 12 : 16, cols = Math.floor(N / rows);
        const top = H * (mobile() ? 0.82 : theme === "light" ? 0.78 : 0.7), depth = H * (mobile() ? 0.22 : 0.32), dim = (mobile() ? 0.5 : 1) * (theme === "light" ? 0.4 : 1);
        for (let i = 0; i < N; i++) {
          const row = Math.floor(i / cols), col = i % cols;
          if (row >= rows) { ta[i] = 0; continue; }
          const z = row / (rows - 1); // 0 far, 1 near
          const spread = 0.55 + z * 0.9;
          const x = W / 2 + ((col / (cols - 1)) - 0.5) * W * spread;
          const wave = reduce ? 0 : Math.sin(col * 0.11 + t * 0.0012 + row * 0.5) * (6 + z * 16);
          tx[i] = x; ty[i] = top + Math.pow(z, 1.6) * depth + wave;
          ta[i] = (0.12 + z * 0.55) * dim * (activeMarkEl ? 0.45 : 1); grp[i] = -1;
        }
        if (activeMarkEl) {
          const mr = activeMarkEl.getBoundingClientRect(), ms = Math.min(mr.width, mr.height);
          const key = activeMarkEl.dataset.mark + ":" + Math.round(ms);
          if (!markCache.has(key)) markCache.set(key, buildMark(activeMarkEl.dataset.mark, ms));
          const pts = markCache.get(key), ox = mr.left + (mr.width - ms) / 2, oy = mr.top + (mr.height - ms) / 2;
          const bob = reduce ? 0 : Math.sin(t * 0.002) * 2;
          for (let k = 0; k < pts.length && k < N; k++) { const i = N - 1 - k; tx[i] = ox + pts[k][0]; ty[i] = oy + pts[k][1] + bob; ta[i] = 0.9; }
        }
        break;
      }
      case "ring": {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const base = r.width * 0.5;
        const rot = reduce ? 0 : t * 0.00025;
        for (let i = 0; i < N; i++) {
          const band = i % 3;
          const a = (i / N) * TAU * 3 + rot * (band === 1 ? -1 : 1);
          const rr = base * (1.35 + band * 0.32) + jitter[i * 2] * 14;
          tx[i] = cx + Math.cos(a) * rr; ty[i] = cy + Math.sin(a) * rr;
          ta[i] = 0.2 + (2 - band) * 0.22; grp[i] = -1;
        }
        break;
      }
      default: // none: fade where they are
        for (let i = 0; i < N; i++) { tx[i] = P[i * 6]; ty[i] = P[i * 6 + 1] - 0.3; ta[i] = 0; grp[i] = -1; }
    }
    if (!isDark && !["mini", "chip", "field"].includes(shape)) for (let i = 0; i < N; i++) ta[i] = 0;
  }

  // colour buckets
  const BUCKETS = 6;
  const buckets = Array.from({ length: BUCKETS * 2 }, () => []);
  function frame(t) {
    updateLevel(t);
    setTargets(t);
    colorMix += (colorTarget - colorMix) * 0.08;
    const L = Math.round(236 + (18 - 236) * colorMix);
    const base = `${L},${Math.round(235 + (18 - 235) * colorMix)},${Math.round(230 + (18 - 230) * colorMix)}`;
    const accent = "154,163,255";

    ctx.clearRect(0, 0, W, H);
    buckets.forEach((b) => (b.length = 0));
    const repel = shape === "orb";
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      let x = P[o], y = P[o + 1], vx = P[o + 2], vy = P[o + 3];
      const k = reduce ? 1 : P[o + 4];
      if (reduce) { x = tx[i]; y = ty[i]; vx = vy = 0; }
      else {
        vx += (tx[i] - x) * k; vy += (ty[i] - y) * k;
        if (repel) {
          const dx = x - pointer.x, dy = y - pointer.y, d2 = dx * dx + dy * dy;
          if (d2 < 9000) { const f = (1 - d2 / 9000) * 3.2; const d = Math.sqrt(d2) || 1; vx += (dx / d) * f; vy += (dy / d) * f; }
        }
        vx *= 0.82; vy *= 0.82; x += vx; y += vy;
      }
      P[o] = x; P[o + 1] = y; P[o + 2] = vx; P[o + 3] = vy;
      alpha[i] += (ta[i] - alpha[i]) * (reduce ? 1 : 0.06);
      if (alpha[i] < 0.02 || x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
      const isAccent = shape === "graph" && grp[i] === activeNode;
      const bi = Math.min(BUCKETS - 1, Math.floor(alpha[i] * BUCKETS));
      buckets[bi + (isAccent ? BUCKETS : 0)].push(i);
    }
    for (let b = 0; b < BUCKETS * 2; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      const a = ((b % BUCKETS) + 0.5) / BUCKETS;
      ctx.fillStyle = `rgba(${b >= BUCKETS ? accent : base},${a.toFixed(2)})`;
      const cap = shape === "graph" ? 1.3 : 9;
      for (const i of list) { const o = i * 6, s = Math.min(P[o + 5], cap); ctx.fillRect(P[o] - s / 2, P[o + 1] - s / 2, s, s); }
    }
    if (reduce) return;
    if (document.hidden) { paused = true; return; }
    let idle = shape === "none";
    if (idle) for (let i = 0; i < N; i += 7) if (alpha[i] > 0.02) { idle = false; break; }
    if (idle) setTimeout(() => requestAnimationFrame(frame), 300); else requestAnimationFrame(frame);
  }
  let paused = false;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && paused) { paused = false; requestAnimationFrame(frame); } });

  function setSection(sec) {
    const s = sec.dataset.shape || "none";
    theme = sec.dataset.theme;
    colorTarget = theme === "light" ? 1 : 0;
    shape = s;
    anchorEl = sec.querySelector("[data-anchor]") || sec;
    if (reduce) requestAnimationFrame(frame);
  }

  resize(); seed();
  window.addEventListener("resize", () => { resize(); });
  window.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { pointer.x = e.clientX; pointer.y = e.clientY; } }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.x = pointer.y = -9999; });

  /* ---- active section ---- */
  const sections = $$(".sec");
  const dockLinks = $$(".dock a");
  let current = null;
  function pickSection() {
    const mid = H * 0.5;
    let best = sections[0];
    for (const s of sections) { const r = s.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) { best = s; break; } }
    if (best !== current) {
      current = best; setSection(best);
      dockLinks.forEach((a) => a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + best.id)));
    }
  }
  window.addEventListener("scroll", pickSection, { passive: true });
  pickSection();
  if (document.fonts) document.fonts.ready.then(() => { graphPts = null; });
  requestAnimationFrame(frame);

  /* ---- Work marks: hover or focus on desktop, centred row on touch screens ---- */
  const projects = $$(".project");
  const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (canHover) {
    projects.forEach((p) => {
      const m = p.querySelector(".project__mark");
      p.addEventListener("mouseenter", () => (activeMarkEl = m));
      p.addEventListener("mouseleave", () => { if (activeMarkEl === m) activeMarkEl = null; });
      p.addEventListener("focusin", () => (activeMarkEl = m));
      p.addEventListener("focusout", () => { if (activeMarkEl === m) activeMarkEl = null; });
    });
  } else {
    const pickProject = () => {
      if (!current || current.id !== "work") { activeMarkEl = null; return; }
      const mid = H * 0.45; let hit = null;
      for (const p of projects) { const r = p.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) { hit = p; break; } }
      activeMarkEl = hit ? hit.querySelector(".project__mark") : null;
    };
    window.addEventListener("scroll", pickProject, { passive: true });
  }

  /* =========================================================
     EcoShift stages: auto-advance until the visitor picks one
     ========================================================= */
  const eco = $("#ecoshift");
  const stages = $$(".stage");
  const STAGE_MS = 5200;
  eco.style.setProperty("--stage-ms", STAGE_MS + "ms");
  let stageTimer = null, userPicked = false;
  function pickStage(i, fromUser) {
    activeNode = i;
    nodeEls.forEach((el, j) => el.classList.toggle("is-active", i === j));
    stages.forEach((s, j) => { s.setAttribute("aria-pressed", String(i === j)); });
    if (fromUser) { userPicked = true; eco.classList.add("is-paused"); clearInterval(stageTimer); }
  }
  stages.forEach((s, i) => {
    s.addEventListener("click", () => pickStage(i, true));
    s.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (i + d + stages.length) % stages.length;
      pickStage(n, true); stages[n].focus();
    });
  });
  pickStage(0, false);
  if (!reduce) {
    const ecoIO = new IntersectionObserver(([en]) => {
      clearInterval(stageTimer);
      if (en.isIntersecting && !userPicked) {
        stageTimer = setInterval(() => {
          const n = (activeNode + 1) % stages.length;
          stages.forEach((s) => s.setAttribute("aria-pressed", "false"));
          void eco.offsetWidth; // restart the fill animation
          pickStage(n, false);
        }, STAGE_MS);
      }
    }, { threshold: 0.35 });
    ecoIO.observe(eco);
  } else eco.classList.add("is-paused");

  /* =========================================================
     Dot-matrix numerals
     ========================================================= */
  function drawDotNum(cv, progress = 1) {
    const text = cv.dataset.value;
    const h = cv.clientHeight || 70;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fs = h * 1.18;
    octx.font = `600 ${fs}px "General Sans", sans-serif`;
    const w = Math.ceil(octx.measureText(text).width * 1.02);
    off.width = w; off.height = h;
    octx.font = `600 ${fs}px "General Sans", sans-serif`;
    octx.fillStyle = "#000"; octx.textBaseline = "alphabetic";
    octx.fillText(text, 0, h * 0.98);
    const data = octx.getImageData(0, 0, w, h).data;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px";
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = getComputedStyle(cv).color || "#121212";
    const step = Math.max(4, Math.round(h / 15));
    let idx = 0;
    for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
      if (data[(Math.floor(y) * w + Math.floor(x)) * 4 + 3] > 100) {
        idx++;
        if (((idx * 2654435761) % 1000) / 1000 > progress) continue;
        c.beginPath(); c.arc(x, y, step * 0.36, 0, TAU); c.fill();
      }
    }
  }
  const dotnums = $$(".dotnum");
  function renderDots(p) { dotnums.forEach((cv) => drawDotNum(cv, p)); }
  const startDots = () => {
    if (reduce) return renderDots(1);
    const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 1100); renderDots(1 - Math.pow(1 - p, 3)); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
    renderDots(0);
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { startDots(); io.disconnect(); } }, { threshold: 0.4 });
    io.observe($(".stats"));
  });
  window.addEventListener("resize", () => renderDots(1));

  /* =========================================================
     Clock (Asia/Colombo) and offset to London
     ========================================================= */
  const clockEls = $$("[data-clock]");
  const offsetEl = $("[data-offset]");
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit" });
  function tzOffset(tz) {
    const d = new Date();
    const s = d.toLocaleString("en-US", { timeZone: tz });
    return (new Date(s) - new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
  }
  function tick() {
    const t = fmt.format(new Date());
    clockEls.forEach((el) => (el.textContent = t));
    if (offsetEl) {
      const diff = tzOffset("Asia/Colombo") - tzOffset("Europe/London");
      const h = Math.floor(diff / 60), m = diff % 60;
      offsetEl.textContent = `${h} h${m ? " " + m + " min" : ""} ahead of London`;
    }
  }
  tick(); setInterval(tick, 15000);

  /* =========================================================
     Copy email
     ========================================================= */
  const copy = $("#copy-email");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(copy.dataset.email); copy.textContent = "Copied"; }
    catch { copy.textContent = "Select and copy"; }
    setTimeout(() => (copy.textContent = "Copy"), 2000);
  });
})();

/* Top bar: hide while scrolling down, return on scroll up or near the top */
(() => {
  const top = document.querySelector(".top");
  if (!top) return;
  let lastY = window.scrollY;
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    if (y < 120 || y < lastY - 4) top.classList.remove("is-away");
    else if (y > lastY + 4) top.classList.add("is-away");
    lastY = y;
  }, { passive: true });
  top.addEventListener("focusin", () => top.classList.remove("is-away"));
})();
