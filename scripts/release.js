#!/usr/bin/env node

/**
 * Release script — bumps version, commits, tags, and pushes.
 *
 * Usage:
 *   pnpm release patch          # 0.1.0-alpha.7 → 0.1.0-alpha.8
 *   pnpm release minor          # 0.1.0-alpha.7 → 0.2.0-alpha.1
 *   pnpm release major          # 0.1.0-alpha.7 → 1.0.0-alpha.1
 *   pnpm release 0.1.0-alpha.9  # explicit version
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const capture = (cmd) => execSync(cmd, { encoding: "utf-8" }).trim();

// ── Read current version ──────────────────────────────────────────────────────

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const current = pkg.version;

// ── Determine next version ────────────────────────────────────────────────────

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: pnpm release patch|minor|major|<version>");
  process.exit(1);
}

let next;

if (["patch", "minor", "major"].includes(arg)) {
  // Parse current pre-release version: e.g. 0.1.0-alpha.7
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\w+)\.(\d+))?$/);
  if (!match) {
    console.error(`Cannot auto-bump non-standard version: ${current}`);
    process.exit(1);
  }
  let [, major, minor, patch, pre, preNum] = match;
  major = parseInt(major);
  minor = parseInt(minor);
  patch = parseInt(patch);
  preNum = preNum !== undefined ? parseInt(preNum) : 0;
  const preTag = pre ?? "alpha";

  if (arg === "patch") {
    next = `${major}.${minor}.${patch}-${preTag}.${preNum + 1}`;
  } else if (arg === "minor") {
    next = `${major}.${minor + 1}.0-${preTag}.1`;
  } else {
    next = `${major + 1}.0.0-${preTag}.1`;
  }
} else {
  // Explicit version passed
  next = arg;
}

// ── Guard: check working tree is clean ───────────────────────────────────────

const dirty = capture("git status --porcelain");
if (dirty) {
  console.error("Working tree has uncommitted changes. Commit or stash them first.");
  process.exit(1);
}

// ── Bump version in package.json ─────────────────────────────────────────────

console.log(`\nReleasing: ${current} → ${next}\n`);

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// ── Commit, tag, push ────────────────────────────────────────────────────────

run(`git add package.json`);
run(`git commit -m "chore: update version to ${next}"`);
run(`git tag v${next}`);
run(`git push origin main`);
run(`git push origin v${next}`);

console.log(`\n✓ Released v${next} — GitHub Actions will publish to npm.\n`);
