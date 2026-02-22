// types.ts - shared types for the repoprompt-cli extension

export interface RpCliConfig {
  // Optional read_file caching (pi-readcache-like behavior)
  readcacheReadFile?: boolean; // default: false

  // Optional context UX: automatically update RepoPrompt selection based on read_file calls
  // (tracks read slices/full files so chat has context without manual selection)
  autoSelectReadSlices?: boolean; // default: true
}

export interface RpCliBindingEntryData {
  windowId: number;
  tab: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoots?: string[];
}

export interface AutoSelectionEntryRangeData {
  start_line: number;
  end_line: number;
}

export interface AutoSelectionEntrySliceData {
  path: string;
  ranges: AutoSelectionEntryRangeData[];
}

export interface AutoSelectionEntryData {
  windowId: number;
  tab?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoots?: string[];
  fullPaths: string[];
  slicePaths: AutoSelectionEntrySliceData[];
}
