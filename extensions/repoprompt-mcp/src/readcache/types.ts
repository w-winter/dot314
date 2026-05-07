// readcache/types.ts - types for read_file caching layer

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SCOPE_FULL } from "./constants.js";

export type ScopeRangeKey = `r:${number}:${number}`;
export type ScopeKey = typeof SCOPE_FULL | ScopeRangeKey;

export interface ScopeTrust {
  hash: string;
  seq: number;
}

export type ReadCacheMode = "full" | "unchanged" | "unchanged_range" | "diff" | "baseline_fallback";

export type ReadCacheDebugReason =
  | "no_base_hash"
  | "hash_match"
  | "base_object_missing"
  | "range_slice_unchanged"
  | "range_slice_changed"
  | "diff_file_too_large_bytes"
  | "diff_file_too_large_lines"
  | "diff_unavailable_or_empty"
  | "diff_not_useful"
  | "diff_payload_truncated"
  | "diff_emitted"
  | "bypass_cache";

export interface ReadCacheDebugV1 {
  reason: ReadCacheDebugReason;
  scope: "full" | "range";
  baseHashFound: boolean;
  diffAttempted: boolean;
  outsideRangeChanged?: boolean;
  baseObjectFound?: boolean;
  largestBytes?: number;
  maxLines?: number;
  diffBytes?: number;
  diffChangedLines?: number;
}

export interface RpReadcacheMetaV1 {
  v: 1;
  tool: "read_file";
  pathKey: string;
  scopeKey: ScopeKey;
  servedHash: string;
  baseHash?: string;
  mode: ReadCacheMode;
  totalLines: number;
  rangeStart: number;
  rangeEnd: number;
  bytes: number;
  debug?: ReadCacheDebugV1;
}

export interface RpReadcacheInvalidationV1 {
  v: 1;
  kind: "invalidate";
  tool: "read_file";
  pathKey: string;
  scopeKey: ScopeKey;
  at: number;
}

export type KnowledgeMap = Map<string, Map<ScopeKey, ScopeTrust>>;

export interface ExtractedReplayData {
  entry: SessionEntry;
  read?: RpReadcacheMetaV1;
  invalidation?: RpReadcacheInvalidationV1;
}

export interface DiffLimits {
  maxFileBytes: number;
  maxFileLines: number;
  maxDiffToBaseRatio: number;
  maxDiffToBaseLineRatio: number;
}
