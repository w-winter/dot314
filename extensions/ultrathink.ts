/**
 * Ultrathink Extension - Rainbow animated "ultrathink" display
 *
 * Detects "ultrathink" AS YOU TYPE and shows rainbow animation.
 * Just like Claude Code - type u-l-t-r-a-t-h-i-n-k and watch the magic!
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Rainbow colors (RGB values for smooth gradient) - matches rainbow-editor style
const COLORS: [number, number, number][] = [
  [233, 137, 115], // coral
  [228, 186, 103], // yellow
  [141, 192, 122], // green
  [102, 194, 179], // teal
  [121, 157, 207], // blue
  [157, 134, 195], // purple
  [206, 130, 172], // pink
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function brighten(rgb: [number, number, number], factor: number): string {
  const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * factor));
  return `\x1b[38;2;${r};${g};${b}m`;
}

export default function (pi: ExtensionAPI) {
  let frame = 0;
  let animationInterval: ReturnType<typeof setInterval> | null = null;
  let editorWatchInterval: ReturnType<typeof setInterval> | null = null;
  let isShowingRainbow = false;
  let manualMode = false; // When true, don't auto-disable based on editor text
  let currentCtx: any = null;

  // Create rainbow text with shine effect - matches rainbow-editor style
  function colorize(text: string, shinePos: number): string {
    return (
      [...text]
        .map((c, i) => {
          const baseColor = COLORS[i % COLORS.length]!;
          // 3-letter shine: center bright, adjacent dimmer
          let factor = 0;
          if (shinePos >= 0) {
            const dist = Math.abs(i - shinePos);
            if (dist === 0) factor = 0.7;
            else if (dist === 1) factor = 0.35;
          }
          return `${brighten(baseColor, factor)}${c}${RESET}`;
        })
        .join("")
    );
  }

  // Create widget (appears right above the editor)
  function createWidget(): string[] {
    const text = "ultrathink";
    // 20-frame cycle: 10 shine positions + 10 pause frames
    const cycle = frame % 20;
    const shinePos = cycle < 10 ? cycle : -1; // -1 means no shine (pause)
    const rainbow = colorize(text, shinePos);
    return [`  ${rainbow} ${DIM}enabled${RESET}`];
  }

  // Start rainbow animation
  function startRainbow(ctx: any) {
    if (isShowingRainbow) return;

    currentCtx = ctx;
    isShowingRainbow = true;
    frame = 0;

    ctx.ui.setWidget("ultrathink", createWidget());

    animationInterval = setInterval(() => {
      frame++;
      ctx.ui.setWidget("ultrathink", createWidget());
    }, 60); // 60ms to match rainbow-editor timing
  }

  // Stop rainbow animation
  function stopRainbow() {
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
    }
    if (currentCtx) {
      currentCtx.ui.setWidget("ultrathink", undefined);
    }
    isShowingRainbow = false;
  }

  // Start watching editor for "ultrathink"
  function startEditorWatch(ctx: any) {
    if (editorWatchInterval) return;

    currentCtx = ctx;

    // Poll editor text frequently to detect typing
    editorWatchInterval = setInterval(() => {
      try {
        const text = ctx.ui.getEditorText?.() || "";
        const hasUltrathink = text.toLowerCase().includes("ultrathink");

        if (hasUltrathink && !isShowingRainbow) {
          manualMode = false; // Auto-detected, not manual
          startRainbow(ctx);
        } else if (!hasUltrathink && isShowingRainbow && !manualMode) {
          // Only auto-disable if not in manual mode
          stopRainbow();
        }
      } catch {
        // Ignore errors if UI not available
      }
    }, 50); // Check every 50ms for responsive detection
  }

  // Stop watching editor
  function stopEditorWatch() {
    if (editorWatchInterval) {
      clearInterval(editorWatchInterval);
      editorWatchInterval = null;
    }
    manualMode = false;
    stopRainbow();
  }

  // Start watching when session starts
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      startEditorWatch(ctx);
    }
  });

  // Also inject thinking instructions when prompt is sent
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.toLowerCase() || "";

    if (prompt.includes("ultrathink")) {
      return {
        systemPrompt: `${event.systemPrompt}\n\nThe user has requested ULTRATHINK mode. This means:\n- Think EXTREMELY deeply about the problem\n- Consider multiple approaches and their tradeoffs  \n- Be extra thorough in your analysis\n- Take your time to reason through complex aspects\n- Provide comprehensive, well-thought-out responses\n`,
      };
    }
  });

  // Keep rainbow going while agent runs if ultrathink was in prompt
  pi.on("agent_start", async (_event, ctx) => {
    const text = ctx.ui.getEditorText?.() || "";
    // Editor might be cleared, check if we were showing rainbow
    if (isShowingRainbow) {
      // Keep it going during response
    }
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    stopEditorWatch();
  });

  pi.on("session_switch", async () => {
    stopEditorWatch();
  });

  // Manual toggle command
  pi.registerCommand("ultrathink", {
    description: "Toggle ultrathink rainbow mode",
    handler: async (_args, ctx) => {
      if (isShowingRainbow && manualMode) {
        manualMode = false;
        stopRainbow();
        ctx.ui.notify("Ultrathink disabled", "info");
      } else {
        manualMode = true;
        startRainbow(ctx);
        // Append "ultrathink" to current editor text if not already there
        const currentText = ctx.ui.getEditorText?.() || "";
        if (!currentText.toLowerCase().includes("ultrathink")) {
          ctx.ui.setEditorText(currentText ? `${currentText}\n\nULTRATHINK` : "ULTRATHINK");
        }
        ctx.ui.notify("Ultrathink enabled - will be added to prompt", "success");
      }
    },
  });

}
