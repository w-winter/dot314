type PatchAction = "add" | "update" | "delete";

interface PatchFileSection {
  action: PatchAction;
  path: string;
  movePath?: string;
  body: string[];
}

const FILE_HEADER_PATTERN = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_HEADER_PATTERN = /^\*\*\* Move to: (.+)$/;

function parseAction(value: string): PatchAction {
  switch (value) {
    case "Add":
      return "add";
    case "Update":
      return "update";
    case "Delete":
      return "delete";
    default:
      throw new Error(`Unsupported apply_patch action: ${value}`);
  }
}

function parsePatchSections(input: string): PatchFileSection[] {
  const lines = input.replace(/\r/g, "").split("\n");
  const sections: PatchFileSection[] = [];
  let current: PatchFileSection | undefined;

  for (const line of lines) {
    const fileHeader = line.match(FILE_HEADER_PATTERN);
    if (fileHeader) {
      current = {
        action: parseAction(fileHeader[1]!),
        path: fileHeader[2]!.trim(),
        body: [],
      };
      sections.push(current);
      continue;
    }

    if (line === "*** End Patch") {
      current = undefined;
      continue;
    }

    if (!current || line === "*** Begin Patch" || line === "*** End of File") {
      continue;
    }

    const moveHeader = line.match(MOVE_HEADER_PATTERN);
    if (moveHeader) {
      current.movePath = moveHeader[1]!.trim();
      continue;
    }

    current.body.push(line);
  }

  return sections;
}

function renderSection(section: PatchFileSection): string[] {
  if (section.action === "add") {
    return ["created file " + section.path, "@@", ...section.body];
  }

  if (section.action === "delete") {
    return ["deleted file " + section.path];
  }

  const fileHeading = section.movePath
    ? `moved file ${section.path} → ${section.movePath}`
    : `edited file ${section.path}`;
  return [fileHeading, ...section.body];
}

export function applyPatchInputToFileDiffs(input: string): string[] {
  const sections = parsePatchSections(input);
  if (sections.length === 0) {
    throw new Error("apply_patch input contains no file sections");
  }

  return sections.map((section) => renderSection(section).join("\n"));
}

export function applyPatchInputToDiff(input: string): string {
  return applyPatchInputToFileDiffs(input).join("\n\n");
}
