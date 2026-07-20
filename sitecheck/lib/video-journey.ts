// lib/video-journey.ts — stitch the per-pillar recording .webm files into one
// downloadable "Video Journey", with a title card before each pillar segment.
//
// Uses the full ffmpeg binary from `ffmpeg-static` (the ffmpeg Playwright
// bundles is a stripped VP8-only build with no concat support). Title cards are
// rendered to PNG with puppeteer (already a dependency) so we don't depend on
// ffmpeg's drawtext/font handling. All inputs are normalised to 1280×720/30fps
// and concatenated with the concat filter, then encoded to a single VP8 .webm.

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

// Recorded pillars, in order. Mirrors the `record` slugs in PILLAR_CHECKS
// (lib/engine/index.ts) — kept local so this module doesn't pull the whole
// engine (and playwright) into the API-route bundle.
const RECORDED_PILLARS: { slug: string; number: number; name: string }[] = [
  { slug: 'pillar1', number: 1, name: 'Discovery & Access' },
  { slug: 'pillar2', number: 2, name: 'Accessibility & Inclusion' },
  { slug: 'pillar3', number: 3, name: 'Website Structure' },
  { slug: 'pillar4', number: 4, name: 'Navigation' },
  { slug: 'pillar5', number: 5, name: 'Registration' },
  { slug: 'pillar7', number: 7, name: 'Performance & Stability' },
  { slug: 'pillar8', number: 8, name: 'Customer Privacy' },
];

const TITLE_SECONDS = 2.5;
// Per-input normalisation so image cards and VFR pillar clips concat cleanly.
const NORMALISE =
  'fps=30,scale=1280:720:force_original_aspect_ratio=decrease,' +
  'pad=1280:720:-1:-1:color=0x0B1220,setsar=1,format=yuv420p';

export interface VideoJourneyResult {
  status: 'ok' | 'no-videos';
  /** Web path to the combined video, e.g. /screenshots/<id>/video-journey.webm */
  relPath?: string;
  /** Absolute path on disk (present when status === 'ok'). */
  absPath?: string;
  /** Pillar numbers included, in order. */
  pillars?: number[];
}

function screenshotsDir(auditJobId: string): string {
  return path.join(process.cwd(), 'public', 'screenshots', auditJobId);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

function titleCardHtml(number: number, name: string, entityName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}
    .card{width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:Segoe UI,Arial,sans-serif;color:#fff;
      background:radial-gradient(1200px 600px at 50% 20%,#1e3a8a 0%,#0b1220 60%)}
    .kicker{font-size:34px;letter-spacing:.35em;text-transform:uppercase;color:#93c5fd;margin-bottom:18px}
    .num{font-size:150px;font-weight:800;line-height:1;margin:0}
    .name{font-size:64px;font-weight:600;margin-top:8px;text-align:center;max-width:1100px}
    .entity{font-size:30px;color:#cbd5e1;margin-top:40px}
    .brand{position:absolute;bottom:40px;font-size:24px;letter-spacing:.2em;color:#64748b}
  </style></head><body>
    <div class="card">
      <div class="kicker">SiteCheck &middot; Pillar</div>
      <h1 class="num">${number}</h1>
      <div class="name">${escapeHtml(name)}</div>
      <div class="entity">${escapeHtml(entityName)}</div>
      <div class="brand">EVIDENCE JOURNEY</div>
    </div>
  </body></html>`;
}

async function renderTitleCards(
  cards: { pngAbs: string; number: number; name: string }[],
  entityName: string,
): Promise<void> {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    for (const c of cards) {
      await page.setContent(titleCardHtml(c.number, c.name, entityName), { waitUntil: 'domcontentloaded' });
      await page.screenshot({ path: c.pngAbs as `${string}.png`, type: 'png' });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// Resolve the ffmpeg binary. The path exported by ffmpeg-static is computed
// from __dirname and breaks once Next bundles this module into .next/server,
// so fall back to the real node_modules location (and an env override).
function resolveFfmpeg(): string | null {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegStatic as unknown as string | null,
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', exe),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpeg();
  if (!bin) {
    return Promise.reject(new Error('ffmpeg binary not found (ffmpeg-static). Run `npm install`.'));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

/**
 * Build (or reuse a cached) combined video for an audit job. Concatenates the
 * present pillar recordings in order, each preceded by a title card. Returns
 * `{ status: 'no-videos' }` when the job has no recorded pillar videos.
 */
export async function buildVideoJourney(
  auditJobId: string,
  entityName: string,
): Promise<VideoJourneyResult> {
  const dir = screenshotsDir(auditJobId);
  const segments = RECORDED_PILLARS.filter((p) => fs.existsSync(path.join(dir, `${p.slug}.webm`)));
  if (segments.length === 0) return { status: 'no-videos' };

  const outAbs = path.join(dir, 'video-journey.webm');
  const outRel = `/screenshots/${auditJobId}/video-journey.webm`;
  const pillars = segments.map((s) => s.number);

  // Cache: reuse if the combined file is newer than every source clip.
  if (fs.existsSync(outAbs)) {
    const outM = fs.statSync(outAbs).mtimeMs;
    const newestSrc = Math.max(
      ...segments.map((s) => fs.statSync(path.join(dir, `${s.slug}.webm`)).mtimeMs),
    );
    if (outM >= newestSrc) return { status: 'ok', relPath: outRel, absPath: outAbs, pillars };
  }

  // Render one title card PNG per included pillar.
  const titlePngs = segments.map((_, i) => path.join(dir, `._vj_title_${i}.png`));
  await renderTitleCards(
    segments.map((s, i) => ({ pngAbs: titlePngs[i], number: s.number, name: s.name })),
    entityName || 'Website Audit',
  );

  try {
    // Interleave [title, pillar] inputs; normalise each; concat all.
    const inputArgs: string[] = [];
    const filterParts: string[] = [];
    const concatIn: string[] = [];
    let idx = 0;
    for (let i = 0; i < segments.length; i++) {
      inputArgs.push('-loop', '1', '-t', String(TITLE_SECONDS), '-i', titlePngs[i]);
      filterParts.push(`[${idx}:v]${NORMALISE}[v${idx}]`);
      concatIn.push(`[v${idx}]`);
      idx++;
      inputArgs.push('-i', path.join(dir, `${segments[i].slug}.webm`));
      filterParts.push(`[${idx}:v]${NORMALISE}[v${idx}]`);
      concatIn.push(`[v${idx}]`);
      idx++;
    }
    const filterComplex = `${filterParts.join(';')};${concatIn.join('')}concat=n=${idx}:v=1:a=0[outv]`;

    const args = [
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-an',
      '-c:v', 'libvpx',
      '-b:v', '1500k',
      '-deadline', 'good',
      '-cpu-used', '4',
      '-pix_fmt', 'yuv420p',
      outAbs,
    ];
    await runFfmpeg(args);
  } finally {
    await Promise.all(titlePngs.map((p) => fsp.unlink(p).catch(() => {})));
  }

  return { status: 'ok', relPath: outRel, absPath: outAbs, pillars };
}
