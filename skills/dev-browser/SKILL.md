---
disable-model-invocation: true
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser Skill

Browser automation that maintains page state across interactions. Two interfaces available:

1. **CLI (`db`)** — Token-efficient commands for common operations
2. **Scripts** — Full Playwright API access for complex workflows

## Quick Start

**One-time setup:** Install the dev-browser Chrome extension from https://github.com/SawyerHood/dev-browser/releases

**Each session:**

```bash
# Terminal 1: Start the relay server (keep this running)
cd ~/.pi/agent/skills/dev-browser && npm run start-extension
# Wait for "Extension connected" message

# Terminal 2: Use the CLI
devbrowse go "https://example.com"
devbrowse read
devbrowse click e5
devbrowse snap
```

Check server status anytime with `devbrowse server`.

---

## CLI Reference (`devbrowse`)

The `devbrowse` CLI provides token-efficient commands for common browser automation tasks.

### Setup

```bash
# Add to PATH (optional, for convenience)
export PATH="$PATH:$HOME/.pi/agent/skills/dev-browser"

# Or run directly
~/.pi/agent/skills/dev-browser/devbrowse <command>
```

### Navigation

```bash
devbrowse go <url>              # Navigate to URL
devbrowse back                  # Go back in history
devbrowse forward               # Go forward
devbrowse reload                # Reload page
```

### Reading Page State

```bash
devbrowse read                  # Get accessibility tree (ARIA snapshot with refs)
devbrowse read --depth 3        # Limit tree depth (saves tokens)
devbrowse read --compact        # Remove empty structural elements
devbrowse read --depth 3 --compact  # Both (60%+ smaller output)
devbrowse text                  # Get page text content
devbrowse title                 # Get page title
devbrowse url                   # Get current URL
devbrowse html                  # Get page HTML
```

### Semantic Locators

Find and interact with elements by role, text, or label—no refs needed:

```bash
# By ARIA role
devbrowse locate role button --name "Submit"              # Find button
devbrowse locate role button --name "Submit" --action click   # Find and click
devbrowse locate role textbox --action fill --value "hello"   # Find and fill
devbrowse locate role link --all                          # List all links

# By text content
devbrowse locate text "Sign In" --action click            # Click by text
devbrowse locate text "Accept" --exact --action click     # Exact match

# By form label
devbrowse locate label "Email" --action fill --value "test@example.com"
```

### Interaction

```bash
devbrowse click <ref>           # Click element by ref (e.g., e5)
devbrowse click --selector ".btn"   # Click by CSS selector
devbrowse click --x 100 --y 200     # Click by coordinates
devbrowse click e5 --button right   # Right-click
devbrowse click e5 --count 2        # Double-click
devbrowse type <text>           # Type text at cursor
devbrowse type <text> --ref e3  # Type into specific element
devbrowse type <text> --submit  # Type and press Enter
devbrowse fill <ref> <text>     # Fill input (clears first)
devbrowse select <ref> <value>  # Select dropdown option
devbrowse hover <ref>           # Hover over element
devbrowse focus <ref>           # Focus element
devbrowse clear <ref>           # Clear input
devbrowse press <key>           # Press key (Enter, Escape, Tab, etc.)
```

### Scrolling

```bash
devbrowse scroll top            # Scroll to top
devbrowse scroll bottom         # Scroll to bottom
devbrowse scroll to <ref>       # Scroll element into view
devbrowse scroll by 500         # Scroll down 500px (negative = up)
devbrowse scroll info           # Get scroll position/dimensions
```

### Frames (iframes)

```bash
devbrowse frame list            # List all frames
devbrowse frame switch 0        # Switch to frame by index
devbrowse frame switch "name"   # Switch to frame by name
devbrowse frame switch --selector "#iframe"  # Switch by CSS selector
devbrowse frame main            # Return to main frame
```

After switching frames, commands like `read`, `click`, `text` operate within that frame.

### Screenshots

```bash
devbrowse snap                  # Screenshot to /tmp/devbrowse-snap.png
devbrowse snap /path/to/file.png
devbrowse snap --full           # Full page screenshot
```

### Waiting

```bash
devbrowse wait <seconds>        # Wait N seconds
devbrowse wait-for <selector>   # Wait for CSS selector
devbrowse wait-load             # Wait for page load
devbrowse wait-url "/dashboard" # Wait for URL to match pattern
devbrowse wait-network          # Wait for network idle
```

### Page Management

```bash
devbrowse pages                 # List all pages
devbrowse page <name>           # Switch to/create page (and set as default)
devbrowse use <name>            # Set default page for subsequent commands
devbrowse close [name]          # Close page (default: current)
```

### Data Extraction

```bash
devbrowse cookies               # List all cookies
devbrowse cookie <name>         # Get specific cookie value
devbrowse js <code>             # Execute JavaScript and return result
```

### Network Interception

```bash
devbrowse intercept-start       # Start logging requests to /tmp/devbrowse-requests.jsonl
devbrowse intercept-stop        # Stop logging
```

### Global Options

```bash
--page, -p <name>        # Target specific page (default: main)
--json                   # Output as JSON
--help, -h               # Show help
```

### Examples

```bash
# Basic navigation and interaction
devbrowse go "https://news.ycombinator.com"
devbrowse read --depth 3 --compact
devbrowse click e5

# Using semantic locators (no refs needed)
devbrowse go "https://example.com/login"
devbrowse locate label "Email" --action fill --value "user@example.com"
devbrowse locate label "Password" --action fill --value "secret"
devbrowse locate role button --name "Sign In" --action click
devbrowse wait-url "/dashboard"

# Working with iframes
devbrowse frame list
devbrowse frame switch 0
devbrowse read
devbrowse click e3
devbrowse frame main

# Scrolling through content
devbrowse scroll bottom
devbrowse scroll to e15
devbrowse scroll info

# Extract data
devbrowse js "return document.querySelectorAll('.item').length"
devbrowse cookies
devbrowse cookie "session_token"

# Screenshot after action
devbrowse click e10
devbrowse snap /tmp/after-click.png
```

---

## Script-Based Approach

For complex workflows requiring full Playwright API access (request interception, complex conditionals, loops), write TypeScript scripts.

### When to Use Scripts vs CLI

| Use Case | CLI (`devbrowse`) | Scripts |
|----------|-------------------|---------|
| Navigation | ✅ | |
| Click/type/fill | ✅ | |
| Semantic locators | ✅ | |
| Read page (with depth/compact) | ✅ | |
| Screenshots | ✅ | |
| Scrolling | ✅ | |
| Frame switching | ✅ | |
| Wait for element/URL/network | ✅ | |
| Request interception | ⚠️ Basic logging | ✅ Full (modify/mock) |
| Complex scraping loops | | ✅ |
| Conditional logic | | ✅ |
| API replay with auth | | ✅ |

### Writing Scripts

Run scripts from the `skills/dev-browser/` directory:

```bash
cd ~/.pi/agent/skills/dev-browser && npx tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect();
const page = await client.page("example");

await page.goto("https://example.com");
await waitForPageLoad(page);

console.log({ title: await page.title(), url: page.url() });
await client.disconnect();
EOF
```

### Request Interception (Scripts Only)

```typescript
import { connect, waitForPageLoad } from "@/client.js";
import * as fs from "node:fs";

const client = await connect();
const page = await client.page("api-capture");

// Capture API responses
page.on("response", async (response) => {
  if (response.url().includes("/api/")) {
    const data = await response.json();
    fs.appendFileSync("/tmp/api-log.jsonl", JSON.stringify({
      url: response.url(),
      status: response.status(),
      data
    }) + "\n");
  }
});

await page.goto("https://example.com");
await waitForPageLoad(page);

// Trigger API calls...
await client.disconnect();
```

### Request Modification (Scripts Only)

```typescript
// Block images
page.route('**/*.{png,jpg,gif}', route => route.abort());

// Mock API response
page.route('**/api/user', route => route.fulfill({
  status: 200,
  body: JSON.stringify({ name: 'Test User' })
}));

// Modify request
page.route('**/api/**', async route => {
  const response = await route.fetch();
  const json = await response.json();
  json.modified = true;
  await route.fulfill({ json });
});
```

### Client API Reference

```typescript
const client = await connect();

// Page management
const page = await client.page("name");
const page = await client.page("name", { viewport: { width: 1920, height: 1080 } });
const pages = await client.list();
await client.close("name");
await client.disconnect();

// ARIA Snapshot (same as `db read`)
const snapshot = await client.getAISnapshot("name");
const element = await client.selectSnapshotRef("name", "e5");
```

---

## Server Modes

### Extension Mode (Recommended)

Connects to your existing Chrome browser with all your logged-in sessions, cookies, and extensions.

```bash
cd ~/.pi/agent/skills/dev-browser
npm run start-extension
```

Wait for `Extension connected` message. Requires the dev-browser Chrome extension:
1. Download from: https://github.com/SawyerHood/dev-browser/releases
2. Unzip and load as unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked)
3. Click the extension icon to connect

### Standalone Mode

Launches a fresh Chromium browser (no existing sessions/cookies). Downloads Chromium on first run.

```bash
cd ~/.pi/agent/skills/dev-browser
./server.sh            # Headed
./server.sh --headless # Headless
```

---

## ARIA Snapshot Format

The `devbrowse read` command (and `client.getAISnapshot()`) returns a YAML accessibility tree:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
- main:
  - list:
    - listitem:
      - link "Article Title" [ref=e8]
      - link "328 comments" [ref=e9]
- contentinfo:
  - textbox [ref=e10]
    - /placeholder: "Search"
```

**Key elements:**
- `[ref=eN]` — Element reference for interaction
- `[checked]`, `[disabled]`, `[expanded]` — Element states
- `[level=N]` — Heading level
- `/url:`, `/placeholder:` — Element properties

---

## Error Recovery

Page state persists after failures. Debug with:

```bash
devbrowse snap /tmp/debug.png
devbrowse url
devbrowse title
devbrowse text | head -50
```

Or with script:

```typescript
const page = await client.page("problematic");
await page.screenshot({ path: "tmp/debug.png" });
console.log({ url: page.url(), title: await page.title() });
```

---

## Environment Variables

```bash
DB_SERVER_URL=http://localhost:9222  # Server URL (default)
```

---

## Scraping Guide

For large datasets, intercept and replay network requests rather than scrolling the DOM. See [references/scraping.md](references/scraping.md) for the complete guide.
