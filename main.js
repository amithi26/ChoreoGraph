// ═══════════════════════════════════════════════
//  VIBE CONDUCTOR
//  Tone.js-powered real-time gesture composer
// ═══════════════════════════════════════════════

// In main.js
// Add this at the VERY TOP of main.js
window.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById('splash');
  const enterBtn = document.getElementById('enter-btn');

  if (enterBtn) {
    enterBtn.onclick = async () => {
      // 1. Initialize Tone.js (Must happen on user click)
      await Tone.start();
      
      // 2. Run your app setup functions
      if (typeof buildSynths === "function") buildSynths();
      isReady = true;
      
      // 3. Smoothly exit the splash
      splash.classList.add('fade-out');
      
      // 4. Remove from DOM after transition so it doesn't block clicks
      setTimeout(() => {
        splash.style.display = 'none';
      }, 1000);
    };
  }
});

const canvas   = document.getElementById('drawing-canvas');
const ctx      = canvas.getContext('2d');
const video    = document.getElementById('bg-video');
const sceneBtn = document.getElementById('scene-btn');
const scrubber = document.getElementById('timeline-scrubber');
const timeDisp = document.getElementById('time-display');
const hint     = document.getElementById('hint');
const stage    = document.getElementById('stage');
const playhead = document.getElementById('playhead');
const controls = document.getElementById('controls');
const uploadBtn = document.getElementById('upload-btn');
const uploadInput = document.getElementById('video-upload');
const previewBtn = document.getElementById('preview-btn');
const playerModal = document.getElementById('player-modal');
const previewVideo = document.getElementById('preview-video');
const closePlayer = document.getElementById('close-player');

let isPreviewOpen = false;
let isSyncingPreview = false;

// ── CONFIG ──────────────────────────────────────
const PIXELS_PER_SECOND = 180;
const NOTE_NAMES = ['C3','D3','E3','G3','A3','C4','D4','E4','G4','A4','C5','D5','E5','G5'];

const BRUSH = {
  orchestral: { color: '#f0c040', shadow: 'rgba(240,192,64,0.4)',   size: 5 },
  electronic: { color: '#40e0f0', shadow: 'rgba(64,224,240,0.5)',   size: 3 },
  ethereal:   { color: '#d080ff', shadow: 'rgba(200,120,255,0.35)', size: 8 }
};

const NOTE_GAP   = { orchestral: 220, electronic: 55, ethereal: 190 };
const lastNoteAt = { orchestral: 0,   electronic: 0,  ethereal: 0   };

// ── STATE ────────────────────────────────────────
let isReady          = false;
let isDrawing        = false;
let currentBrush     = 'orchestral';
let strokes          = [];
let beats            = [];
let lastPos          = null;
let lastMoveTime     = 0;
let hintHidden       = false;
let synths           = {};
let currentStrokeId  = 0;
let currentStrokeLen = 0;
let pitchShift       = 0;
let isErasing        = false;

const ERASER_RADIUS  = 28;
const eraserCursor   = document.getElementById('eraser-cursor');

// ── SYNTHS ───────────────────────────────────────
function buildSynths() {
  // MASTER CHAIN: Heavy low-pass filter removes harshness → EQ smooths bass → Compressor → Reverb → Destination
  const masterHPF = new Tone.Filter({ frequency: 50, type: 'highpass', rolloff: -12 }).toDestination();
  const masterEQ = new Tone.EQ3({ lowFrequency: 180, highFrequency: 2500, low: 6, mid: -1, high: -8 }).connect(masterHPF);
  const masterComp = new Tone.Compressor({ threshold: -18, ratio: 2.5, attack: 0.005, release: 0.15 }).connect(masterEQ);
  const masterReverb = new Tone.Reverb({ decay: 1.8, wet: 0.28 }).connect(masterComp);
  
  const delay = new Tone.FeedbackDelay('32n', 0.08).connect(masterReverb);

  // ORCHESTRAL SYNTH — Warm, smooth, no harshness
  const strFilter  = new Tone.Filter({ frequency: 1600, type: 'lowpass', rolloff: -24 }).connect(masterReverb);
  const strVibrato = new Tone.Vibrato({ frequency: 5.2, depth: 0.06, wet: 0.5 }).connect(strFilter);
  synths.orchestral = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
    envelope:   { attack: 0.35, decay: 0.08, sustain: 0.8, release: 1.8 },
    volume: -8
  }).connect(strVibrato);

  // ELECTRONIC SYNTH — Punchy and bright
  synths.electronic = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'square' },
    envelope:   { attack: 0.008, decay: 0.1, sustain: 0.25, release: 0.3 },
    volume: -9
  }).connect(delay);

  // ETHEREAL SYNTH — Gentle and floating
  synths.ethereal = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.18, decay: 0.45, sustain: 0.6, release: 2.0 },
    volume: -5
  }).connect(masterReverb);

  // KICK: Deep, warm, bassy 808 — no artifacts or crunchiness
  const kickFilter = new Tone.Filter({ frequency: 800, type: 'lowpass', rolloff: -24 }).connect(masterComp);
  const kickEQ = new Tone.EQ3({ lowFrequency: 150, highFrequency: 2200, low: 10, mid: -6, high: -10 }).connect(kickFilter);
  const kickComp = new Tone.Compressor({ threshold: -12, ratio: 5, attack: 0.002, release: 0.14 }).connect(kickEQ);
  synths.kick = new Tone.MembraneSynth({
    pitchDecay:  0.12,
    octaves:     5,
    envelope:    { attack: 0.001, decay: 0.6, sustain: 0, release: 0.12 },
    volume:      10
  }).connect(kickComp);
}

// ── NOTE TRIGGER ─────────────────────────────────
function triggerNote(yRatio, speed, brush) {
  if (!isReady) return;
  const now = performance.now();
  if (now - lastNoteAt[brush] < NOTE_GAP[brush]) return;
  lastNoteAt[brush] = now;

  const idx        = Math.round(Math.max(0, Math.min(1, yRatio)) * (NOTE_NAMES.length - 1));
  const shiftedIdx = Math.max(0, Math.min(NOTE_NAMES.length - 1, idx + pitchShift));
  const note       = NOTE_NAMES[shiftedIdx];
  const vel        = Math.min(1, 0.28 + speed * 0.22);
  const dur        = Math.max(0.1, 0.72 - speed * 0.16);

  synths[brush].triggerAttackRelease(note, dur, Tone.now(), vel);

  if (speed > 1.1 && shiftedIdx + 2 < NOTE_NAMES.length) {
    synths[brush].triggerAttackRelease(
      NOTE_NAMES[shiftedIdx + 2], dur, Tone.now() + 0.03, vel * 0.6
    );
  }
}

// ── BEAT ─────────────────────────────────────────
function dropBeat() {
  if (!isReady) return;
  synths.kick.triggerAttackRelease(Tone.Frequency('C1').transpose(pitchShift).toNote(), '8n', Tone.now());
  beats.push({ worldX: video.currentTime * PIXELS_PER_SECOND, played: true });
}

// ── BRUSH RENDERERS ──────────────────────────────

// STRINGS: organic multi-strand
function renderStrings(c, sx, sy, prevSx, prevSy, speed, t) {
  if (prevSx === null) return;

  const angle  = Math.atan2(sy - prevSy, sx - prevSx);
  const perp   = angle + Math.PI / 2;
  const px     = Math.cos(perp);
  const py     = Math.sin(perp);
  const spread = Math.max(6, Math.min(18, 14 - speed * 3));

  const strands = [
    { off: -spread * 2.2, w: 1.5, a: 0.3  },
    { off: -spread * 1.1, w: 2.5, a: 0.55 },
    { off: -spread * 0.3, w: 3.5, a: 0.85 },
    { off:  spread * 0.3, w: 3.5, a: 0.85 },
    { off:  spread * 1.1, w: 2.5, a: 0.55 },
    { off:  spread * 2.2, w: 1.5, a: 0.3  },
  ];

  c.save();
  c.lineCap     = 'round';
  c.lineJoin    = 'round';
  c.shadowColor = 'rgba(240,192,64,0.35)';

  for (const s of strands) {
    const wobble = Math.sin(sx * 0.04 + s.off) * 0.6;
    const ox  = px * (s.off + wobble);
    const oy  = py * (s.off + wobble);
    const pox = px * (s.off + Math.sin(prevSx * 0.04 + s.off) * 0.6);
    const poy = py * (s.off + Math.sin(prevSx * 0.04 + s.off) * 0.6);
    c.globalAlpha = s.a;
    c.strokeStyle = Math.abs(s.off) < spread * 0.5 ? '#fff5c0' : '#e8b830';
    c.shadowBlur  = Math.abs(s.off) < spread * 0.5 ? 8 : 2;
    c.lineWidth   = s.w;
    c.beginPath();
    c.moveTo(prevSx + pox, prevSy + poy);
    c.lineTo(sx    + ox,   sy    + oy);
    c.stroke();
  }
  c.restore();
}

// ELECTRONIC: upright squares
function renderElectronic(c, sx, sy, speed, idx) {
  if (idx % 2 !== 0) return;
  const size = Math.max(7, Math.min(16, 10 - speed * 1.2));
  c.save();
  c.globalAlpha = 0.88;
  c.strokeStyle = '#40e0f0';
  c.shadowColor = 'rgba(64,224,240,0.8)';
  c.shadowBlur  = 10;
  c.lineWidth   = 1.5;
  c.strokeRect(sx - size / 2, sy - size / 2, size, size);
  c.globalAlpha = 0.5;
  c.fillStyle   = '#ffffff';
  c.shadowBlur  = 0;
  c.beginPath();
  c.arc(sx, sy, 1.5, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

// ETHEREAL: soft diffuse radial blobs
function renderEthereal(c, sx, sy, speed) {
  const r = Math.max(18, Math.min(55, 30 + (1 - Math.min(speed, 2) / 2) * 25));
  c.save();
  const grad = c.createRadialGradient(sx, sy, 0, sx, sy, r);
  grad.addColorStop(0,   'rgba(210,140,255,0.22)');
  grad.addColorStop(0.4, 'rgba(180,100,255,0.12)');
  grad.addColorStop(1,   'rgba(140,60,220,0)');
  c.fillStyle   = grad;
  c.shadowColor = 'rgba(200,120,255,0.3)';
  c.shadowBlur  = 30;
  c.beginPath();
  c.arc(sx, sy, r, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = 0.55;
  const inner = c.createRadialGradient(sx, sy, 0, sx, sy, r * 0.3);
  inner.addColorStop(0, 'rgba(255,220,255,0.9)');
  inner.addColorStop(1, 'rgba(200,120,255,0)');
  c.fillStyle  = inner;
  c.shadowBlur = 0;
  c.beginPath();
  c.arc(sx, sy, r * 0.3, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

// ── DRAW ONE POINT ────────────────────────────────
function drawPoint(c, sx, sy, prevSx, prevSy, p, globalIdx) {
  if (p.brush === 'orchestral') {
    const TAPER_LEN = 18;
    const fromStart = p.strokePos - 1;
    const strokeEnd = p.strokeLen > 0 ? p.strokeLen : currentStrokeLen;
    const fromEnd   = strokeEnd - p.strokePos;
    const t         = Math.min(fromStart / TAPER_LEN, fromEnd / TAPER_LEN, 1);
    renderStrings(c, sx, sy, prevSx, prevSy, p.speed, t);
  } else if (p.brush === 'electronic') {
    renderElectronic(c, sx, sy, p.speed, p.strokePos);
  } else if (p.brush === 'ethereal') {
    renderEthereal(c, sx, sy, p.speed);
  }
}

// ── RENDER LOOP ───────────────────────────────────
function drawBeatMarker(sx) {
  ctx.save();
  ctx.strokeStyle = '#ff5530';
  ctx.shadowColor = 'rgba(255,85,48,0.8)';
  ctx.shadowBlur  = 14;
  ctx.lineWidth   = 2;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(sx, 0);
  ctx.lineTo(sx, canvas.height);
  ctx.stroke();
  const cy = canvas.height * 0.5;
  const s  = 7;
  ctx.fillStyle   = '#ff5530';
  ctx.shadowBlur  = 18;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(sx,     cy - s);
  ctx.lineTo(sx + s, cy);
  ctx.lineTo(sx,     cy + s);
  ctx.lineTo(sx - s, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderStrokes() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const playheadX = video.currentTime * PIXELS_PER_SECOND;
  const cx        = canvas.width / 2;

  // Beat markers
  for (let i = 0; i < beats.length; i++) {
    const b  = beats[i];
    const sx = cx + (b.worldX - playheadX);
    if (sx > -20 && sx < canvas.width + 20) drawBeatMarker(sx);
    if (!video.paused && !isDrawing) {
      if (Math.abs(sx - cx) < 5) {
        if (!b.played) { synths.kick.triggerAttackRelease(Tone.Frequency('C1').transpose(pitchShift).toNote(), '8n', Tone.now()); b.played = true; }
      } else if (sx < cx - 10) {
        b.played = false;
      }
    }
  }

  // Strokes
  for (let i = 0; i < strokes.length; i++) {
    const p      = strokes[i];
    const sx     = cx + (p.worldX - playheadX);
    const prevSx = p.prevWorldX !== null ? cx + (p.prevWorldX - playheadX) : null;
    if (sx < -100 || sx > canvas.width + 100) continue;
    drawPoint(ctx, sx, p.worldY, prevSx, p.prevWorldY, p, i);
    if (!isDrawing && !video.paused && Math.abs(sx - cx) < 4) {
      triggerNote(p.vol, p.speed * 0.45, p.brush);
    }
  }
}

// ── INPUT ────────────────────────────────────────
function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function onStart(e) {
  if (!isReady || playerModal.style.display === 'flex') return;
  if (currentBrush === 'eraser') {
    isErasing = true;
    hideHint();
    return;
  }
  isDrawing        = true;
  lastPos          = getPos(e);
  lastMoveTime     = performance.now();
  currentStrokeId++;
  currentStrokeLen = 0;
  hideHint();
}

function onMove(e) {
  // Update eraser cursor position always when in eraser mode
  if (currentBrush === 'eraser') {
    const pos = getPos(e);
    eraserCursor.style.left   = pos.x + 'px';
    eraserCursor.style.top    = pos.y + 'px';
    eraserCursor.style.width  = (ERASER_RADIUS * 2) + 'px';
    eraserCursor.style.height = (ERASER_RADIUS * 2) + 'px';
    eraserCursor.style.display = 'block';

    if (isErasing && isReady && playerModal.style.display !== 'flex') {
      e.preventDefault();
      const cx        = canvas.width / 2;
      const playheadX = video.currentTime * PIXELS_PER_SECOND;
      strokes = strokes.filter(p => {
        const sx = cx + (p.worldX - playheadX);
        const dy = p.worldY - pos.y;
        const dx = sx - pos.x;
        return (dx * dx + dy * dy) > (ERASER_RADIUS * ERASER_RADIUS);
      });
    }
    return;
  }

  if (!isDrawing || !isReady || playerModal.style.display === 'flex') return;
  e.preventDefault();

  const pos   = getPos(e);
  const now   = performance.now();
  const dt    = Math.max(1, now - lastMoveTime);
  const dist  = Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y);
  const speed = dist / dt;

  const yRatio     = 1 - pos.y / canvas.height;
  const worldX     = (video.currentTime * PIXELS_PER_SECOND) + (pos.x - canvas.width / 2);
  const worldY     = pos.y;
  const prevWorldX = lastPos ? (video.currentTime * PIXELS_PER_SECOND) + (lastPos.x - canvas.width / 2) : null;
  const prevWorldY = lastPos ? lastPos.y : null;

  triggerNote(yRatio, speed, currentBrush);
  currentStrokeLen++;

  const p = {
    worldX, worldY, prevWorldX, prevWorldY,
    vol: yRatio, speed,
    brush: currentBrush,
    strokeId:  currentStrokeId,
    strokePos: currentStrokeLen,
    strokeLen: 0
  };
  strokes.push(p);

  const cx        = canvas.width / 2;
  const playheadX = video.currentTime * PIXELS_PER_SECOND;
  const sx        = cx + (worldX - playheadX);
  const prevSx    = prevWorldX !== null ? cx + (prevWorldX - playheadX) : null;
  drawPoint(ctx, sx, worldY, prevSx, prevWorldY, p, strokes.length - 1);

  lastPos      = pos;
  lastMoveTime = now;
}

function onEnd() {
  if (isErasing) { isErasing = false; return; }
  if (!isDrawing) return;
  const id = currentStrokeId;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].strokeId !== id) break;
    strokes[i].strokeLen = currentStrokeLen;
  }
  isDrawing = false;
  lastPos   = null;
}

canvas.addEventListener('mousedown',  onStart);
canvas.addEventListener('mousemove',  onMove);
canvas.addEventListener('mouseup',    onEnd);
canvas.addEventListener('mouseleave', (e) => {
  eraserCursor.style.display = 'none';
  onEnd(e);
});
canvas.addEventListener('touchstart', onStart, { passive: false });
canvas.addEventListener('touchmove',  onMove,  { passive: false });
canvas.addEventListener('touchend',   onEnd);

// ── ANIMATION LOOP ────────────────────────────────
function animate() {
  renderStrokes();
  requestAnimationFrame(animate);
}

// ── VIDEO / SCRUBBER ─────────────────────────────
function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
video.addEventListener('loadedmetadata', () => scrubber.max = video.duration);
video.addEventListener('timeupdate', () => {
  if (!isDrawing) scrubber.value = video.currentTime;
  timeDisp.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration || 0)}`;
  if (playerModal.style.display === 'flex' && Math.abs(previewVideo.currentTime - video.currentTime) > 0.08) {
    previewVideo.currentTime = video.currentTime;
  }
  if (playerModal.style.display === 'flex' && video.paused) {
    previewVideo.pause();
  }
});
scrubber.addEventListener('input', () => video.currentTime = scrubber.value);

previewVideo.addEventListener('timeupdate', () => {
  if (playerModal.style.display === 'flex' && Math.abs(video.currentTime - previewVideo.currentTime) > 0.08) {
    video.currentTime = previewVideo.currentTime;
  }
});
previewVideo.addEventListener('pause', () => {
  if (playerModal.style.display === 'flex' && !video.paused) video.pause();
});
previewVideo.addEventListener('play', () => {
  if (playerModal.style.display === 'flex' && video.paused) video.play();
});

// ── SHORTCUTS & GESTURES ─────────────────────────
function togglePlayPause() {
  if (!isReady) return;
  if (video.paused) { video.play();  sceneBtn.textContent = 'Pause Scene'; }
  else              { video.pause(); sceneBtn.textContent = 'Play Scene';  }
}

document.addEventListener('keydown', (e) => {
  if (!isReady) return;
  if (e.code === 'Escape' && playerModal.style.display === 'flex') {
    previewVideo.pause();
    playerModal.style.display = 'none';
    e.preventDefault();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  switch (e.code) {
    case 'Space':      e.preventDefault(); togglePlayPause(); break;
    case 'ArrowLeft':  e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 5)); break;
    case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + (e.shiftKey ? 1 : 5)); break;
    case 'ArrowUp':
      e.preventDefault();
      pitchShift = Math.min(24, pitchShift + 1);
      pitchSlider.value = pitchShift;
      pitchDisplay.textContent = `Pitch  ${pitchShift > 0 ? '+' : ''}${pitchShift}`;
      break;
    case 'ArrowDown':
      e.preventDefault();
      pitchShift = Math.max(-24, pitchShift - 1);
      pitchSlider.value = pitchShift;
      pitchDisplay.textContent = `Pitch  ${pitchShift > 0 ? '+' : ''}${pitchShift}`;
      break;
    case 'Home': case 'Numpad0': case 'Digit0': e.preventDefault(); video.currentTime = 0; break;
    case 'End':        e.preventDefault(); video.currentTime = video.duration || 0; break;
    case 'Delete': case 'Backspace': e.preventDefault(); strokes = []; beats = []; break;
    case 'KeyB':       dropBeat(); break;
    case 'Digit1':     document.querySelector('[data-brush="orchestral"]').click(); break;
    case 'Digit2':     document.querySelector('[data-brush="electronic"]').click(); break;
    case 'Digit3':     document.querySelector('[data-brush="ethereal"]').click(); break;
    case 'KeyE':       document.querySelector('[data-brush="eraser"]').click(); break;
  }
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (delta / canvas.width) * (video.duration || 60) * 0.5));
}, { passive: false });

// ── TRANSPORT ────────────────────────────────────
sceneBtn.addEventListener('click', () => togglePlayPause());

previewBtn.addEventListener('click', () => {
  if (!isReady) return;
  previewVideo.src = video.currentSrc || video.src;
  previewVideo.muted = true;
  previewVideo.currentTime = video.currentTime;
  previewVideo.play().catch(() => {});
  if (video.paused) {
    video.play();
    sceneBtn.textContent = 'Pause Scene';
  }
  playerModal.style.display = 'flex';
});

closePlayer.addEventListener('click', () => {
  previewVideo.pause();
  playerModal.style.display = 'none';
});

playerModal.addEventListener('click', (e) => {
  if (e.target === playerModal || e.target.classList.contains('player-backdrop')) {
    previewVideo.pause();
    playerModal.style.display = 'none';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && playerModal.style.display === 'flex') {
    previewVideo.pause();
    playerModal.style.display = 'none';
  }
});

uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  strokes = [];
  beats = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  scrubber.value = 0;
  timeDisp.textContent = '00:00 / 00:00';
  hint.classList.remove('gone');
  hintHidden = false;
});

document.getElementById('beat-btn').addEventListener('click', dropBeat);

document.getElementById('clear-btn').addEventListener('click', () => {
  strokes = [];
  beats   = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// ── PITCH SLIDER ─────────────────────────────────
const pitchSlider  = document.getElementById('pitch-slider');
const pitchDisplay = document.getElementById('pitch-display');
pitchSlider.addEventListener('input', () => {
  pitchShift = parseInt(pitchSlider.value);
  pitchDisplay.textContent = `Pitch  ${pitchShift > 0 ? '+' : ''}${pitchShift}`;
});

// ── BRUSH BUTTONS ─────────────────────────────────
document.querySelectorAll('.brush-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.brush-btn.active').classList.remove('active');
    btn.classList.add('active');
    currentBrush = btn.dataset.brush;
    if (currentBrush === 'eraser') {
      canvas.style.cursor = 'none';
    } else {
      canvas.style.cursor = '';
      eraserCursor.style.display = 'none';
    }
  });
});

// ── SPLASH ───────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', async () => {
  await Tone.start();
  buildSynths();
  isReady = true;
  const splash = document.getElementById('splash');
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 900);
});

function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hint.classList.add('gone');
}

// ── RESIZE ────────────────────────────────────────
function resize() {
  canvas.width  = stage.clientWidth;
  canvas.height = stage.clientHeight;
}
window.addEventListener('resize', resize);
resize();
animate();