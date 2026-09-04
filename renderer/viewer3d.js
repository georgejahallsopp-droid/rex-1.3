// Built-in procedural 3D shape renderer - zero dependencies, always works.
// Draws a glowing HUD-style wireframe on a 2D canvas (the same technique
// as the main visualizer's core sphere), with mouse/touch orbit + wheel
// zoom. This is what "generate a 3d model of X" uses when no Meshy AI
// key is set, and is also the fallback if the AI path fails.

function mulberry32(seed) {
  let a = seed || 1;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const SHAPE_KEYWORDS = [
  { type: 'sphere', words: ['planet', 'globe', 'world', 'moon', 'ball', 'orb', 'sun', 'earth'] },
  { type: 'torus', words: ['ring', 'halo', 'saturn', 'donut', 'doughnut', 'loop'] },
  { type: 'icosahedron', words: ['crystal', 'diamond', 'gem', 'jewel', 'shard'] },
  { type: 'box', words: ['cube', 'box', 'core', 'block', 'container', 'crate'] },
  { type: 'molecule', words: ['atom', 'molecule', 'dna', 'cell', 'virus'] },
  { type: 'tower', words: ['tower', 'building', 'rocket', 'spire', 'antenna', 'skyscraper'] },
  { type: 'star', words: ['star', 'spike', 'burst', 'explosion', 'sun'] },
];
const ALL_TYPES = SHAPE_KEYWORDS.map((e) => e.type);

export function pickProceduralShape(prompt) {
  const p = String(prompt || '').toLowerCase();
  for (const entry of SHAPE_KEYWORDS) {
    if (entry.words.some((w) => p.includes(w))) {
      return { type: entry.type, seed: hashStr(p) };
    }
  }
  const seed = hashStr(p) || 1;
  const idx = seed % ALL_TYPES.length;
  return { type: ALL_TYPES[idx], seed };
}

function tinyRing(center, r) {
  const pts = [];
  for (let s = 0; s <= 16; s++) {
    const a = (s / 16) * Math.PI * 2;
    pts.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r, center[2]]);
  }
  return [{ pts, closed: true, bright: true }];
}

function sphereLines() {
  const groups = [];
  const LONG = 9,
    LAT = 5,
    SEG = 36;
  for (let a = 0; a < LONG; a++) {
    const lon = (a / LONG) * Math.PI * 2;
    const pts = [];
    for (let s = 0; s <= SEG; s++) {
      const t = (s / SEG) * Math.PI - Math.PI / 2;
      pts.push([Math.cos(t) * Math.cos(lon), Math.sin(t), Math.cos(t) * Math.sin(lon)]);
    }
    groups.push({ pts });
  }
  for (let a = 1; a < LAT; a++) {
    const t = (a / LAT) * Math.PI - Math.PI / 2;
    const rad = Math.cos(t),
      y = Math.sin(t);
    const pts = [];
    for (let s = 0; s <= SEG; s++) {
      const lon = (s / SEG) * Math.PI * 2;
      pts.push([rad * Math.cos(lon), y, rad * Math.sin(lon)]);
    }
    groups.push({ pts, closed: true });
  }
  return groups;
}

function torusLines() {
  const groups = [];
  const MAJOR = 20,
    R = 1,
    r = 0.38,
    SEG = 24;
  for (let m = 0; m < MAJOR; m++) {
    const theta = (m / MAJOR) * Math.PI * 2;
    const cx = Math.cos(theta) * R,
      cz = Math.sin(theta) * R;
    const pts = [];
    for (let s = 0; s <= SEG; s++) {
      const phi = (s / SEG) * Math.PI * 2;
      const radial = Math.cos(phi) * r;
      const y = Math.sin(phi) * r;
      pts.push([cx + Math.cos(theta) * radial, y, cz + Math.sin(theta) * radial]);
    }
    groups.push({ pts, closed: true });
  }
  return groups;
}

function icosahedronLines() {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts = raw.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  });
  const edges = [
    [0, 11], [0, 5], [0, 1], [0, 7], [0, 10],
    [1, 5], [5, 11], [11, 10], [10, 7], [7, 1],
    [3, 9], [3, 4], [3, 2], [3, 6], [3, 8],
    [4, 9], [9, 8], [8, 6], [6, 2], [2, 4],
    [1, 9], [5, 4], [11, 2], [10, 6], [7, 8],
  ];
  return edges.map(([a, b]) => ({ pts: [verts[a], verts[b]], thick: true }));
}

function boxLines() {
  const groups = [];
  const s = 0.85;
  const v = [];
  for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) v.push([x, y, z]);
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      let diff = 0;
      for (let k = 0; k < 3; k++) if (v[i][k] !== v[j][k]) diff++;
      if (diff === 1) groups.push({ pts: [v[i], v[j]], thick: true });
    }
  }
  return groups;
}

function moleculeLines(seed) {
  const groups = [];
  const rnd = mulberry32(seed);
  const n = 5 + Math.floor(rnd() * 3);
  const satellites = [];
  for (let i = 0; i < n; i++) {
    const theta = rnd() * Math.PI * 2,
      phi = Math.acos(2 * rnd() - 1);
    const r = 0.75 + rnd() * 0.35;
    satellites.push([r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)]);
  }
  for (const sat of satellites) groups.push({ pts: [[0, 0, 0], sat], thick: true });
  for (let i = 0; i < satellites.length; i++) {
    const j = (i + 1) % satellites.length;
    if (rnd() > 0.4) groups.push({ pts: [satellites[i], satellites[j]] });
  }
  groups.push(...tinyRing([0, 0, 0], 0.16));
  for (const sat of satellites) groups.push(...tinyRing(sat, 0.1));
  return groups;
}

function towerLines() {
  const groups = [];
  const levels = 6;
  const ringAt = (i) => {
    const y = -0.9 + (i / (levels - 1)) * 1.8;
    const r = 0.85 - Math.abs(y) * 0.25;
    return { y, r };
  };
  for (let i = 0; i < levels; i++) {
    const { y, r } = ringAt(i);
    const pts = [];
    for (let s = 0; s <= 24; s++) {
      const a = (s / 24) * Math.PI * 2;
      pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    groups.push({ pts, closed: true });
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const pts = [];
    for (let i = 0; i < levels; i++) {
      const { y, r } = ringAt(i);
      pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    groups.push({ pts, thick: true });
  }
  return groups;
}

function starLines(seed) {
  const groups = [];
  const rnd = mulberry32(seed);
  const n = 8 + Math.floor(rnd() * 5);
  const tips = [];
  for (let i = 0; i < n; i++) {
    const theta = rnd() * Math.PI * 2,
      phi = Math.acos(2 * rnd() - 1);
    tips.push([Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)]);
  }
  for (const tp of tips) groups.push({ pts: [[0, 0, 0], tp], thick: true, bright: true });
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      const d = Math.hypot(tips[i][0] - tips[j][0], tips[i][1] - tips[j][1], tips[i][2] - tips[j][2]);
      if (d < 0.9) {
        groups.push({ pts: [tips[i].map((v) => v * 0.5), tips[j].map((v) => v * 0.5)] });
      }
    }
  }
  return groups;
}

function buildShapeLines(spec) {
  switch (spec.type) {
    case 'sphere':
      return sphereLines();
    case 'torus':
      return torusLines();
    case 'icosahedron':
      return icosahedronLines();
    case 'box':
      return boxLines();
    case 'molecule':
      return moleculeLines(spec.seed);
    case 'tower':
      return towerLines();
    case 'star':
      return starLines(spec.seed);
    default:
      return icosahedronLines();
  }
}

function rotatePoint(p, ry, rx) {
  const [x, y, z] = p;
  const cosY = Math.cos(ry),
    sinY = Math.sin(ry);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const cosX = Math.cos(rx),
    sinX = Math.sin(rx);
  const y1 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  return [x1, y1, z2];
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

export function initViewer3D(canvas, shapeSpec) {
  const ctx = canvas.getContext('2d');
  let running = true;
  let rotY = 0.5,
    rotX = -0.35;
  let autoRotate = true;
  let zoom = 1;
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const lines = buildShapeLines(shapeSpec);

  let dragging = false,
    lastX = 0,
    lastY = 0;
  const pt = (e) => (e.touches && e.touches[0] ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY });
  const onDown = (e) => {
    dragging = true;
    autoRotate = false;
    const p = pt(e);
    lastX = p.x;
    lastY = p.y;
  };
  const onMove = (e) => {
    if (!dragging) return;
    const p = pt(e);
    rotY += (p.x - lastX) * 0.008;
    rotX += (p.y - lastY) * 0.008;
    rotX = Math.max(-1.3, Math.min(1.3, rotX));
    lastX = p.x;
    lastY = p.y;
  };
  const onUp = () => {
    dragging = false;
  };
  const onWheel = (e) => {
    e.preventDefault();
    zoom = Math.max(0.5, Math.min(2.5, zoom - e.deltaY * 0.001));
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const w = canvas.width,
      h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2,
      cy = h / 2;
    const R = Math.min(w, h) * 0.32 * zoom;
    if (autoRotate) rotY += 0.0045;

    const accent = cssVar('--accent', '#35f4e0');
    const accent2 = cssVar('--accent-2', '#8ffff2');

    ctx.save();
    ctx.translate(cx, cy);

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.7);
    grad.addColorStop(0, 'rgba(53,244,224,.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2);
    ctx.fill();

    for (const group of lines) {
      const pts = group.pts.map((p) => rotatePoint(p, rotY, rotX));
      ctx.beginPath();
      pts.forEach((p, i) => {
        const scale = (p[2] + 2.1) / 3;
        const x = p[0] * R * scale,
          y = p[1] * R * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (group.closed) ctx.closePath();
      ctx.strokeStyle = group.bright ? '#ffffff' : accent2;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = (group.thick ? 2.0 : 1.2) * dpr;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 8 * dpr;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, R * 0.05, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 16 * dpr;
    ctx.fill();

    ctx.restore();
  }
  requestAnimationFrame(frame);

  return {
    dispose() {
      running = false;
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('touchstart', onDown);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
