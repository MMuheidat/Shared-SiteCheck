'use client';

import { ChevronDown, CheckCircle, XCircle, AlertTriangle, Loader2, MinusCircle } from 'lucide-react';

interface CriterionStatus {
  qid: string;
  name: string;
  status: 'pass' | 'fail' | 'partial' | 'checking' | 'na' | 'skipped' | 'pending';
  score: number;
  maxScore: number;
}

interface PillarProgressProps {
  pillarName: string;
  criteria: CriterionStatus[];
  isExpanded: boolean;
  onToggle: () => void;
}

function statusIcon(status: string) {
  switch (status) {
    case 'pass':
      return <CheckCircle className="w-4 h-4 text-success shrink-0" />;
    case 'fail':
      return <XCircle className="w-4 h-4 text-danger shrink-0" />;
    case 'partial':
      return <AlertTriangle className="w-4 h-4 text-warning shrink-0" />;
    case 'checking':
      return <Loader2 className="w-4 h-4 text-primary shrink-0 animate-spin" />;
    case 'na':
    case 'skipped':
      return <MinusCircle className="w-4 h-4 text-text-muted shrink-0" />;
    default:
      return <div className="w-4 h-4 rounded-full border-2 border-border shrink-0" />;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'pass': return 'badge-pass';
    case 'fail': return 'badge-fail';
    case 'partial': return 'badge-partial';
    case 'checking': return 'badge-running';
    case 'na': return 'badge-na';
    case 'skipped': return 'badge-skipped';
    default: return 'badge-pending';
  }
}

export default function PillarProgress({ pillarName, criteria, isExpanded, onToggle }: PillarProgressProps) {
  const completed = criteria.filter((c) => ['pass', 'fail', 'partial', 'na', 'skipped'].includes(c.status)).length;
  const total = criteria.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const earned = criteria.reduce((sum, c) => sum + c.score, 0);
  const maxScore = criteria.reduce((sum, c) => sum + c.maxScore, 0);

  return (
    <div className="card overflow-hidden animate-fade-in">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-surface-dark/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChevronDown
            className={`w-5 h-5 text-text-muted transition-transform duration-200 shrink-0 ${
              isExpanded ? 'rotate-0' : '-rotate-90'
            }`}
          />
          <h4 className="font-semibold text-text-primary text-sm truncate">{pillarName}</h4>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-xs text-text-muted">
            {completed}/{total} checks
          </span>
          <span className="text-xs font-semibold text-text-secondary">
            {earned}/{maxScore} pts
          </span>
          {/* Mini progress */}
          <div className="w-20 h-1.5 bg-surface-darker rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-gradient-to-r from-primary to-primary-light rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </button>

      {/* Criteria list */}
      {isExpanded && (
        <div className="border-t border-border-light animate-slide-down">
          {criteria.map((criterion) => (
            <div
              key={criterion.qid}
              className={`flex items-center gap-3 px-6 py-3 border-b border-border-light last:border-b-0 transition-all duration-300 ${
                criterion.status === 'checking' ? 'bg-primary-50/30' : ''
              }`}
            >
              {statusIcon(criterion.status)}
              <div className="flex-1 min-w-0">
                <span className="text-sm text-text-primary truncate block">
                  <span className="text-text-muted font-mono text-xs mr-2">{criterion.qid}</span>
                  {criterion.name}
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {criterion.status !== 'pending' && criterion.status !== 'checking' && (
                  <span className="text-xs text-text-muted">
                    {criterion.score}/{criterion.maxScore}
                  </span>
                )}
                <span className={`badge text-[0.65rem] ${statusBadgeClass(criterion.status)}`}>
                  {criterion.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
