const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyw": "python", ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".hpp": "cpp", ".hxx": "cpp",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".cs": "csharp",
  ".rb": "ruby", ".rake": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".xml": "xml", ".html": "html", ".css": "css", ".scss": "scss",
  ".sql": "sql",
  ".lua": "lua",
  ".zig": "zig",
  ".md": "markdown",
};

export function detectLanguageFromPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  if (lastDot === -1 || lastDot < lastSep) {
    return "text";
  }

  const ext = filePath.slice(lastDot).toLowerCase();
  return EXT_TO_LANG[ext] || "text";
}
