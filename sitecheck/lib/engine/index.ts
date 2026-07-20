// lib/engine/index.ts — Main Evaluation Orchestrator
// Launches Playwright, runs all pillar checks, saves results to DB

import path from 'path';
import fs from 'fs';
import type { CriterionResult, ProgressEvent, PillarCheckFn } from '@/lib/types';
import { CRITERIA, calculateTotalScore, calculatePillarScores } from '@/lib/scoring';
import { prisma } from '@/lib/prisma';
import { startPillarRecording } from '@/lib/engine/recording';

// Pillar check functions
import pillar1Discovery from '@/lib/engine/pillar1-discovery';
import pillar2Accessibility from '@/lib/engine/pillar2-accessibility';
import pillar3Structure from '@/lib/engine/pillar3-structure';
import pillar4Navigation from '@/lib/engine/pillar4-navigation';
import pillar5Registration from '@/lib/engine/pillar5-registration';
import pillar6Services from '@/lib/engine/pillar6-services';
import pillar7Performance from '@/lib/engine/pillar7-performance';
import pillar8Privacy from '@/lib/engine/pillar8-privacy';
import pillar9LiveChat from '@/lib/engine/pillar9-livechat';
import pillar10Enquiry from '@/lib/engine/pillar10-enquiry';

// ────────────────────────────────────────────────────────────
//  Pillar registry
// ────────────────────────────────────────────────────────────
// `beta` pillars need LLM installation/integration (not yet applied) — they are excluded from
// "Run All Pillars" and the completeness check, but remain runnable individually.
// `record` enables per-pillar screen recording: the engine runs the pillar in a dedicated
// context with recordVideo and saves /screenshots/<auditJobId>/<record>.webm.
// `skipInitialNav` skips the engine's pre-pillar visit to the target URL — for pillars
// (like Discovery) whose journey starts elsewhere, so the recording opens on the real action.
export const PILLAR_CHECKS: Array<{
  name: string;
  nameAR: string;
  fn: PillarCheckFn;
  beta?: boolean;
  record?: string;
  skipInitialNav?: boolean;
}> = [
  { name: 'Discovery & Access', nameAR: 'الاكتشاف والوصول', fn: pillar1Discovery, record: 'pillar1', skipInitialNav: true },
  { name: 'Accessibility & Inclusion', nameAR: 'إمكانية الوصول والشمولية', fn: pillar2Accessibility, record: 'pillar2' },
  { name: 'Website Structure', nameAR: 'هيكل الموقع', fn: pillar3Structure, record: 'pillar3' },
  { name: 'Navigation', nameAR: 'التنقل', fn: pillar4Navigation, record: 'pillar4' },
  { name: 'Registration', nameAR: 'التسجيل', fn: pillar5Registration, record: 'pillar5' },
  { name: 'Services', nameAR: 'الخدمات', fn: pillar6Services, beta: true },
  { name: 'Performance', nameAR: 'الأداء', fn: pillar7Performance, record: 'pillar7' },
  { name: 'Customer Privacy', nameAR: 'خصوصية العملاء', fn: pillar8Privacy, record: 'pillar8' },
  { name: 'Live Chat', nameAR: 'الدردشة المباشرة', fn: pillar9LiveChat, beta: true },
  { name: 'Enquiry Form Journey', nameAR: 'رحلة نموذج الاستفسار', fn: pillar10Enquiry, beta: true },
];

// ────────────────────────────────────────────────────────────
//  Browser launch (resilient)
//  Prefer a system-installed browser (Chrome, then Edge) before the bundled
//  Chromium. On Windows, Application Control / Smart App Control policies often
//  block Playwright's downloaded chrome-headless-shell.exe ("spawn UNKNOWN"),
//  while the signed system browsers in Program Files are allowed.
// ────────────────────────────────────────────────────────────
async function launchBrowser(
  playwright: typeof import('playwright'),
): Promise<import('playwright').Browser> {
  const attempts: Array<{ label: string; opts: import('playwright').LaunchOptions }> = [
    { label: 'system Chrome', opts: { headless: true, channel: 'chrome' } },
    { label: 'system Edge', opts: { headless: true, channel: 'msedge' } },
    { label: 'bundled Chromium', opts: { headless: true } },
  ];
  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const browser = await playwright.chromium.launch(attempt.opts);
      console.log(`[SiteCheck] Launched browser via ${attempt.label}.`);
      return browser;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[SiteCheck] Browser launch via ${attempt.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw lastErr;
}

// ────────────────────────────────────────────────────────────
//  Pillar execution
//  Recording-enabled pillars (`record` slug set) run in a dedicated context
//  with recordVideo so the whole pillar run is captured as one video; the
//  video path is stamped on every result of that pillar. Other pillars run
//  on the shared long-lived page. Errors from the pillar fn propagate to the
//  caller, which fabricates score-0 fail rows.
// ────────────────────────────────────────────────────────────
async function executePillar(args: {
  pillar: (typeof PILLAR_CHECKS)[number];
  browser: import('playwright').Browser;
  sharedPage: import('playwright').Page;
  url: string;
  auditJobId: string;
  entityName: string;
  acronym: string;
  serviceName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { pillar, browser, sharedPage, url, auditJobId, entityName, acronym, serviceName, previousResults } = args;

  const recorder = pillar.record
    ? await startPillarRecording(browser, { auditJobId, slug: pillar.record }).catch((err) => {
        console.warn(`[SiteCheck] Recording unavailable for "${pillar.name}", running without video:`, err);
        return null;
      })
    : null;
  const page = recorder?.page ?? sharedPage;

  let results: CriterionResult[] = [];
  try {
    if (!pillar.skipInitialNav) {
      // Ensure we're on the original URL before each pillar (some checks navigate)
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      } catch {
        // Fallback: try domcontentloaded
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch { /* best effort */ }
      }
      // Wait for JS content to render
      await page.waitForTimeout(5000);
    }

    results = await pillar.fn({
      page,
      url,
      auditJobId,
      entityName,
      acronym,
      serviceName,
      previousResults,
      recorder: recorder ?? undefined,
    });
    return results;
  } finally {
    if (recorder) {
      const videoRel = await recorder.finish();
      if (videoRel) {
        for (const r of results) r.videoPath = videoRel;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────
//  Main entry point
// ────────────────────────────────────────────────────────────
export async function runEvaluation(
  auditJobId: string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<void> {
  // ── 1. Fetch audit job from DB ──
  const auditJob = await prisma.auditJob.findUniqueOrThrow({
    where: { id: auditJobId },
  });

  const { websiteUrl: url, entityName, acronym, serviceName } = auditJob;
  const allResults: CriterionResult[] = [];
  // Run All covers production pillars only — beta pillars (LLM-dependent) are excluded.
  const activePillars = PILLAR_CHECKS.filter((p) => !p.beta);
  const activePillarNames = new Set(activePillars.map((p) => p.name));
  const totalCriteria = CRITERIA.filter((c) => activePillarNames.has(c.pillar)).length;
  let totalChecked = 0;

  // ── 2. Update status to running ──
  await prisma.auditJob.update({
    where: { id: auditJobId },
    data: { status: 'running' },
  });

  // ── 3. Create screenshot directory ──
  const screenshotDir = path.join(process.cwd(), 'public', 'screenshots', auditJobId);
  fs.mkdirSync(screenshotDir, { recursive: true });

  // ── 4. Launch Playwright ──
  // Dynamic import so playwright is only loaded when the engine runs
  const playwright = await import('playwright');
  const browser = await launchBrowser(playwright);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    // ── 5. Navigate to the target website ──
    console.log(`[SiteCheck] Navigating to ${url} (waiting for full load)...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (navError) {
      // If networkidle times out, try domcontentloaded
      console.error(`[SiteCheck] Network-idle timeout for ${url}, retrying with domcontentloaded...`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        // Mark the job as failed
        await prisma.auditJob.update({
          where: { id: auditJobId },
          data: {
            status: 'failed',
            totalScore: 0,
            maxScore: 0,
            percentage: 0,
            grade: 'Needs Improvement',
          },
        });
        onProgress?.({
          type: 'error',
          message: `Failed to load ${url}. The website may be unreachable.`,
        });
        return;
      }
    }

    // Wait for JavaScript-rendered content to stabilize (SPAs, dynamic content)
    console.log('[SiteCheck] Waiting 4 seconds for page to fully render...');
    await page.waitForTimeout(4000);

    // ── 6. Run pillar checks sequentially (non-beta pillars only) ──
    for (const pillar of activePillars) {
      onProgress?.({
        type: 'pillar_start',
        pillar: pillar.name,
        message: `Starting ${pillar.name} checks…`,
        progress: Math.round((totalChecked / totalCriteria) * 100),
        totalChecked,
        totalCriteria,
      });

      let pillarResults: CriterionResult[] = [];

      try {
        pillarResults = await executePillar({
          pillar,
          browser,
          sharedPage: page,
          url,
          auditJobId,
          entityName,
          acronym,
          serviceName,
          previousResults: allResults,
        });
      } catch (pillarError) {
        console.error(`[SiteCheck] Pillar "${pillar.name}" failed:`, pillarError);

        // Create fail results for every criterion in this pillar
        const pillarCriteria = CRITERIA.filter((c) => c.pillar === pillar.name);
        for (const criterion of pillarCriteria) {
          pillarResults.push({
            qid: criterion.qid,
            criterionNameEN: criterion.nameEN,
            criterionNameAR: criterion.nameAR,
            pillar: criterion.pillar,
            subPillar: criterion.subPillar,
            scoreEarned: 0,
            maxScore: criterion.maxScore,
            status: 'fail' as const,
            screenshotPath: null,
            notes: `Pillar check error: ${pillarError instanceof Error ? pillarError.message : String(pillarError)}`,
            recommendation: criterion.recommendation,
            isAutomatic: criterion.isAutomatic ?? true,
            checkType: criterion.checkType ?? 'auto',
          });
        }
      }

      // Save each result to DB and emit progress
      for (const result of pillarResults) {
        allResults.push(result);
        totalChecked++;

        // Save to database
        try {
          await prisma.criterionResult.create({
            data: {
              auditJobId,
              qid: result.qid,
              criterionNameEN: result.criterionNameEN,
              criterionNameAR: result.criterionNameAR,
              pillar: result.pillar,
              subPillar: result.subPillar,
              scoreEarned: result.scoreEarned,
              maxScore: result.maxScore,
              status: result.status,
              screenshotPath: result.screenshotPath ?? '',
              videoPath: result.videoPath ?? '',
              notes: result.notes,
              recommendation: result.recommendation,
            },
          });
        } catch (dbError) {
          console.error(`[SiteCheck] Failed to save result for ${result.qid}:`, dbError);
        }

        onProgress?.({
          type: 'criterion_complete',
          qid: result.qid,
          criterionName: result.criterionNameEN,
          status: result.status,
          scoreEarned: result.scoreEarned,
          maxScore: result.maxScore,
          pillar: result.pillar,
          progress: Math.round((totalChecked / totalCriteria) * 100),
          totalChecked,
          totalCriteria,
        });
      }

      onProgress?.({
        type: 'pillar_complete',
        pillar: pillar.name,
        message: `Completed ${pillar.name} checks.`,
        progress: Math.round((totalChecked / totalCriteria) * 100),
        totalChecked,
        totalCriteria,
      });
    }

    // ── 7. Calculate final scores ──
    const { total, max, percentage, grade } = calculateTotalScore(allResults);
    const pillarScores = calculatePillarScores(allResults);

    // ── 8. Update the audit job with final results ──
    // If any question is awaiting an async email reply (Pillar 10 enquiry),
    // the audit is provisional until the background poller resolves it.
    const hasPending = allResults.some((r) => r.status === 'pending');
    await prisma.auditJob.update({
      where: { id: auditJobId },
      data: {
        status: hasPending ? 'partial' : 'complete',
        totalScore: total,
        maxScore: max,
        percentage,
        grade,
      },
    });

    onProgress?.({
      type: 'audit_complete',
      message: `Evaluation complete. Score: ${total}/${max} (${percentage}%) — ${grade}`,
      progress: 100,
      totalChecked,
      totalCriteria,
    });

    console.log(`[SiteCheck] ✅ Audit ${auditJobId} complete: ${total}/${max} (${percentage}%) — ${grade}`);
    console.log('[SiteCheck] Pillar breakdown:', JSON.stringify(pillarScores, null, 2));

  } catch (criticalError) {
    console.error(`[SiteCheck] Critical error in audit ${auditJobId}:`, criticalError);

    await prisma.auditJob.update({
      where: { id: auditJobId },
      data: {
        status: 'failed',
        totalScore: 0,
        maxScore: 0,
        percentage: 0,
        grade: 'Needs Improvement',
      },
    });

    onProgress?.({
      type: 'error',
      message: `Evaluation failed: ${criticalError instanceof Error ? criticalError.message : String(criticalError)}`,
    });
  } finally {
    // ── 9. Clean up Playwright ──
    try {
      await page.close();
      await context.close();
      await browser.close();
    } catch (closeError) {
      console.error('[SiteCheck] Error closing browser:', closeError);
    }
  }
}

// ────────────────────────────────────────────────────────────
//  Run a SINGLE pillar evaluation
//  Useful for testing individual pillar automation
// ────────────────────────────────────────────────────────────
export async function runSinglePillar(
  auditJobId: string,
  pillarName: string,
): Promise<{ success: boolean; message: string }> {
  // Find the pillar
  const pillar = PILLAR_CHECKS.find((p) => p.name === pillarName);
  if (!pillar) {
    return { success: false, message: `Unknown pillar: "${pillarName}"` };
  }

  // Fetch audit job
  const auditJob = await prisma.auditJob.findUniqueOrThrow({
    where: { id: auditJobId },
  });

  const { websiteUrl: url, entityName, acronym, serviceName } = auditJob;

  // Create screenshot directory
  const screenshotDir = path.join(process.cwd(), 'public', 'screenshots', auditJobId);
  fs.mkdirSync(screenshotDir, { recursive: true });

  // Delete any existing results for this pillar (re-run scenario)
  await prisma.criterionResult.deleteMany({
    where: {
      auditJobId,
      pillar: pillarName,
    },
  });

  // Launch Playwright
  const playwright = await import('playwright');
  const browser = await launchBrowser(playwright);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    // Navigate to website
    console.log(`[SiteCheck] [Single Pillar] Navigating to ${url}...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        return { success: false, message: `Failed to load ${url}` };
      }
    }

    console.log('[SiteCheck] [Single Pillar] Waiting 4 seconds for page to render...');
    await page.waitForTimeout(4000);

    // Fetch existing results from other pillars (for context / previousResults)
    const existingDbResults = await prisma.criterionResult.findMany({
      where: { auditJobId },
    });
    const previousResults: CriterionResult[] = existingDbResults.map((r) => ({
      qid: r.qid,
      criterionNameEN: r.criterionNameEN,
      criterionNameAR: r.criterionNameAR,
      pillar: r.pillar,
      subPillar: r.subPillar,
      scoreEarned: r.scoreEarned,
      maxScore: r.maxScore,
      status: r.status as CriterionResult['status'],
      screenshotPath: r.screenshotPath || null,
      notes: r.notes,
      recommendation: r.recommendation,
    }));

    // Run the pillar
    console.log(`[SiteCheck] [Single Pillar] Running "${pillar.name}"...`);
    let pillarResults: CriterionResult[] = [];

    try {
      pillarResults = await executePillar({
        pillar,
        browser,
        sharedPage: page,
        url,
        auditJobId,
        entityName,
        acronym,
        serviceName,
        previousResults,
      });
    } catch (pillarError) {
      console.error(`[SiteCheck] [Single Pillar] "${pillar.name}" failed:`, pillarError);

      const pillarCriteria = CRITERIA.filter((c) => c.pillar === pillar.name);
      for (const criterion of pillarCriteria) {
        pillarResults.push({
          qid: criterion.qid,
          criterionNameEN: criterion.nameEN,
          criterionNameAR: criterion.nameAR,
          pillar: criterion.pillar,
          subPillar: criterion.subPillar,
          scoreEarned: 0,
          maxScore: criterion.maxScore,
          status: 'fail' as const,
          screenshotPath: null,
          notes: `Pillar check error: ${pillarError instanceof Error ? pillarError.message : String(pillarError)}`,
          recommendation: criterion.recommendation,
          isAutomatic: criterion.isAutomatic ?? true,
          checkType: criterion.checkType ?? 'auto',
        });
      }
    }

    // Save results to DB
    for (const result of pillarResults) {
      try {
        await prisma.criterionResult.create({
          data: {
            auditJobId,
            qid: result.qid,
            criterionNameEN: result.criterionNameEN,
            criterionNameAR: result.criterionNameAR,
            pillar: result.pillar,
            subPillar: result.subPillar,
            scoreEarned: result.scoreEarned,
            maxScore: result.maxScore,
            status: result.status,
            screenshotPath: result.screenshotPath ?? '',
            videoPath: result.videoPath ?? '',
            notes: result.notes,
            recommendation: result.recommendation,
          },
        });
      } catch (dbError) {
        console.error(`[SiteCheck] Failed to save result for ${result.qid}:`, dbError);
      }
    }

    // Recalculate total scores from ALL results (existing + new)
    const allDbResults = await prisma.criterionResult.findMany({
      where: { auditJobId },
    });
    const allResults: CriterionResult[] = allDbResults.map((r) => ({
      qid: r.qid,
      criterionNameEN: r.criterionNameEN,
      criterionNameAR: r.criterionNameAR,
      pillar: r.pillar,
      subPillar: r.subPillar,
      scoreEarned: r.scoreEarned,
      maxScore: r.maxScore,
      status: r.status as CriterionResult['status'],
      screenshotPath: r.screenshotPath || null,
      notes: r.notes,
      recommendation: r.recommendation,
    }));

    const { total, max, percentage, grade } = calculateTotalScore(allResults);

    // Determine status: complete only if all production (non-beta) pillars ran AND
    // nothing is pending an async email reply (Pillar 10 enquiry).
    const pillarsCovered = new Set(allResults.map((r) => r.pillar));
    const allPillarsRun = PILLAR_CHECKS.filter((p) => !p.beta).every((p) => pillarsCovered.has(p.name));
    const hasPending = allResults.some((r) => r.status === 'pending');

    await prisma.auditJob.update({
      where: { id: auditJobId },
      data: {
        status: allPillarsRun && !hasPending ? 'complete' : 'partial',
        totalScore: total,
        maxScore: max,
        percentage,
        grade,
      },
    });

    const pillarScore = pillarResults.reduce((sum, r) => sum + r.scoreEarned, 0);
    const pillarMax = pillarResults.reduce((sum, r) => sum + r.maxScore, 0);

    console.log(`[SiteCheck] [Single Pillar] ✅ "${pillar.name}" complete: ${pillarScore}/${pillarMax}`);

    return {
      success: true,
      message: `${pillar.name}: ${pillarScore}/${pillarMax} points. Overall: ${total}/${max} (${percentage}%) — ${grade}`,
    };
  } catch (criticalError) {
    console.error(`[SiteCheck] [Single Pillar] Critical error:`, criticalError);
    return {
      success: false,
      message: `Error: ${criticalError instanceof Error ? criticalError.message : String(criticalError)}`,
    };
  } finally {
    try {
      await page.close();
      await context.close();
      await browser.close();
    } catch (closeError) {
      console.error('[SiteCheck] Error closing browser:', closeError);
    }
  }
}
