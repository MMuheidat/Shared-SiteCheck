'use client';

import React, { useMemo, useState } from 'react';
import { Eye, ArrowUpDown, Image as ImageIcon, Video } from 'lucide-react';
import type { CriterionResult } from '@/lib/types';
import { getCriterion } from '@/lib/scoring';

interface ResultsTableProps {
  results: CriterionResult[];
  onScreenshotClick: (path: string, name: string) => void;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'pass': return 'badge-pass';
    case 'fail': return 'badge-fail';
    case 'partial': return 'badge-partial';
    case 'na': return 'badge-na';
    case 'skipped': return 'badge-skipped';
    default: return 'badge-pending';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pass': return 'Pass';
    case 'fail': return 'Fail';
    case 'partial': return 'Partial';
    case 'na': return 'N/A';
    case 'skipped': return 'Skipped';
    default: return status;
  }
}

type SortKey = 'qid' | 'pillar' | 'status' | 'score';

function SortHeader({
  label,
  col,
  sortKey,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className="cursor-pointer select-none group" onClick={() => onSort(col)}>
      <div className="flex items-center gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity ${sortKey === col ? '!opacity-100 text-primary' : ''}`} />
      </div>
    </th>
  );
}

function getCriterionSubtitle(qid: string): string {
  const criterion = getCriterion(qid);
  const description = criterion?.nameEN ?? '';
  return description.split(/\r?\n/)[0].trim();
}

export default function ResultsTable({ results, onScreenshotClick }: ResultsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('qid');
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  // Pillar name → ordinal, mirroring PILLAR_CHECKS order in lib/engine/index.ts
  // (not imported to keep engine deps out of this client component).
  const PILLAR_NUMBERS: Record<string, number> = {
    'Discovery & Access': 1,
    'Accessibility & Inclusion': 2,
    'Website Structure': 3,
    'Navigation': 4,
    'Registration': 5,
    'Services': 6,
    'Performance': 7,
    'Customer Privacy': 8,
    'Live Chat': 9,
    'Enquiry Form Journey': 10,
  };
  const pillarVideoLabel = (pillar: string) => {
    const n = PILLAR_NUMBERS[pillar];
    return n ? `Pillar ${n} Video — ${pillar}` : `${pillar} — Video`;
  };

  // One screen-recording per pillar (every row of a recorded pillar carries the
  // same videoPath) — surfaced as a single video bar under the pillar's rows.
  const pillarVideos = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of results) {
      if (r.videoPath && !map.has(r.pillar)) map.set(r.pillar, r.videoPath);
    }
    return map;
  }, [results]);

  const sortedResults = useMemo(() => {
    const sorted = [...results].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'qid':
          cmp = a.qid.localeCompare(b.qid, undefined, { numeric: true });
          break;
        case 'pillar':
          cmp = a.pillar.localeCompare(b.pillar) || a.qid.localeCompare(b.qid, undefined, { numeric: true });
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'score':
          cmp = (a.scoreEarned / a.maxScore) - (b.scoreEarned / b.maxScore);
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [results, sortKey, sortAsc]);

  return (
    <div className="table-container animate-fade-in">
      <table>
        <thead>
          <tr>
            <SortHeader label="QID" col="qid" sortKey={sortKey} onSort={handleSort} />
            <th>Criterion</th>
            <th>Technical Notes</th>
            <SortHeader label="Pillar" col="pillar" sortKey={sortKey} onSort={handleSort} />
            <SortHeader label="Score" col="score" sortKey={sortKey} onSort={handleSort} />
            <SortHeader label="Status" col="status" sortKey={sortKey} onSort={handleSort} />
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {sortedResults.map((r, i) => {
            // End of a contiguous pillar run → append that pillar's video bar
            const isPillarGroupEnd =
              i === sortedResults.length - 1 || sortedResults[i + 1].pillar !== r.pillar;
            const pillarVideo = isPillarGroupEnd ? pillarVideos.get(r.pillar) : undefined;

            return (
            <React.Fragment key={r.qid}>
            <tr>
              <td>
                <span className="font-mono text-xs text-text-secondary">{r.qid}</span>
              </td>
              <td>
                <div className="max-w-xs">
                  <p className="text-sm font-medium text-text-primary truncate">{r.criterionNameEN}</p>
                  <p className="text-xs text-text-muted mt-0.5 truncate">
                    {getCriterionSubtitle(r.qid)}
                  </p>
                </div>
              </td>
              <td>
                <div className="max-w-sm">
                  <p className="text-xs text-text-secondary break-words line-clamp-3">
                    {r.notes || '—'}
                  </p>
                </div>
              </td>
              <td>
                <span className="text-xs text-text-secondary">{r.pillar}</span>
              </td>
              <td>
                <span className="text-sm font-semibold text-text-primary">
                  {r.scoreEarned}<span className="text-text-muted font-normal">/{r.maxScore}</span>
                </span>
              </td>
              <td>
                <span className={`badge ${statusBadgeClass(r.status)}`}>
                  {statusLabel(r.status)}
                </span>
              </td>
              <td>
                {r.screenshotPath ? (
                  <button
                    onClick={() => onScreenshotClick(r.screenshotPath!, r.criterionNameEN)}
                    className="flex items-center gap-1.5 text-primary hover:text-primary-dark transition-colors group"
                  >
                    <Eye className="w-4 h-4" />
                    <span className="text-xs group-hover:underline">View</span>
                  </button>
                ) : (
                  <span className="flex items-center gap-1 text-text-muted">
                    <ImageIcon className="w-4 h-4 opacity-30" />
                    <span className="text-xs">N/A</span>
                  </span>
                )}
              </td>
            </tr>
            {pillarVideo && (
              <tr>
                <td colSpan={7} className="!py-2">
                  <button
                    onClick={() => onScreenshotClick(pillarVideo, pillarVideoLabel(r.pillar))}
                    className="w-full text-xs py-2 px-3 rounded-lg font-medium flex items-center justify-center gap-1.5 transition-all duration-200 bg-primary text-white hover:bg-primary-dark shadow-sm"
                  >
                    <Video className="w-3.5 h-3.5" />
                    {pillarVideoLabel(r.pillar)}
                  </button>
                </td>
              </tr>
            )}
            </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
