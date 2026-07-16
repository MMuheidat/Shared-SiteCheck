'use client';

import { useEffect, useState } from 'react';
import { Award } from 'lucide-react';

interface ScoreSummaryCardProps {
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
}

function gradeClass(grade: string): string {
  const g = grade.toLowerCase();
  if (g === 'excellent') return 'badge-excellent';
  if (g === 'good') return 'badge-good';
  if (g === 'satisfactory') return 'badge-satisfactory';
  return 'badge-needs-improvement';
}

function gradeColor(grade: string): string {
  const g = grade.toLowerCase();
  if (g === 'excellent') return '#059669';
  if (g === 'good') return '#2563eb';
  if (g === 'satisfactory') return '#d97706';
  return '#dc2626';
}

export default function ScoreSummaryCard({ totalScore, maxScore, percentage, grade }: ScoreSummaryCardProps) {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const color = gradeColor(grade);

  return (
    <div className="card-elevated p-8 flex flex-col items-center gap-6 animate-fade-in">
      {/* Donut Chart */}
      <div className="relative w-48 h-48">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          {/* Background track */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth="8"
          />
          {/* Animated fill */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={animated ? offset : circumference}
            style={{
              transition: 'stroke-dashoffset 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-4xl font-bold text-text-primary"
            style={{ color }}
          >
            {animated ? Math.round(percentage) : 0}%
          </span>
        </div>
      </div>

      {/* Score text */}
      <div className="text-center space-y-2">
        <p className="text-2xl font-bold text-text-primary">
          {totalScore} <span className="text-text-muted font-normal text-lg">/ {maxScore}</span>
        </p>
        <p className="text-sm text-text-secondary">Total Score</p>
      </div>

      {/* Grade Badge */}
      <div className="flex items-center gap-2">
        <Award className="w-5 h-5" style={{ color }} />
        <span className={`badge text-sm px-4 py-1.5 ${gradeClass(grade)}`}>
          {grade}
        </span>
      </div>
    </div>
  );
}
