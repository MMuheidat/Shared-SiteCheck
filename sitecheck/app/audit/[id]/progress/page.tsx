'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, CheckCircle, Shield, Wifi, WifiOff } from 'lucide-react';
import PillarProgress from '@/components/PillarProgress';
import { useToast } from '@/components/Toast';
import type { ProgressEvent } from '@/lib/types';

interface CriterionState {
  qid: string;
  name: string;
  status: 'pass' | 'fail' | 'partial' | 'checking' | 'na' | 'skipped' | 'pending';
  score: number;
  maxScore: number;
}

interface PillarState {
  name: string;
  criteria: CriterionState[];
}

export default function ProgressPage() {
  const params = useParams();
  const router = useRouter();
  const { showToast } = useToast();
  const id = params.id as string;

  const [pillars, setPillars] = useState<Map<string, PillarState>>(new Map());
  const [expandedPillars, setExpandedPillars] = useState<Set<string>>(new Set());
  const [totalChecked, setTotalChecked] = useState(0);
  const [totalCriteria, setTotalCriteria] = useState(35);
  const [currentCriterion, setCurrentCriterion] = useState('');
  const [connected, setConnected] = useState(false);
  const [complete, setComplete] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback((event: ProgressEvent) => {
    switch (event.type) {
      case 'pillar_start':
        if (event.pillar) {
          setPillars((prev) => {
            const next = new Map(prev);
            if (!next.has(event.pillar!)) {
              next.set(event.pillar!, { name: event.pillar!, criteria: [] });
            }
            return next;
          });
          // Auto-expand current pillar
          setExpandedPillars((prev) => new Set(prev).add(event.pillar!));
        }
        break;

      case 'criterion_start':
        if (event.pillar && event.qid) {
          setCurrentCriterion(event.criterionName || event.qid);
          setPillars((prev) => {
            const next = new Map(prev);
            const pillar = next.get(event.pillar!) || { name: event.pillar!, criteria: [] };
            const existing = pillar.criteria.find((c) => c.qid === event.qid);
            if (!existing) {
              pillar.criteria.push({
                qid: event.qid!,
                name: event.criterionName || event.qid!,
                status: 'checking',
                score: 0,
                maxScore: event.maxScore || 0,
              });
            } else {
              existing.status = 'checking';
            }
            next.set(event.pillar!, { ...pillar, criteria: [...pillar.criteria] });
            return next;
          });
        }
        break;

      case 'criterion_complete':
        if (event.pillar && event.qid) {
          setPillars((prev) => {
            const next = new Map(prev);
            const pillar = next.get(event.pillar!);
            if (pillar) {
              const criterion = pillar.criteria.find((c) => c.qid === event.qid);
              if (criterion) {
                criterion.status = (event.status as CriterionState['status']) || 'pass';
                criterion.score = event.scoreEarned || 0;
                criterion.maxScore = event.maxScore || criterion.maxScore;
              }
              next.set(event.pillar!, { ...pillar, criteria: [...pillar.criteria] });
            }
            return next;
          });
          if (event.totalChecked !== undefined) {
            setTotalChecked(event.totalChecked);
          }
          if (event.totalCriteria !== undefined) {
            setTotalCriteria(event.totalCriteria);
          }
        }
        break;

      case 'audit_complete':
        setComplete(true);
        setCurrentCriterion('');
        break;

      case 'error':
        showToast(event.message || 'An error occurred during evaluation', 'error');
        break;
    }
  }, [showToast]);

  // Connect to SSE
  useEffect(() => {
    const connect = () => {
      const es = new EventSource(`/api/audit/${id}/stream`);
      eventSourceRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const data: ProgressEvent = JSON.parse(e.data);
          handleEvent(data);
        } catch {
          // Ignore parse errors
        }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        // Reconnect after 3 seconds
        if (!complete) {
          setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      eventSourceRef.current?.close();
    };
  }, [id, handleEvent, complete]);

  // Redirect when complete
  useEffect(() => {
    if (complete) {
      showToast('Evaluation complete! Redirecting to results...', 'success');
      const timer = setTimeout(() => {
        router.push(`/audit/${id}/results`);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [complete, id, router, showToast]);

  const progress = totalCriteria > 0 ? (totalChecked / totalCriteria) * 100 : 0;
  const pillarArray = Array.from(pillars.values());

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      <div className="animate-fade-in">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary-light text-white mb-4 shadow-lg shadow-primary/20">
            {complete ? (
              <CheckCircle className="w-8 h-8" />
            ) : (
              <Shield className="w-8 h-8 animate-pulse-soft" />
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary mb-2">
            {complete ? 'Evaluation Complete!' : 'Evaluation in Progress'}
          </h1>

          {/* Connection status */}
          <div className="flex items-center justify-center gap-2 text-sm mb-4">
            {connected ? (
              <span className="flex items-center gap-1.5 text-success">
                <Wifi className="w-4 h-4" />
                Connected — Live updates
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-text-muted">
                <WifiOff className="w-4 h-4" />
                Reconnecting...
              </span>
            )}
          </div>

          {/* Current criterion */}
          {currentCriterion && !complete && (
            <p className="text-sm text-text-secondary flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              Checking: {currentCriterion}
            </p>
          )}
        </div>

        {/* Overall Progress */}
        <div className="card-elevated p-6 mb-8">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-text-primary">Overall Progress</span>
            <span className="text-sm font-semibold text-primary">
              {totalChecked} / {totalCriteria} checks
            </span>
          </div>
          <div className="progress-track h-3">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-text-muted mt-2 text-right">
            {Math.round(progress)}% complete
          </p>
        </div>

        {/* Pillar sections */}
        <div className="space-y-3">
          {pillarArray.map((pillar) => (
            <PillarProgress
              key={pillar.name}
              pillarName={pillar.name}
              criteria={pillar.criteria}
              isExpanded={expandedPillars.has(pillar.name)}
              onToggle={() => {
                setExpandedPillars((prev) => {
                  const next = new Set(prev);
                  if (next.has(pillar.name)) {
                    next.delete(pillar.name);
                  } else {
                    next.add(pillar.name);
                  }
                  return next;
                });
              }}
            />
          ))}
        </div>

        {/* Empty state before events */}
        {pillarArray.length === 0 && !complete && (
          <div className="card-elevated p-12 text-center">
            <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" />
            <p className="text-text-secondary">Waiting for evaluation to begin...</p>
            <p className="text-xs text-text-muted mt-1">The browser engine is starting up</p>
          </div>
        )}
      </div>
    </div>
  );
}
