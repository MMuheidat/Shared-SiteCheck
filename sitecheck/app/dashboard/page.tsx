'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  PlusCircle,
  ExternalLink,
  Trash2,
  FileDown,
  Calendar,
  Globe,
  Award,
  BarChart3,
  ClipboardList,
  Loader2,
  Eye,
  Zap,
} from 'lucide-react';
import { SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import type { AuditJob } from '@/lib/types';

function gradeClass(grade: string): string {
  const g = grade.toLowerCase();
  if (g === 'excellent') return 'badge-excellent';
  if (g === 'good') return 'badge-good';
  if (g === 'satisfactory') return 'badge-satisfactory';
  return 'badge-needs-improvement';
}

function statusBadge(status: string): string {
  switch (status) {
    case 'complete': return 'badge-pass';
    case 'partial': return 'badge-good';
    case 'running': return 'badge-running';
    case 'failed': return 'badge-fail';
    default: return 'badge-pending';
  }
}

export default function DashboardPage() {
  const { status } = useSession();
  const router = useRouter();
  const { showToast } = useToast();

  const [audits, setAudits] = useState<AuditJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [startingTamm, setStartingTamm] = useState(false);

  useEffect(() => {
    if (false) {
      router.push('/login');
    }
  }, [status, router]);

  useEffect(() => {
    fetchAudits();
  }, [status]);

  const fetchAudits = async () => {
    try {
      const res = await fetch('/api/audit/list');
      if (res.ok) {
        const data = await res.json();
        setAudits(data.audits || data);
      }
    } catch {
      showToast('Failed to load evaluations', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this evaluation? This action cannot be undone.')) {
      return;
    }

    setDeletingId(id);
    try {
      const res = await fetch(`/api/audit/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setAudits((prev) => prev.filter((a) => a.id !== id));
        showToast('Evaluation deleted successfully', 'success');
      } else {
        showToast('Failed to delete evaluation', 'error');
      }
    } catch {
      showToast('Failed to delete evaluation', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  // One-click TAMM Automated Check: create an audit for the TAMM portal and
  // immediately run all production pillars (1–8), then jump to the results page.
  const handleTammCheck = async () => {
    setStartingTamm(true);
    try {
      const createRes = await fetch('/api/audit/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          websiteUrl: 'https://www.tamm.abudhabi/',
          entityName: 'TAMM - Abu Dhabi Government Services',
          serviceName: '',
        }),
      });
      if (!createRes.ok) {
        const err = await createRes.json();
        throw new Error(err.error || 'Failed to create TAMM audit');
      }
      const { id } = await createRes.json();

      const runRes = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditJobId: id }),
      });
      if (!runRes.ok) {
        const err = await runRes.json();
        throw new Error(err.error || 'Failed to start TAMM evaluation');
      }

      showToast('TAMM Automated Check started — running pillars 1–8.', 'success');
      router.push(`/audit/${id}/results`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to start TAMM check', 'error');
      setStartingTamm(false);
    }
  };

  const handleDownloadPdf = async (id: string) => {
    try {
      const link = document.createElement('a');
      link.href = `/api/audit/${id}/pdf`;
      link.download = `sitecheck-report-${id}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Downloading PDF report...', 'info');
    } catch {
      showToast('Failed to download report', 'error');
    }
  };

  if (status === 'loading') {
    return null;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-primary" />
            Your Evaluations
          </h1>
          <p className="text-text-secondary mt-1">Manage and review your website evaluations</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleTammCheck}
            disabled={startingTamm}
            className="btn-secondary"
            title="Create and automatically run an evaluation of tamm.abudhabi (pillars 1–8)"
          >
            {startingTamm ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" />
            )}
            TAMM Automated Check
          </button>
          <Link href="/audit/new" className="btn-primary">
            <PlusCircle className="w-4 h-4" />
            New Evaluation
          </Link>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && audits.length === 0 && (
        <div className="card-elevated p-16 text-center animate-fade-in">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-primary-50 mb-6">
            <ClipboardList className="w-10 h-10 text-primary" />
          </div>
          <h3 className="text-xl font-semibold text-text-primary mb-2">No evaluations yet</h3>
          <p className="text-text-secondary mb-6 max-w-md mx-auto">
            Start your first website evaluation to see results here.
          </p>
          <Link href="/audit/new" className="btn-primary">
            <PlusCircle className="w-4 h-4" />
            Start First Evaluation
          </Link>
        </div>
      )}

      {/* Audit list */}
      {!loading && audits.length > 0 && (
        <div className="space-y-4 animate-fade-in">
          {audits.map((audit) => (
            <div key={audit.id} className="card-elevated p-5 sm:p-6">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center shrink-0 mt-0.5">
                      <Globe className="w-5 h-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-text-primary text-lg truncate">
                        {audit.entityName}
                      </h3>
                      <a
                        href={audit.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1 truncate"
                      >
                        {audit.websiteUrl}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                      <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(audit.createdAt).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <span className={`badge text-[0.65rem] ${statusBadge(audit.status)}`}>
                          {audit.status}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Score */}
                {(audit.status === 'complete' || audit.status === 'partial') && (
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-2xl font-bold text-text-primary">
                        {audit.totalScore}<span className="text-text-muted text-sm font-normal">/{audit.maxScore}</span>
                      </div>
                      <div className="text-xs text-text-muted">{Math.round(audit.percentage)}%</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Award className="w-4 h-4 text-primary" />
                      <span className={`badge ${gradeClass(audit.grade)}`}>{audit.grade}</span>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {(audit.status === 'complete' || audit.status === 'partial') && (
                    <>
                      <Link href={`/audit/${audit.id}/results`} className="btn-secondary text-xs px-3 py-2">
                        <Eye className="w-3.5 h-3.5" />
                        Results
                      </Link>
                      <button
                        onClick={() => handleDownloadPdf(audit.id)}
                        className="btn-ghost text-xs"
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        PDF
                      </button>
                    </>
                  )}
                  {audit.status === 'running' && (
                    <Link href={`/audit/${audit.id}/progress`} className="btn-secondary text-xs px-3 py-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Progress
                    </Link>
                  )}
                  <button
                    onClick={() => handleDelete(audit.id)}
                    disabled={deletingId === audit.id}
                    className="btn-danger text-xs px-3 py-2"
                  >
                    {deletingId === audit.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
