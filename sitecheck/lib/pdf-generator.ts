import puppeteer from 'puppeteer';
import prisma from '@/lib/prisma';
import path from 'path';
import { mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';

interface PillarSummary {
  pillar: string;
  earned: number;
  max: number;
  percentage: number;
}

export async function generatePDF(auditJobId: string): Promise<string> {
  // Fetch audit job with results
  const auditJob = await prisma.auditJob.findUnique({
    where: { id: auditJobId },
    include: {
      results: {
        orderBy: { qid: 'asc' },
      },
    },
  });

  if (!auditJob) {
    throw new Error(`Audit job not found: ${auditJobId}`);
  }

  // Calculate pillar summaries
  const pillarMap = new Map<string, PillarSummary>();
  for (const result of auditJob.results) {
    const existing = pillarMap.get(result.pillar);
    if (existing) {
      existing.earned += result.scoreEarned;
      existing.max += result.maxScore;
    } else {
      pillarMap.set(result.pillar, {
        pillar: result.pillar,
        earned: result.scoreEarned,
        max: result.maxScore,
        percentage: 0,
      });
    }
  }

  // Calculate percentages
  for (const summary of pillarMap.values()) {
    summary.percentage = summary.max > 0
      ? Math.round((summary.earned / summary.max) * 100)
      : 0;
  }

  const pillarSummaries = Array.from(pillarMap.values());

  // Format date
  const dateStr = new Date(auditJob.createdAt).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const dateStrAR = new Date(auditJob.createdAt).toLocaleDateString('ar-AE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Embed screenshots as base64
  const screenshotDataMap = new Map<string, string>();
  for (const result of auditJob.results) {
    if (result.screenshotPath && result.screenshotPath !== '') {
      try {
        const screenshotAbsPath = path.join(process.cwd(), result.screenshotPath);
        if (existsSync(screenshotAbsPath)) {
          const buffer = await readFile(screenshotAbsPath);
          const base64 = buffer.toString('base64');
          const ext = path.extname(screenshotAbsPath).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
          screenshotDataMap.set(result.qid, `data:${mime};base64,${base64}`);
        }
      } catch {
        // Skip failed screenshot reads
      }
    }
  }

  // Build HTML
  const html = buildHTML(auditJob, pillarSummaries, dateStr, dateStrAR, screenshotDataMap);

  // Ensure output directory exists
  const reportsDir = path.join(process.cwd(), 'public', 'reports');
  await mkdir(reportsDir, { recursive: true });

  const outputPath = path.join('public', 'reports', `${auditJobId}.pdf`);
  const absoluteOutputPath = path.join(process.cwd(), outputPath);

  // Generate PDF with Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.pdf({
      path: absoluteOutputPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
    });
  } finally {
    await browser.close();
  }

  // Save report record to DB
  await prisma.pdfReport.create({
    data: {
      auditJobId,
      filePath: outputPath,
    },
  });

  return outputPath;
}

function getStatusBadge(status: string): string {
  const colors: Record<string, { bg: string; text: string; label: string }> = {
    pass: { bg: '#d4edda', text: '#155724', label: '✓ Pass' },
    fail: { bg: '#f8d7da', text: '#721c24', label: '✗ Fail' },
    partial: { bg: '#fff3cd', text: '#856404', label: '~ Partial' },
    na: { bg: '#e2e3e5', text: '#383d41', label: 'N/A' },
    skipped: { bg: '#e2e3e5', text: '#383d41', label: 'Skipped' },
  };
  const c = colors[status] || colors['na'];
  return `<span style="
    display: inline-block;
    padding: 3px 12px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    background: ${c.bg};
    color: ${c.text};
  ">${c.label}</span>`;
}

function getGradeColor(grade: string): string {
  if (grade === 'Excellent') return '#28a745';
  if (grade === 'Good') return '#17a2b8';
  if (grade === 'Satisfactory') return '#ffc107';
  return '#dc3545';
}

function buildHTML(
  auditJob: {
    entityName: string;
    websiteUrl: string;
    serviceName: string;
    totalScore: number;
    maxScore: number;
    percentage: number;
    grade: string;
    results: {
      qid: string;
      criterionNameEN: string;
      criterionNameAR: string;
      pillar: string;
      subPillar: string;
      scoreEarned: number;
      maxScore: number;
      status: string;
      notes: string;
      recommendation: string;
    }[];
  },
  pillarSummaries: PillarSummary[],
  dateStr: string,
  dateStrAR: string,
  screenshotDataMap: Map<string, string>,
): string {
  // Group results by pillar
  const pillarGroups = new Map<string, typeof auditJob.results>();
  for (const result of auditJob.results) {
    const group = pillarGroups.get(result.pillar) || [];
    group.push(result);
    pillarGroups.set(result.pillar, group);
  }

  const pillarSectionsHTML = Array.from(pillarGroups.entries())
    .map(([pillar, results]) => {
      const criteriaHTML = results
        .map((r) => {
          const screenshotHTML = screenshotDataMap.has(r.qid)
            ? `<div style="margin-top: 8px;">
                <img src="${screenshotDataMap.get(r.qid)}" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px;" />
              </div>`
            : '';

          const notesHTML = r.notes
            ? `<div style="margin-top: 6px; padding: 8px; background: #f8f9fa; border-left: 3px solid #01696f; font-size: 12px;">
                <strong>Notes:</strong> ${escapeHtml(r.notes)}
              </div>`
            : '';

          const recHTML = r.recommendation
            ? `<div style="margin-top: 4px; padding: 8px; background: #fff3cd; border-left: 3px solid #ffc107; font-size: 12px;">
                <strong>Recommendation:</strong> ${escapeHtml(r.recommendation)}
              </div>`
            : '';

          return `
            <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 12px; page-break-inside: avoid;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div>
                  <span style="font-size: 11px; color: #01696f; font-weight: 700;">${escapeHtml(r.qid)}</span>
                  <span style="font-size: 14px; font-weight: 600; margin-left: 12px;">${escapeHtml(r.criterionNameEN)}</span>
                </div>
                <div>${getStatusBadge(r.status)}</div>
              </div>
              <div style="text-align: right; font-family: 'Segoe UI', Tahoma, sans-serif; font-size: 13px; color: #555; margin-bottom: 8px;" dir="rtl">
                ${escapeHtml(r.criterionNameAR)}
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="font-size: 12px; color: #666;">
                  Score: <strong>${r.scoreEarned}</strong> / ${r.maxScore}
                  ${r.subPillar ? `<span style="margin-left: 16px; color: #888;">Sub-pillar: ${escapeHtml(r.subPillar)}</span>` : ''}
                </div>
              </div>
              ${notesHTML}
              ${recHTML}
              ${screenshotHTML}
            </div>
          `;
        })
        .join('');

      return `
        <div style="margin-top: 30px; page-break-before: auto;">
          <h2 style="color: #01696f; border-bottom: 2px solid #01696f; padding-bottom: 8px; font-size: 20px;">
            ${escapeHtml(pillar)}
          </h2>
          ${criteriaHTML}
        </div>
      `;
    })
    .join('');

  const pillarTableRows = pillarSummaries
    .map(
      (p) => `
      <tr>
        <td style="padding: 10px 16px; border-bottom: 1px solid #e0e0e0; font-weight: 500;">${escapeHtml(p.pillar)}</td>
        <td style="padding: 10px 16px; border-bottom: 1px solid #e0e0e0; text-align: center;">${p.earned.toFixed(1)}</td>
        <td style="padding: 10px 16px; border-bottom: 1px solid #e0e0e0; text-align: center;">${p.max.toFixed(1)}</td>
        <td style="padding: 10px 16px; border-bottom: 1px solid #e0e0e0; text-align: center;">
          <div style="
            display: inline-block;
            background: ${p.percentage >= 80 ? '#d4edda' : p.percentage >= 60 ? '#fff3cd' : '#f8d7da'};
            color: ${p.percentage >= 80 ? '#155724' : p.percentage >= 60 ? '#856404' : '#721c24'};
            padding: 2px 10px;
            border-radius: 10px;
            font-weight: 600;
            font-size: 13px;
          ">${p.percentage}%</div>
        </td>
      </tr>
    `
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    @page {
      size: A4;
      margin: 0;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #333;
      line-height: 1.6;
      font-size: 14px;
    }
    .cover-page {
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      background: linear-gradient(135deg, #01696f 0%, #014d52 50%, #012e30 100%);
      color: white;
      text-align: center;
      page-break-after: always;
    }
    .cover-logo {
      font-size: 48px;
      font-weight: 800;
      letter-spacing: 2px;
      margin-bottom: 8px;
    }
    .cover-subtitle {
      font-size: 18px;
      opacity: 0.9;
      margin-bottom: 50px;
      letter-spacing: 1px;
    }
    .cover-entity {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .cover-url {
      font-size: 16px;
      opacity: 0.85;
      margin-bottom: 40px;
      word-break: break-all;
    }
    .cover-score-box {
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 30px 50px;
      margin-bottom: 30px;
    }
    .cover-score {
      font-size: 56px;
      font-weight: 800;
    }
    .cover-grade {
      font-size: 24px;
      font-weight: 600;
      padding: 6px 24px;
      border-radius: 20px;
      display: inline-block;
      margin-top: 10px;
    }
    .cover-date {
      font-size: 14px;
      opacity: 0.8;
      margin-top: 30px;
    }
    .cover-date-ar {
      font-family: 'Segoe UI', Tahoma, sans-serif;
      direction: rtl;
      font-size: 13px;
      opacity: 0.7;
      margin-top: 4px;
    }
    .section-page {
      padding: 10px 0;
    }
  </style>
</head>
<body>
  <!-- COVER PAGE -->
  <div class="cover-page">
    <div class="cover-logo">SiteCheck</div>
    <div class="cover-subtitle">UAE Government Website Evaluation Report</div>
    <div style="font-size: 15px; opacity: 0.75; margin-bottom: 50px; font-family: 'Segoe UI', Tahoma, sans-serif;" dir="rtl">
      تقرير تقييم المواقع الإلكترونية الحكومية الإماراتية
    </div>

    <div class="cover-entity">${escapeHtml(auditJob.entityName)}</div>
    <div class="cover-url">${escapeHtml(auditJob.websiteUrl)}</div>
    ${auditJob.serviceName ? `<div style="font-size: 15px; opacity: 0.8; margin-bottom: 20px;">Service: ${escapeHtml(auditJob.serviceName)}</div>` : ''}

    <div class="cover-score-box">
      <div class="cover-score">${auditJob.percentage.toFixed(1)}%</div>
      <div style="font-size: 16px; opacity: 0.9; margin-top: 4px;">
        ${auditJob.totalScore.toFixed(1)} / ${auditJob.maxScore.toFixed(1)} points
      </div>
      <div class="cover-grade" style="background: ${getGradeColor(auditJob.grade)};">
        ${escapeHtml(auditJob.grade)}
      </div>
    </div>

    <div class="cover-date">${dateStr}</div>
    <div class="cover-date-ar" dir="rtl">${dateStrAR}</div>
  </div>

  <!-- EXECUTIVE SUMMARY -->
  <div class="section-page">
    <h1 style="color: #01696f; font-size: 26px; margin-bottom: 6px;">Executive Summary</h1>
    <p style="color: #888; font-size: 13px; margin-bottom: 24px; font-family: 'Segoe UI', Tahoma, sans-serif;" dir="rtl">ملخص تنفيذي</p>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; border-radius: 8px; overflow: hidden; border: 1px solid #e0e0e0;">
      <thead>
        <tr style="background: #01696f; color: white;">
          <th style="padding: 12px 16px; text-align: left; font-weight: 600;">Pillar</th>
          <th style="padding: 12px 16px; text-align: center; font-weight: 600;">Earned</th>
          <th style="padding: 12px 16px; text-align: center; font-weight: 600;">Max</th>
          <th style="padding: 12px 16px; text-align: center; font-weight: 600;">Score</th>
        </tr>
      </thead>
      <tbody>
        ${pillarTableRows}
        <tr style="background: #f8f9fa; font-weight: 700;">
          <td style="padding: 12px 16px; border-top: 2px solid #01696f;">Overall Total</td>
          <td style="padding: 12px 16px; text-align: center; border-top: 2px solid #01696f;">${auditJob.totalScore.toFixed(1)}</td>
          <td style="padding: 12px 16px; text-align: center; border-top: 2px solid #01696f;">${auditJob.maxScore.toFixed(1)}</td>
          <td style="padding: 12px 16px; text-align: center; border-top: 2px solid #01696f;">
            <div style="
              display: inline-block;
              background: ${getGradeColor(auditJob.grade)};
              color: white;
              padding: 3px 14px;
              border-radius: 12px;
              font-size: 14px;
            ">${auditJob.percentage.toFixed(1)}%</div>
          </td>
        </tr>
      </tbody>
    </table>

    <div style="
      background: linear-gradient(135deg, #01696f11, #01696f05);
      border: 1px solid #01696f33;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    ">
      <div style="font-size: 14px; color: #666; margin-bottom: 6px;">Overall Grade</div>
      <div style="font-size: 36px; font-weight: 800; color: ${getGradeColor(auditJob.grade)};">
        ${escapeHtml(auditJob.grade)}
      </div>
      <div style="font-size: 13px; color: #888; margin-top: 4px;">
        ${auditJob.results.length} criteria evaluated
      </div>
    </div>
  </div>

  <!-- DETAILED FINDINGS -->
  <div class="section-page" style="margin-top: 30px;">
    <h1 style="color: #01696f; font-size: 26px; margin-bottom: 6px;">Detailed Findings</h1>
    <p style="color: #888; font-size: 13px; margin-bottom: 10px; font-family: 'Segoe UI', Tahoma, sans-serif;" dir="rtl">النتائج التفصيلية</p>

    ${pillarSectionsHTML}
  </div>

  <!-- FOOTER -->
  <div style="margin-top: 40px; padding: 20px; text-align: center; color: #999; font-size: 11px; border-top: 1px solid #eee;">
    <p>Generated by SiteCheck — UAE Government Website Evaluation Tool</p>
    <p style="font-family: 'Segoe UI', Tahoma, sans-serif;" dir="rtl">تم إنشاؤه بواسطة SiteCheck — أداة تقييم المواقع الإلكترونية الحكومية الإماراتية</p>
    <p style="margin-top: 6px;">Report generated on ${dateStr}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
