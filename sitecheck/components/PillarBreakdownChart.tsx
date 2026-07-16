'use client';

import { useEffect, useState } from 'react';
import type { PillarScore } from '@/lib/types';

interface PillarBreakdownChartProps {
  pillarScores: PillarScore[];
}

function barColor(percentage: number): string {
  if (percentage >= 80) return 'from-emerald-500 to-emerald-400';
  if (percentage >= 60) return 'from-blue-500 to-blue-400';
  if (percentage >= 40) return 'from-amber-500 to-amber-400';
  return 'from-red-500 to-red-400';
}

function barBg(percentage: number): string {
  if (percentage >= 80) return 'bg-emerald-50';
  if (percentage >= 60) return 'bg-blue-50';
  if (percentage >= 40) return 'bg-amber-50';
  return 'bg-red-50';
}

export default function PillarBreakdownChart({ pillarScores }: PillarBreakdownChartProps) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="card-elevated p-6 animate-fade-in">
      <h3 className="text-lg font-bold text-text-primary mb-6">Pillar Breakdown</h3>
      <div className="space-y-4">
        {pillarScores.map((pillar, index) => (
          <div
            key={pillar.pillar}
            className="group"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            {/* Label row */}
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-text-primary truncate pr-4 max-w-[60%]">
                {pillar.pillar}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-semibold text-text-secondary">
                  {pillar.earned}/{pillar.max}
                </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${barBg(pillar.percentage)}`}>
                  {Math.round(pillar.percentage)}%
                </span>
              </div>
            </div>

            {/* Bar */}
            <div className="h-3 bg-surface-darker rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full bg-gradient-to-r ${barColor(pillar.percentage)} transition-all duration-1000 ease-out`}
                style={{
                  width: animated ? `${Math.max(pillar.percentage, 2)}%` : '0%',
                  transitionDelay: `${index * 80}ms`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
