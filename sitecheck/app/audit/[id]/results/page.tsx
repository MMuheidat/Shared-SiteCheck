'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  FileDown,
  Globe,
  ExternalLink,
  Calendar,
  Loader2,
  AlertCircle,
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Search,
  Accessibility,
  LayoutDashboard,
  Navigation2,
  UserPlus,
  Server,
  Gauge,
  ShieldCheck,
  MessageSquare,
  MailQuestion,
  PlayCircle,
} from 'lucide-react';
import ScoreSummaryCard from '@/components/ScoreSummaryCard';
import PillarBreakdownChart from '@/components/PillarBreakdownChart';
import ResultsTable from '@/components/ResultsTable';
import ScreenshotModal from '@/components/ScreenshotModal';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import type { AuditJob, PillarScore } from '@/lib/types';

// Icon map for each pillar
const PILLAR_ICONS: Record<string, React.ReactNode> = {
  'Discovery & Access': <Search className="w-4 h-4" />,
  'Accessibility & Inclusion': <Accessibility className="w-4 h-4" />,
  'Website Structure': <LayoutDashboard className="w-4 h-4" />,
  'Navigation': <Navigation2 className="w-4 h-4" />,
  'Registration': <UserPlus className="w-4 h-4" />,
  'Services': <Server className="w-4 h-4" />,
  'Performance': <Gauge className="w-4 h-4" />,
  'Customer Privacy': <ShieldCheck className="w-4 h-4" />,
  'Live Chat': <MessageSquare className="w-4 h-4" />,
  'Enquiry Form Journey': <MailQuestion className="w-4 h-4" />,
};

interface PillarInfo {
  name: string;
  nameAR: string;
  index: number;
  beta?: boolean;
}

export default function ResultsPage() {
  const params = useParams();
  const id = params.id as string;
  const { showToast } = useToast();

  const [audit, setAudit] = useState<AuditJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pillars, setPillars] = useState<PillarInfo[]>([]);

  // Per-pillar running state
  const [runningPillars, setRunningPillars] = useState<Set<string>>(new Set());

  // What run this page initiated — drives the completion toast. null when the
  // run was started elsewhere (or the page was opened mid-run).
  const runKindRef = useRef<{ kind: 'pillar'; pillarName: string } | { kind: 'all' } | null>(null);

  // Screenshot modal state
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState('');

  const fetchAudit = useCallback(async () => {
    try {
      const res = await fetch(`/api/audit/${id}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error('Failed to load audit results');
      }
      const data: AuditJob = await res.json();
      setAudit(data);

      // Completion detection for runs started on this page. The engine
      // deletes a pillar's old rows and reinserts them during a re-run, so
      // row presence means nothing — the only reliable done signal is the
      // job status leaving 'running' for a terminal state.
      const terminal =
        data.status === 'complete' || data.status === 'partial' || data.status === 'failed';
      const run = runKindRef.current;
      if (terminal && run) {
        if (run.kind === 'pillar') {
          const pillarResults = data.results?.filter((r) => r.pillar === run.pillarName) ?? [];
          const earned = pillarResults.reduce((sum, r) => sum + r.scoreEarned, 0);
          const max = pillarResults.reduce((sum, r) => sum + r.maxScore, 0);
          showToast(`${run.pillarName}: ${earned}/${max} points`, earned > 0 ? 'success' : 'error');
        } else {
          showToast(
            data.status === 'failed'
              ? 'Evaluation failed.'
              : `Evaluation ${data.status === 'complete' ? 'complete' : 'finished (partial)'}! Score: ${data.totalScore}/${data.maxScore}`,
            data.status === 'failed' ? 'error' : 'success'
          );
        }
        runKindRef.current = null;
        setRunningPillars(new Set());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load results';
      setError(message);
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [id, showToast]);

  useEffect(() => {
    // Fetch-on-mount: all setState calls happen after await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAudit();
  }, [fetchAudit]);

  // Single source of polling truth: whenever the job is running — started
  // here (the handlers below optimistically flip status to 'running') or
  // elsewhere — poll until it reaches a terminal state.
  useEffect(() => {
    if (audit?.status !== 'running') return;
    const interval = setInterval(fetchAudit, 5000);
    return () => clearInterval(interval);
  }, [audit?.status, fetchAudit]);

  // Load pillar list
  useEffect(() => {
    fetch('/api/audit/pillars')
      .then((res) => res.json())
      .then((data) => setPillars(data.pillars || []))
      .catch(() => {});
  }, []);

  // Compute pillar scores from results
  const pillarScores: PillarScore[] = useMemo(() => {
    if (!audit?.results) return [];
    const pillarMap = new Map<string, { earned: number; max: number }>();

    for (const r of audit.results) {
      const existing = pillarMap.get(r.pillar) || { earned: 0, max: 0 };
      existing.earned += r.scoreEarned;
      existing.max += r.maxScore;
      pillarMap.set(r.pillar, existing);
    }

    return Array.from(pillarMap.entries()).map(([pillar, data]) => ({
      pillar,
      pillarAR: '',
      earned: data.earned,
      max: data.max,
      percentage: data.max > 0 ? (data.earned / data.max) * 100 : 0,
    }));
  }, [audit]);

  // Check which pillars have results
  const pillarStatus = useMemo(() => {
    const status = new Map<string, { earned: number; max: number; count: number }>();
    if (audit?.results) {
      for (const r of audit.results) {
        const existing = status.get(r.pillar) || { earned: 0, max: 0, count: 0 };
        existing.earned += r.scoreEarned;
        existing.max += r.maxScore;
        existing.count++;
        status.set(r.pillar, existing);
      }
    }
    return status;
  }, [audit]);

  const handleRunPillar = async (pillarName: string) => {
    showToast(`Running ${pillarName}...`, 'info');

    try {
      const res = await fetch('/api/audit/run-pillar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditJobId: id, pillarName }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start pillar check');
      }

      // Optimistic: engage the status-gated poller immediately and mark the
      // pillar as running. The completion effect above clears it when the
      // job's status leaves 'running'. (Safe: the API flips the DB status to
      // 'running' before responding, so the refresh below can't revert this.)
      runKindRef.current = { kind: 'pillar', pillarName };
      setRunningPillars((prev) => new Set(prev).add(pillarName));
      setAudit((prev) => (prev ? { ...prev, status: 'running' } : prev));
      fetchAudit(); // immediate refresh — don't wait for the first poll tick
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      showToast(message, 'error');
    }
  };

  const handleRunAll = async () => {
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditJobId: id }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start evaluation');
      }

      showToast('Running all pillars! This may take a few minutes.', 'success');
      // Mark all production pillars as running (beta pillars are excluded from Run All)
      runKindRef.current = { kind: 'all' };
      setRunningPillars(new Set(pillars.filter((p) => !p.beta).map((p) => p.name)));
      setAudit((prev) => (prev ? { ...prev, status: 'running' } : prev));
      fetchAudit();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      showToast(message, 'error');
    }
  };

  const handleScreenshotClick = (path: string, name: string) => {
    setScreenshotPath(path);
    setScreenshotName(name);
    setScreenshotOpen(true);
  };

  const handleDownloadPdf = () => {
    const link = document.createElement('a');
    link.href = `/api/audit/${id}/pdf`;
    link.download = `sitecheck-report-${id}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Downloading PDF report...', 'info');
  };

  // Loading state
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-6">
          <div className="skeleton h-8 w-48" />
          <div className="grid lg:grid-cols-3 gap-6">
            <SkeletonCard />
            <div className="lg:col-span-2">
              <SkeletonCard />
            </div>
          </div>
          <SkeletonTable rows={8} />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !audit) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="card-elevated p-12 text-center animate-fade-in">
          <AlertCircle className="w-12 h-12 text-danger mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-text-primary mb-2">Failed to Load Results</h2>
          <p className="text-text-secondary mb-6">{error || 'The evaluation data could not be found.'}</p>
          <Link href="/dashboard" className="btn-primary">
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Anything running — started on this page (runningPillars) or elsewhere
  // (server status from the mount fetch) — disables every Run button so
  // concurrent Playwright/Chrome runs can't be stacked.
  const anyRunning = runningPillars.size > 0 || audit.status === 'running';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="animate-fade-in">
        {/* Top bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/dashboard" className="btn-ghost p-2 shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-text-primary truncate">
                {audit.entityName}
              </h1>
              <div className="flex items-center gap-3 mt-1">
                <a
                  href={audit.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline flex items-center gap-1"
                >
                  <Globe className="w-3.5 h-3.5" />
                  {audit.websiteUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-xs text-text-muted flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(audit.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={handleRunAll} disabled={anyRunning} className="btn-secondary shrink-0">
              {anyRunning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <PlayCircle className="w-4 h-4" />
                  Run All Pillars
                </>
              )}
            </button>
            <button onClick={handleDownloadPdf} className="btn-primary shrink-0">
              <FileDown className="w-4 h-4" />
              Download PDF
            </button>
          </div>
        </div>

        {/* Score + Pillar breakdown */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          <ScoreSummaryCard
            totalScore={audit.totalScore}
            maxScore={audit.maxScore}
            percentage={audit.percentage}
            grade={audit.grade}
          />
          <div className="lg:col-span-2">
            <PillarBreakdownChart pillarScores={pillarScores} />
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════ */}
        {/* Pillar-by-Pillar Run Buttons */}
        {/* ═══════════════════════════════════════════════════════ */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-text-primary mb-4 flex items-center gap-2">
            <Play className="w-5 h-5 text-primary" />
            Run Individual Pillars
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {pillars.map((pillar) => {
              const status = pillarStatus.get(pillar.name);
              const isRunning = runningPillars.has(pillar.name);
              const hasResults = status && status.count > 0;
              const percentage = status && status.max > 0
                ? Math.round((status.earned / status.max) * 100)
                : null;

              return (
                <div
                  key={pillar.name}
                  className="card-elevated p-4 flex flex-col gap-3 transition-all duration-200 hover:shadow-lg"
                >
                  {/* Pillar header */}
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center shrink-0 text-primary">
                      {PILLAR_ICONS[pillar.name] || <Play className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary leading-tight truncate flex items-center gap-1.5">
                        {pillar.name}
                        {pillar.beta && (
                          <span className="shrink-0 text-[0.55rem] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">
                            Beta
                          </span>
                        )}
                      </p>
                      <p className="text-[0.6rem] text-text-muted">{pillar.nameAR}</p>
                    </div>
                  </div>

                  {/* Score badge */}
                  {hasResults && !isRunning && (
                    <div className="flex items-center gap-2">
                      {percentage !== null && percentage >= 50 ? (
                        <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                      )}
                      <span className="text-xs font-medium text-text-secondary">
                        {status.earned}/{status.max} pts
                        <span className="text-text-muted ml-1">({percentage}%)</span>
                      </span>
                    </div>
                  )}

                  {/* Run / Re-run button */}
                  <button
                    onClick={() => handleRunPillar(pillar.name)}
                    disabled={anyRunning}
                    className={`w-full text-xs py-2 px-3 rounded-lg font-medium flex items-center justify-center gap-1.5 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                      isRunning
                        ? 'bg-primary/10 text-primary cursor-wait'
                        : hasResults
                        ? 'bg-surface-secondary text-text-secondary hover:bg-primary/10 hover:text-primary'
                        : 'bg-primary text-white hover:bg-primary-dark shadow-sm'
                    }`}
                  >
                    {isRunning ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Running...
                      </>
                    ) : hasResults ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5" />
                        Re-run
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        Run
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Results Table */}
        <div className="mb-8">
          <h2 className="text-lg font-bold text-text-primary mb-4">Detailed Results</h2>
          {audit.results && audit.results.length > 0 ? (
            <ResultsTable
              results={audit.results}
              onScreenshotClick={handleScreenshotClick}
            />
          ) : (
            <div className="card-elevated p-8 text-center">
              <p className="text-text-secondary">No detailed results available.</p>
              <p className="text-xs text-text-muted mt-1">
                Run individual pillars above to see results.
              </p>
            </div>
          )}
        </div>

        {/* Bottom nav */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <Link href="/dashboard" className="btn-ghost">
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
          <button onClick={handleDownloadPdf} className="btn-secondary">
            <FileDown className="w-4 h-4" />
            Download PDF
          </button>
        </div>
      </div>

      {/* Screenshot Modal */}
      <ScreenshotModal
        isOpen={screenshotOpen}
        screenshotPath={screenshotPath}
        criterionName={screenshotName}
        onClose={() => setScreenshotOpen(false)}
      />
    </div>
  );
}
