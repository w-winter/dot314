import { type Theme } from "@mariozechner/pi-coding-agent";
interface FencedBlock {
    lang: string | undefined;
    code: string;
    startIndex: number;
    endIndex: number;
}
/**
 * Parse fenced code blocks from text. Handles:
 * - Multiple blocks
 * - Various language identifiers
 * - Empty/missing language
 * - Unclosed fences (treated as extending to end)
 */
export declare function parseFencedBlocks(text: string): FencedBlock[];
/**
 * Render diff lines with syntax highlighting (red/green, word-level inverse)
 */
export declare function renderDiffBlock(code: string, theme: Theme): string;
export interface RenderOptions {
    expanded?: boolean;
    maxCollapsedLines?: number;
}
/**
 * Render RepoPrompt output with syntax highlighting for fenced code blocks.
 * - ```diff blocks get word-level diff highlighting
 * - Other fenced blocks get syntax highlighting via Pi's highlightCode
 * - Non-fenced content is rendered with markdown-aware styling
 */
export declare function renderRpOutput(text: string, theme: Theme, options?: RenderOptions): string;
/**
 * Prepare output for collapsed view (truncate if needed)
 */
export declare function prepareCollapsedView(text: string, theme: Theme, maxLines?: number): {
    content: string;
    truncated: boolean;
    totalLines: number;
};
export {};
