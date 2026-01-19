#!/usr/bin/env npx tsx
/**
 * Dev-Browser CLI
 *
 * Token-efficient CLI wrapper for common browser automation tasks.
 * Usage: devbrowse <command> [args] [options]
 */

import { connect, waitForPageLoad, type DevBrowserClient } from "./client.js";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { Page, Frame, ElementHandle } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "1.1.0";
const DEFAULT_PAGE = "main";
const SERVER_URL = process.env.DB_SERVER_URL || "http://localhost:9222";

// State file for tracking current page context
const STATE_FILE = "/tmp/devbrowse-state.json";

interface CLIState {
  currentPage: string;
  currentFrame?: string; // frame index or name
}

function loadState(): CLIState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return { currentPage: DEFAULT_PAGE };
}

function saveState(state: CLIState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function getPageName(explicit?: string): string {
  if (explicit) return explicit;
  return loadState().currentPage;
}

function setCurrentPage(name: string): void {
  const state = loadState();
  state.currentPage = name;
  state.currentFrame = undefined; // Reset frame when switching pages
  saveState(state);
}

function setCurrentFrame(frame?: string): void {
  const state = loadState();
  state.currentFrame = frame;
  saveState(state);
}

function getCurrentFrame(): string | undefined {
  return loadState().currentFrame;
}

// Help text
const HELP = `
devbrowse v${VERSION} - Dev-Browser CLI

Usage: devbrowse <command> [args] [options]

Navigation:
  go <url>                    Navigate to URL
  back                        Go back in history
  forward                     Go forward in history
  reload                      Reload page

Reading:
  read                        Get accessibility tree (ARIA snapshot)
    --depth <n>               Limit tree depth (saves tokens)
    --compact                 Remove empty structural elements
  text                        Get page text content
  title                       Get page title
  url                         Get current URL
  html                        Get page HTML

Semantic Locators:
  locate role <role>          Find elements by ARIA role
    --name <text>             Filter by accessible name
    --action <act>            Perform action: click, fill, hover, focus
    --value <val>             Value for fill action
    --all                     Return all matches
  locate text <text>          Find element by text content
    --exact                   Exact match only
    --action <act>            Perform action: click, fill, hover, focus
  locate label <text>         Find form field by label
    --action <act>            Perform action: click, fill, hover, focus
    --value <val>             Value for fill action

Interaction:
  click <ref>                 Click element by ref (e.g., e5)
    --selector <sel>          Click by CSS selector instead
    --x <n> --y <n>           Click by coordinates
    --button <btn>            Button: left, right, middle
    --count <n>               Click count (2 for double-click)
  type <text>                 Type text (use --ref for specific element)
    --ref <ref>               Target element
    --submit                  Press Enter after typing
  fill <ref> <text>           Fill input element
  select <ref> <value>        Select option in dropdown
  hover <ref>                 Hover over element
  focus <ref>                 Focus element
  clear <ref>                 Clear input element
  press <key>                 Press key (Enter, Escape, Tab, etc.)

Scrolling:
  scroll top                  Scroll to top of page
  scroll bottom               Scroll to bottom of page
  scroll to <ref>             Scroll element into view
  scroll by <deltaY>          Scroll by pixels (negative = up)
  scroll info                 Get scroll position info

Frames:
  frame list                  List all frames
  frame switch <index|name>   Switch to frame by index or name
    --selector <sel>          Switch by CSS selector
  frame main                  Return to main frame

Screenshots:
  snap [path]                 Screenshot (default: /tmp/devbrowse-snap.png)
    --full                    Full page screenshot

Waiting:
  wait <seconds>              Wait N seconds
  wait-for <selector>         Wait for element
  wait-load                   Wait for page load
  wait-url <pattern>          Wait for URL to match pattern
  wait-network                Wait for network idle

Pages:
  pages                       List all pages
  page <name>                 Switch to/create page
  close [name]                Close page (default: current)
  use <name>                  Set default page for subsequent commands

Data:
  cookies                     List cookies
  cookie <name>               Get specific cookie
  js <code>                   Execute JavaScript
  eval <code>                 Alias for js

Network:
  intercept-start             Start logging requests (to /tmp/devbrowse-requests.jsonl)
  intercept-stop              Stop logging requests

Server:
  server                      Check server status

Options:
  --page, -p <name>           Target specific page (default: main)
  --json                      Output as JSON
  --help, -h                  Show this help
  --version, -v               Show version

Examples:
  devbrowse go "https://example.com"
  devbrowse read --depth 3 --compact
  devbrowse click e5
  devbrowse click --selector ".btn-primary"
  devbrowse locate role button --name "Submit" --action click
  devbrowse locate text "Sign In" --action click
  devbrowse scroll bottom
  devbrowse frame list
  devbrowse frame switch 0
`;

// Parse arguments
function parseArgs(args: string[]): { command: string; args: string[]; opts: Record<string, string | boolean> } {
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        opts[key] = next;
        i += 2;
      } else {
        opts[key] = true;
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      // Map short flags
      const longKey = { p: "page", h: "help", v: "version", o: "output", r: "ref", s: "submit", f: "full", n: "name", a: "action", x: "x", y: "y" }[key] || key;
      if (next && !next.startsWith("-")) {
        opts[longKey] = next;
        i += 2;
      } else {
        opts[longKey] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return {
    command: positional[0] || "",
    args: positional.slice(1),
    opts,
  };
}

// Output helper
function output(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else if (data !== undefined && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Error helper
function error(msg: string, exitCode = 1): never {
  console.error(`Error: ${msg}`);
  process.exit(exitCode);
}

// Get the current frame or page
async function getFrameOrPage(page: Page): Promise<Page | Frame> {
  const frameId = getCurrentFrame();
  if (!frameId) return page;

  const frames = page.frames();
  
  // Try by index
  const index = parseInt(frameId);
  if (!isNaN(index) && index >= 0 && index < frames.length) {
    return frames[index];
  }
  
  // Try by name
  const namedFrame = frames.find(f => f.name() === frameId);
  if (namedFrame) return namedFrame;
  
  // Not found, reset to main
  setCurrentFrame(undefined);
  return page;
}

// Filter snapshot by depth
function filterSnapshotByDepth(snapshot: string, maxDepth: number): string {
  const lines = snapshot.split("\n");
  const result: string[] = [];
  
  for (const line of lines) {
    // Count leading spaces (2 spaces = 1 indent level)
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    const depth = Math.floor(indent / 2);
    
    if (depth <= maxDepth) {
      result.push(line);
    }
  }
  
  return result.join("\n");
}

// Remove empty structural elements from snapshot
function compactSnapshot(snapshot: string): string {
  const lines = snapshot.split("\n");
  const result: string[] = [];
  
  // Elements that are structural and can be removed if empty
  const structuralRoles = ["generic", "group", "region", "section", "article", "main", "complementary", "navigation"];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) continue;
    
    // Check if this is a structural element without content
    const isStructural = structuralRoles.some(role => trimmed.startsWith(`- ${role}:`) || trimmed.startsWith(`- ${role} `));
    
    if (isStructural && !trimmed.includes("[ref=")) {
      // Check if next line is at same or lower indent level (meaning this is empty)
      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
      const nextLine = lines[i + 1];
      const nextIndent = nextLine ? (nextLine.match(/^(\s*)/)?.[1].length || 0) : 0;
      
      if (!nextLine || nextIndent <= currentIndent) {
        continue; // Skip this empty structural element
      }
    }
    
    result.push(line);
  }
  
  return result.join("\n");
}

// Main CLI handler
async function main(): Promise<void> {
  const { command, args: cmdArgs, opts } = parseArgs(process.argv.slice(2));

  // Handle help/version
  if (opts.help || command === "help") {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    console.log(`devbrowse v${VERSION}`);
    return;
  }
  if (!command) {
    console.log(HELP);
    return;
  }

  const asJson = !!opts.json;
  const pageName = getPageName(opts.page as string);

  // Commands that don't need connection
  if (command === "use") {
    const name = cmdArgs[0] || DEFAULT_PAGE;
    setCurrentPage(name);
    output({ currentPage: name }, asJson);
    return;
  }

  // Server status command
  if (command === "server") {
    try {
      const res = await fetch(SERVER_URL);
      if (res.ok) {
        const info = await res.json();
        output({
          running: true,
          url: SERVER_URL,
          mode: info.mode || "standalone",
          extensionConnected: info.extensionConnected ?? "n/a",
        }, asJson);
      } else {
        output({ running: false, url: SERVER_URL }, asJson);
      }
    } catch {
      output({ running: false, url: SERVER_URL }, asJson);
    }
    return;
  }

  // Check if server is running
  let serverInfo: { wsEndpoint: string; mode?: string; extensionConnected?: boolean } | null = null;
  try {
    const res = await fetch(SERVER_URL);
    if (res.ok) {
      serverInfo = await res.json();
    }
  } catch {
    // Server not running
  }

  if (!serverInfo) {
    error(`Server not running. Start it first:

  cd ~/.pi/agent/skills/dev-browser && npm run start-extension

(Keep that terminal open, then use devbrowse in another terminal)`);
  }

  if (serverInfo.mode === "extension" && !serverInfo.extensionConnected) {
    error(`Server running but Chrome extension not connected.

1. Install the dev-browser extension: https://github.com/SawyerHood/dev-browser/releases
2. Load as unpacked extension in Chrome (chrome://extensions → Developer mode → Load unpacked)
3. Click the extension icon to connect`);
  }

  // Connect client
  let client: DevBrowserClient;
  try {
    client = await connect(SERVER_URL);
  } catch (e) {
    error(`Failed to connect: ${(e as Error).message}`);
  }

  try {
    switch (command) {
      // === Navigation ===
      case "go":
      case "navigate": {
        const url = cmdArgs[0];
        if (!url) error("Usage: devbrowse go <url>");
        const page = await client.page(pageName);
        await page.goto(url);
        await waitForPageLoad(page);
        output({ url: page.url(), title: await page.title() }, asJson);
        break;
      }

      case "back": {
        const page = await client.page(pageName);
        await page.goBack();
        await waitForPageLoad(page);
        output({ url: page.url() }, asJson);
        break;
      }

      case "forward": {
        const page = await client.page(pageName);
        await page.goForward();
        await waitForPageLoad(page);
        output({ url: page.url() }, asJson);
        break;
      }

      case "reload": {
        const page = await client.page(pageName);
        await page.reload();
        await waitForPageLoad(page);
        output({ url: page.url() }, asJson);
        break;
      }

      // === Reading ===
      case "read":
      case "snapshot": {
        let snapshot = await client.getAISnapshot(pageName);
        
        // Apply depth filter
        if (opts.depth) {
          const depth = parseInt(opts.depth as string);
          if (!isNaN(depth)) {
            snapshot = filterSnapshotByDepth(snapshot, depth);
          }
        }
        
        // Apply compact filter
        if (opts.compact) {
          snapshot = compactSnapshot(snapshot);
        }
        
        output(snapshot, false);
        break;
      }

      case "text": {
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        const text = await frame.evaluate(() => document.body.innerText);
        output(text, false);
        break;
      }

      case "title": {
        const page = await client.page(pageName);
        const title = await page.title();
        output(asJson ? { title } : title, asJson);
        break;
      }

      case "url": {
        const page = await client.page(pageName);
        output(asJson ? { url: page.url() } : page.url(), asJson);
        break;
      }

      case "html": {
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        const html = await frame.content();
        output(html, false);
        break;
      }

      // === Semantic Locators ===
      case "locate": {
        const locateType = cmdArgs[0]; // role, text, or label
        const locateValue = cmdArgs[1];
        
        if (!locateType || !locateValue) {
          error("Usage: devbrowse locate <role|text|label> <value> [--action click|fill|hover|focus]");
        }
        
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        const action = opts.action as string;
        const value = opts.value as string;
        
        let elements: ElementHandle<Element>[] = [];
        let locator;
        
        switch (locateType) {
          case "role": {
            const role = locateValue as Parameters<typeof frame.getByRole>[0];
            const roleOpts: Parameters<typeof frame.getByRole>[1] = {};
            if (opts.name) roleOpts.name = opts.name as string;
            locator = frame.getByRole(role, roleOpts);
            break;
          }
          case "text": {
            if (opts.exact) {
              locator = frame.getByText(locateValue, { exact: true });
            } else {
              locator = frame.getByText(locateValue);
            }
            break;
          }
          case "label": {
            locator = frame.getByLabel(locateValue);
            break;
          }
          default:
            error(`Unknown locate type: ${locateType}. Use: role, text, or label`);
        }
        
        // Perform action or return info
        if (action) {
          switch (action) {
            case "click":
              await locator.first().click();
              output({ action: "click", type: locateType, value: locateValue }, asJson);
              break;
            case "fill":
              if (!value) error("--value required for fill action");
              await locator.first().fill(value);
              output({ action: "fill", type: locateType, value: locateValue, fillValue: value }, asJson);
              break;
            case "hover":
              await locator.first().hover();
              output({ action: "hover", type: locateType, value: locateValue }, asJson);
              break;
            case "focus":
              await locator.first().focus();
              output({ action: "focus", type: locateType, value: locateValue }, asJson);
              break;
            default:
              error(`Unknown action: ${action}. Use: click, fill, hover, focus`);
          }
        } else {
          // Just return count/info
          const count = await locator.count();
          if (opts.all) {
            const texts: string[] = [];
            for (let i = 0; i < count; i++) {
              const text = await locator.nth(i).textContent();
              texts.push(text || "");
            }
            output({ type: locateType, value: locateValue, count, elements: texts }, asJson);
          } else {
            const text = count > 0 ? await locator.first().textContent() : null;
            output({ type: locateType, value: locateValue, count, firstText: text }, asJson);
          }
        }
        break;
      }

      // === Interaction ===
      case "click": {
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        
        const button = (opts.button as string) || "left";
        const clickCount = parseInt(opts.count as string) || 1;
        
        if (opts.selector) {
          // Click by CSS selector
          await frame.click(opts.selector as string, { 
            button: button as "left" | "right" | "middle",
            clickCount 
          });
          output({ clicked: opts.selector, method: "selector" }, asJson);
        } else if (opts.x && opts.y) {
          // Click by coordinates
          const x = parseInt(opts.x as string);
          const y = parseInt(opts.y as string);
          await page.mouse.click(x, y, { 
            button: button as "left" | "right" | "middle",
            clickCount 
          });
          output({ clicked: { x, y }, method: "coordinates" }, asJson);
        } else {
          // Click by ref
          const ref = cmdArgs[0];
          if (!ref) error("Usage: devbrowse click <ref> OR --selector <sel> OR --x <n> --y <n>");
          const element = await client.selectSnapshotRef(pageName, ref);
          if (!element) error(`Element ${ref} not found. Run 'devbrowse read' first.`);
          await element.click({ 
            button: button as "left" | "right" | "middle",
            clickCount 
          });
          output({ clicked: ref, method: "ref" }, asJson);
        }
        break;
      }

      case "type": {
        const text = cmdArgs[0];
        if (!text) error("Usage: devbrowse type <text> [--ref eN] [--submit]");
        const page = await client.page(pageName);
        
        if (opts.ref) {
          const element = await client.selectSnapshotRef(pageName, opts.ref as string);
          if (!element) error(`Element ${opts.ref} not found`);
          await element.type(text);
        } else {
          await page.keyboard.type(text);
        }
        
        if (opts.submit) {
          await page.keyboard.press("Enter");
        }
        output({ typed: text, ref: opts.ref || "keyboard", submit: !!opts.submit }, asJson);
        break;
      }

      case "fill": {
        const ref = cmdArgs[0];
        const text = cmdArgs[1];
        if (!ref || text === undefined) error("Usage: devbrowse fill <ref> <text>");
        const element = await client.selectSnapshotRef(pageName, ref);
        if (!element) error(`Element ${ref} not found`);
        await element.fill(text);
        output({ filled: ref, text }, asJson);
        break;
      }

      case "select": {
        const ref = cmdArgs[0];
        const value = cmdArgs[1];
        if (!ref || !value) error("Usage: devbrowse select <ref> <value>");
        const element = await client.selectSnapshotRef(pageName, ref);
        if (!element) error(`Element ${ref} not found`);
        await element.selectOption(value);
        output({ selected: ref, value }, asJson);
        break;
      }

      case "hover": {
        const ref = cmdArgs[0];
        if (!ref) error("Usage: devbrowse hover <ref>");
        const element = await client.selectSnapshotRef(pageName, ref);
        if (!element) error(`Element ${ref} not found`);
        await element.hover();
        output({ hovered: ref }, asJson);
        break;
      }

      case "focus": {
        const ref = cmdArgs[0];
        if (!ref) error("Usage: devbrowse focus <ref>");
        const element = await client.selectSnapshotRef(pageName, ref);
        if (!element) error(`Element ${ref} not found`);
        await element.focus();
        output({ focused: ref }, asJson);
        break;
      }

      case "clear": {
        const ref = cmdArgs[0];
        if (!ref) error("Usage: devbrowse clear <ref>");
        const element = await client.selectSnapshotRef(pageName, ref);
        if (!element) error(`Element ${ref} not found`);
        await element.fill("");
        output({ cleared: ref }, asJson);
        break;
      }

      case "press":
      case "key": {
        const key = cmdArgs[0];
        if (!key) error("Usage: devbrowse press <key>");
        const page = await client.page(pageName);
        await page.keyboard.press(key);
        output({ pressed: key }, asJson);
        break;
      }

      // === Scrolling ===
      case "scroll": {
        const subCmd = cmdArgs[0];
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        
        switch (subCmd) {
          case "top":
            await frame.evaluate(() => window.scrollTo(0, 0));
            output({ scrolled: "top" }, asJson);
            break;
          case "bottom":
            await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            output({ scrolled: "bottom" }, asJson);
            break;
          case "to": {
            const ref = cmdArgs[1];
            if (!ref) error("Usage: devbrowse scroll to <ref>");
            const element = await client.selectSnapshotRef(pageName, ref);
            if (!element) error(`Element ${ref} not found`);
            await element.scrollIntoViewIfNeeded();
            output({ scrolled: "to", ref }, asJson);
            break;
          }
          case "by": {
            const deltaY = parseInt(cmdArgs[1] || "0");
            await frame.evaluate((dy) => window.scrollBy(0, dy), deltaY);
            output({ scrolled: "by", deltaY }, asJson);
            break;
          }
          case "info": {
            const info = await frame.evaluate(() => ({
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              scrollHeight: document.body.scrollHeight,
              scrollWidth: document.body.scrollWidth,
              clientHeight: document.documentElement.clientHeight,
              clientWidth: document.documentElement.clientWidth,
            }));
            output(info, asJson);
            break;
          }
          default:
            error("Usage: devbrowse scroll <top|bottom|to|by|info>");
        }
        break;
      }

      // === Frames ===
      case "frame": {
        const subCmd = cmdArgs[0];
        const page = await client.page(pageName);
        
        switch (subCmd) {
          case "list": {
            const frames = page.frames();
            const frameInfo = frames.map((f, i) => ({
              index: i,
              name: f.name() || "(unnamed)",
              url: f.url(),
            }));
            output(frameInfo, asJson);
            break;
          }
          case "switch": {
            if (opts.selector) {
              // Switch by selector
              const frameElement = await page.$(opts.selector as string);
              if (!frameElement) error(`Frame not found: ${opts.selector}`);
              const frame = await frameElement.contentFrame();
              if (!frame) error(`Element is not a frame: ${opts.selector}`);
              // Find frame index
              const frames = page.frames();
              const index = frames.indexOf(frame);
              setCurrentFrame(index.toString());
              output({ frame: opts.selector, index }, asJson);
            } else {
              const frameId = cmdArgs[1];
              if (!frameId) error("Usage: devbrowse frame switch <index|name> OR --selector <sel>");
              setCurrentFrame(frameId);
              output({ frame: frameId }, asJson);
            }
            break;
          }
          case "main":
            setCurrentFrame(undefined);
            output({ frame: "main" }, asJson);
            break;
          default:
            error("Usage: devbrowse frame <list|switch|main>");
        }
        break;
      }

      // === Screenshots ===
      case "snap":
      case "screenshot": {
        const page = await client.page(pageName);
        const outputPath = cmdArgs[0] || (opts.output as string) || "/tmp/devbrowse-snap.png";
        const fullPage = !!opts.full || !!opts.fullpage;
        await page.screenshot({ path: outputPath, fullPage });
        output({ screenshot: outputPath, fullPage }, asJson);
        break;
      }

      // === Waiting ===
      case "wait": {
        const seconds = parseFloat(cmdArgs[0] || "1");
        await new Promise((r) => setTimeout(r, seconds * 1000));
        output({ waited: seconds }, asJson);
        break;
      }

      case "wait-for": {
        const selector = cmdArgs[0];
        if (!selector) error("Usage: devbrowse wait-for <selector>");
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        const timeout = parseInt(opts.timeout as string) || 30000;
        await frame.waitForSelector(selector, { timeout });
        output({ found: selector }, asJson);
        break;
      }

      case "wait-load": {
        const page = await client.page(pageName);
        const result = await waitForPageLoad(page);
        output(result, asJson);
        break;
      }

      case "wait-url": {
        const pattern = cmdArgs[0];
        if (!pattern) error("Usage: devbrowse wait-url <pattern>");
        const page = await client.page(pageName);
        const timeout = parseInt(opts.timeout as string) || 30000;
        await page.waitForURL(pattern.includes("*") ? pattern : `**${pattern}**`, { timeout });
        output({ url: page.url() }, asJson);
        break;
      }

      case "wait-network": {
        const page = await client.page(pageName);
        const timeout = parseInt(opts.timeout as string) || 30000;
        await page.waitForLoadState("networkidle", { timeout });
        output({ networkIdle: true }, asJson);
        break;
      }

      // === Pages ===
      case "pages":
      case "list": {
        const pages = await client.list();
        output(asJson ? { pages } : pages.join("\n"), asJson);
        break;
      }

      case "page": {
        const name = cmdArgs[0];
        if (!name) error("Usage: devbrowse page <name>");
        await client.page(name);
        setCurrentPage(name);
        output({ page: name, status: "active" }, asJson);
        break;
      }

      case "close": {
        const name = cmdArgs[0] || pageName;
        await client.close(name);
        if (name === loadState().currentPage) {
          setCurrentPage(DEFAULT_PAGE);
        }
        output({ closed: name }, asJson);
        break;
      }

      // === Data ===
      case "cookies": {
        const page = await client.page(pageName);
        const cookies = await page.context().cookies();
        if (asJson) {
          output(cookies, true);
        } else {
          for (const c of cookies) {
            console.log(`${c.name}=${c.value}`);
          }
        }
        break;
      }

      case "cookie": {
        const name = cmdArgs[0];
        if (!name) error("Usage: devbrowse cookie <name>");
        const page = await client.page(pageName);
        const cookies = await page.context().cookies();
        const cookie = cookies.find((c) => c.name === name);
        if (cookie) {
          output(asJson ? cookie : cookie.value, asJson);
        } else {
          error(`Cookie '${name}' not found`);
        }
        break;
      }

      case "js":
      case "eval":
      case "evaluate": {
        const code = cmdArgs.join(" ");
        if (!code) error("Usage: devbrowse js <code>");
        const page = await client.page(pageName);
        const frame = await getFrameOrPage(page);
        const wrappedCode = code.includes("await")
          ? `(async () => { ${code} })()`
          : code;
        const result = await frame.evaluate(wrappedCode);
        output(result, asJson);
        break;
      }

      // === Network Interception ===
      case "intercept-start": {
        const page = await client.page(pageName);
        const logFile = (opts.output as string) || "/tmp/devbrowse-requests.jsonl";
        
        page.on("request", (request) => {
          const entry = {
            type: "request",
            timestamp: new Date().toISOString(),
            method: request.method(),
            url: request.url(),
            headers: request.headers(),
            postData: request.postData(),
          };
          appendFileSync(logFile, JSON.stringify(entry) + "\n");
        });
        
        page.on("response", async (response) => {
          try {
            const entry = {
              type: "response",
              timestamp: new Date().toISOString(),
              url: response.url(),
              status: response.status(),
              headers: response.headers(),
            };
            appendFileSync(logFile, JSON.stringify(entry) + "\n");
          } catch {}
        });
        
        output({ intercepting: true, logFile }, asJson);
        break;
      }

      case "intercept-stop": {
        output({ intercepting: false, note: "Listeners remain until page is closed" }, asJson);
        break;
      }

      default:
        error(`Unknown command: ${command}\nRun 'devbrowse --help' for usage.`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
