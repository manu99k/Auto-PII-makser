export type PiiEntityType =
  | 'PERSON'
  | 'SIN'
  | 'CANADIAN_BANK_ACCOUNT'
  | 'ADDRESS'
  | 'PHONE'
  | 'EMAIL'
  | 'CREDIT_CARD'
  | 'DOB'
  | 'LEGAL_CASE_ID'
  | 'PASSPORT'
  | 'CUSTOM';

export type RedactionMode = 'mask_and_replace' | 'whiteout_replace' | 'solid_mask';

export interface CustomRule {
  id: string;
  label: string;
  pattern: string;
  mockTemplate: string;
  enabled: boolean;
}

export interface BatchConfig {
  mode: RedactionMode;
  entities: PiiEntityType[];
  minConfidence: number;
  consistentMapping: boolean;
  seed: number;
  customRules: CustomRule[];
  scrubStream: boolean;
  ignoreCibcEmployees?: boolean;
}

export interface PiiOccurrence {
  id: string;
  page: number;
  entityType: PiiEntityType;
  ruleLabel?: string;
  original: string;
  replacement: string;
  confidence: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ProcessedFileResult {
  filename: string;
  relativePath: string;
  sizeBytes: number;
  outputSizeBytes: number;
  pages: number;
  entitiesFound: number;
  entitiesMasked: number;
  skippedBelowThreshold: number;
  entityCounts: Record<string, number>;
  elapsedMs: number;
  status: 'completed' | 'error';
  error?: string;
  streamVerifiedClean: boolean;
  occurrences: PiiOccurrence[];
  originalTextPreview: string;
  anonymizedTextPreview: string;
}

export interface BatchJobResult {
  jobId: string;
  createdAt: string;
  inputFolderLabel: string;
  outputFolderLabel: string;
  config: BatchConfig;
  totalFiles: number;
  succeeded: number;
  failed: number;
  totalPiiMasked: number;
  elapsedMs: number;
  files: ProcessedFileResult[];
}

export interface UploadedFileSummary {
  filename: string;
  relativePath: string;
  sizeBytes: number;
  pages?: number;
}
