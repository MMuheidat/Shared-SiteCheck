// ========== Criterion Result ==========
export interface CriterionResult {
  qid: string;
  criterionNameEN: string;
  criterionNameAR: string;
  pillar: string;
  subPillar: string;
  scoreEarned: number;
  maxScore: number;
  status: 'pass' | 'fail' | 'partial' | 'na' | 'skipped' | 'pending';
  screenshotPath: string | null;
  videoPath?: string | null; // per-pillar screen recording (.webm)
  notes: string;
  recommendation: string;
  isAutomatic?: boolean;
  checkType?: 'auto' | 'manual' | 'openended';
  dependsOn?: string;
}

// ========== Criterion Definition ==========
export interface CriterionDefinition {
  qid: string;
  nameEN: string;
  nameAR: string;
  pillar: string;
  pillarAR: string;
  subPillar: string;
  maxScore: number;
  isScored: boolean;
  isAutomatic?: boolean;
  checkType?: 'auto' | 'manual' | 'openended';
  dependsOn?: string; // Parent QID if conditional (e.g., 'Q4' for Q5)
  dependsOnValue?: string; // Expected value: 'yes', 'no', or specific option
  recommendation: string;
}

// ========== Audit Job ==========
export interface AuditJob {
  id: string;
  userId: string;
  websiteUrl: string;
  entityName: string;
  serviceName: string;
  evaluatorLanguage: string;
  deviceType: string;
  status: 'pending' | 'running' | 'complete' | 'partial' | 'failed';
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  createdAt: string;
  results?: CriterionResult[];
}

// ========== SSE Progress Event ==========
export interface ProgressEvent {
  type: 'criterion_start' | 'criterion_complete' | 'pillar_start' | 'pillar_complete' | 'audit_complete' | 'error';
  qid?: string;
  pillar?: string;
  status?: string;
  criterionName?: string;
  scoreEarned?: number;
  maxScore?: number;
  message?: string;
  progress?: number; // 0-100
  totalChecked?: number;
  totalCriteria?: number;
}

// ========== Pillar Score ==========
export interface PillarScore {
  pillar: string;
  pillarAR: string;
  earned: number;
  max: number;
  percentage: number;
}

// ========== Grade ==========
export type Grade = 'Excellent' | 'Good' | 'Satisfactory' | 'Needs Improvement';

// ========== Pillar Check Function ==========
export type PillarCheckFn = (params: {
  page: import('playwright').Page;
  url: string;
  auditJobId: string;
  entityName: string;
  /** Evaluator-supplied entity acronym (Q1b); empty string means auto-derive. */
  acronym: string;
  previousResults: CriterionResult[];
  /** Present when the engine records this pillar's run (screen-recording evidence). */
  recorder?: import('./engine/recording').EvidenceRecorder;
}) => Promise<CriterionResult[]>;
