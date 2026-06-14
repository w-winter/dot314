// readcache/constants.ts - constants for read_file caching via rpce-cli

export const RP_READCACHE_META_VERSION = 1 as const;
export const RP_READCACHE_CUSTOM_TYPE = "repoprompt-cli-readcache" as const;

export const SCOPE_FULL = "full" as const;

export const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_FILE_LINES = 12_000;
export const MAX_DIFF_TO_BASE_RATIO = 0.9;
export const MAX_DIFF_TO_BASE_LINE_RATIO = 0.85;

export const DEFAULT_EXCLUDED_PATH_PATTERNS = [
    ".env*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.crt",
    "*.cer",
    "*.der",
    "*.pk8",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".netrc",
] as const;

// NOTE: share the same on-disk object store layout as pi-readcache
export const READCACHE_ROOT_DIR = ".pi/readcache";
export const READCACHE_OBJECTS_DIR = `${READCACHE_ROOT_DIR}/objects`;
export const READCACHE_TMP_DIR = `${READCACHE_ROOT_DIR}/tmp`;

export const READCACHE_OBJECT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function scopeRange(start: number, end: number): `r:${number}:${number}` {
    return `r:${start}:${end}`;
}
