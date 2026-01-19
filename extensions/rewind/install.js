#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const REPO_URL = "https://raw.githubusercontent.com/nicobailon/pi-rewind-hook/main";
const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "rewind");
const OLD_HOOK_DIR = path.join(os.homedir(), ".pi", "agent", "hooks", "rewind");
const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");
const EXT_PATH = "~/.pi/agent/extensions/rewind/index.ts";

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  console.log("Installing pi-rewind-hook (Rewind Extension)...\n");

  fs.mkdirSync(EXT_DIR, { recursive: true });
  console.log(`Created directory: ${EXT_DIR}`);

  console.log("Downloading index.ts...");
  const extContent = await download(`${REPO_URL}/index.ts`);
  fs.writeFileSync(path.join(EXT_DIR, "index.ts"), extContent);

  console.log("Downloading README.md...");
  const readmeContent = await download(`${REPO_URL}/README.md`);
  fs.writeFileSync(path.join(EXT_DIR, "README.md"), readmeContent);

  console.log(`\nUpdating settings: ${SETTINGS_FILE}`);
  
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    } catch (err) {
      console.error(`Warning: Could not parse existing settings.json: ${err.message}`);
      console.error("Creating new settings file...");
    }
  }

  if (settings.hooks && Array.isArray(settings.hooks) && settings.hooks.length > 0) {
    console.log("\nMigrating hooks to extensions...");
    if (!Array.isArray(settings.extensions)) {
      settings.extensions = [];
    }
    for (const entry of settings.hooks) {
      if (entry.includes("/hooks/rewind")) {
        continue;
      }
      const newPath = entry.replace("/hooks/", "/extensions/");
      if (!settings.extensions.includes(newPath)) {
        settings.extensions.push(newPath);
        console.log(`  Migrated: ${entry} -> ${newPath}`);
      }
    }
    delete settings.hooks;
    console.log("Removed old 'hooks' key from settings");
  }

  if (!Array.isArray(settings.extensions)) {
    settings.extensions = [];
  }

  const EXT_PATH_ALT = "~/.pi/agent/extensions/rewind";
  const hasRewindExt = settings.extensions.some(p => 
    p === EXT_PATH || p === EXT_PATH_ALT || 
    p.includes("/extensions/rewind/index.ts") || 
    p.endsWith("/extensions/rewind")
  );

  if (!hasRewindExt) {
    settings.extensions.push(EXT_PATH);
    console.log(`Added "${EXT_PATH}" to extensions array`);
  } else {
    console.log("Extension already configured in settings.json");
  }

  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");

  if (fs.existsSync(OLD_HOOK_DIR)) {
    console.log(`\nCleaning up old hooks directory: ${OLD_HOOK_DIR}`);
    fs.rmSync(OLD_HOOK_DIR, { recursive: true, force: true });
    console.log("Removed old hooks/rewind directory");
  }

  console.log("\nInstallation complete!");
  console.log("\nThe rewind extension will load automatically when you start pi.");
  console.log("Use /branch to rewind to a previous checkpoint.");
}

main().catch((err) => {
  console.error(`\nInstallation failed: ${err.message}`);
  process.exit(1);
});
