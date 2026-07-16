'use client';

import { useMemo, useState } from 'react';
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

  const SortHeader = ({ label, col }: { label: string; col: SortKey }) => (
    <th
      className="cursor-pointer select-none group"
      onClick={() => handleSort(col)}
    >
      <div className="flex items-center gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity ${sortKey === col ? '!opacity-100 text-primary' : ''}`} />
      </div>
    </th>
  );

  return (
    <div className="table-container animate-fade-in">
      <table>
        <thead>
          <tr>
            <SortHeader label="QID" col="qid" />
            <th>Criterion</th>
            <th>Technical Notes</th>
            <SortHeader label="Pillar" col="pillar" />
            <SortHeader label="Score" col="score" />
            <SortHeader label="Status" col="status" />
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {sortedResults.map((r) => (
            <tr key={r.qid}>
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
                {r.screenshotPath || r.videoPath ? (
                  <div className="flex flex-col gap-1">
                    {r.videoPath && (
                      <button
                        onClick={() => onScreenshotClick(r.videoPath!, r.criterionNameEN)}
                        className="flex items-center gap-1.5 text-primary hover:text-primary-dark transition-colors group"
                      >
                        <Video className="w-4 h-4" />
                        <span className="text-xs group-hover:underline">Video</span>
                      </button>
                    )}
                    {r.screenshotPath && (
                      <button
                        onClick={() => onScreenshotClick(r.screenshotPath!, r.criterionNameEN)}
                        className="flex items-center gap-1.5 text-primary hover:text-primary-dark transition-colors group"
                      >
                        <Eye className="w-4 h-4" />
                        <span className="text-xs group-hover:underline">View</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="flex items-center gap-1 text-text-muted">
                    <ImageIcon className="w-4 h-4 opacity-30" />
                    <span className="text-xs">N/A</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
