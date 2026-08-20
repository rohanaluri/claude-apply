#!/usr/bin/env node
/**
 * POC v2: core apply loop with dropdown + radio support.
 *
 * Flow:
 *   A. Scan every field. For select/radio, ALSO harvest the available options.
 *   B. Fill deterministic fields from profile (name, email, etc.) — $0 AI.
 *   C. ONE Claude call: free-text answers + pick the matching option for each
 *      dropdown/radio from the harvested choices.
 *   D. Execute: text->fill, select->selectOption, radio->check the chosen option.
 *   E. STOP. Never submits. Prints a review checklist.
 *
 * Never clicks submit. There is intentionally no submit logic.
 *
 * Usage: node poc-fill.mjs --url <page-url> [--port 9222]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CLAUDE_APPLY_ROOT || path.join(__dirname, '..');
const APPLY_DIR = path.join(REPO_ROOT, 'src', 'apply');

// LOCAL patched classifier (keeps repo untouched during POC)
const { classifyField, mapProfileValue } = await import(
  path.join(__dirname, 'field-classifier.patched.mjs')
);
const DOM_LABEL_SRC = fs.readFileSync(path.join(APPLY_DIR, 'dom-label.browser.js'), 'utf8');

const PROFILE_PATH = process.env.POC_PROFILE || path.join(__dirname, 'mock-profile.yml');
const CV_PATH = process.env.POC_CV || path.join(__dirname, 'mock-cv.md');

function parseArgs(argv) {
  const out = { cdpUrl: 'http://localhost:9222', url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--port') out.cdpUrl = `http://localhost:${argv[++i]}`;
    else if (a === '--cdp-url') out.cdpUrl = argv[++i];
  }
  return out;
}

// One Claude call: free-text answers + option-matching for dropdowns/radios.
function askClaude(payload, cvMarkdown, profile) {
  const emptyMcpPath = path.join(os.tmpdir(), 'claude-apply-empty-mcp.json');
  if (!fs.existsSync(emptyMcpPath)) fs.writeFileSync(emptyMcpPath, '{"mcpServers":{}}');

  const system =
    'You help fill a job application from a candidate profile + CV. You will get a ' +
    'JSON object with two lists: "free_text" (open questions needing a written answer) ' +
    'and "choices" (fields where you must pick exactly one option from a provided list).\n\n' +
    'Rules:\n' +
    '- For "free_text": write a grounded answer ONLY from the profile/CV facts. If the ' +
    'answer is a known profile value (location, desired hours, how they heard), use it ' +
    'directly and briefly. If a question explicitly forbids AI assistance, return the ' +
    'empty string "" for that id.\n' +
    '- For "choices": return the EXACT string of the single best-matching option from ' +
    'that field\'s options list, using the profile value as intent. Never invent an ' +
    'option not in the list. If nothing fits, return "".\n' +
    '- Respond with ONLY one JSON object: { "<id>": "<answer or chosen option>", ... }. ' +
    'No prose, no markdown.\n\n' +
    'PROFILE:\n' + JSON.stringify(profile, null, 2) + '\n\nCV:\n' + cvMarkdown;

  const user = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      ['-p', '--system-prompt', system, '--disable-slash-commands', '--no-chrome',
       '--strict-mcp-config', '--mcp-config', emptyMcpPath, '--setting-sources', '',
       '--output-format', 'json'],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => (stdout += c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude CLI failed (${code}): ${stderr}`));
      try {
        const parsed = JSON.parse(stdout);
        const inner = (parsed.result || '').trim();
        const match = inner.match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`No JSON in Claude response: ${inner.slice(0, 300)}`);
        resolve(JSON.parse(match[0]));
      } catch (err) {
        reject(new Error(`Parse failure: ${err.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn claude: ${err.message}`)));
    proc.stdin.write(user);
    proc.stdin.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: node poc-fill.mjs --url <page-url> [--port 9222]');
    process.exit(2);
  }

  const profile = yaml.load(fs.readFileSync(PROFILE_PATH, 'utf8'));
  const cvMarkdown = fs.readFileSync(CV_PATH, 'utf8');

  console.log(`[poc] connecting to Chrome at ${args.cdpUrl} ...`);
  const browser = await chromium.connectOverCDP(args.cdpUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('No browser context found — is chrome-apply running?');

  let page = ctx.pages().find((p) => p.url().includes(args.url));
  if (!page) {
    page = await ctx.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  }
  console.log(`[poc] on page: ${page.url()}`);

  // --- STEP A: scan fields + harvest options for select/radio ---
  const fields = await page.evaluate((domLabelSrc) => {
    const getLabel = new Function(domLabelSrc + '\nreturn extractLabel;')();
    const els = Array.from(document.querySelectorAll('input, textarea, select'));
    const out = [];
    const seenRadioGroups = {};
    els.forEach((el, i) => {
      if (['hidden', 'submit', 'button'].includes(el.type)) return;
      if (!el.id) el.id = `poc_field_${i}`;
      let type = el.tagName.toLowerCase();
      if (type === 'input') type = el.type || 'text';

      if (type === 'select') {
        const options = Array.from(el.querySelectorAll('option'))
          .map((o) => (o.textContent || '').trim())
          .filter((t) => t && !/^select\.?\.?\.?$/i.test(t));
        out.push({ id: el.id, name: el.name || '', type, label: getLabel(el) || '', options });
      } else if (type === 'radio') {
        // group radios by name; harvest each option's value/label once
        const group = el.name || el.id;
        if (!seenRadioGroups[group]) {
          seenRadioGroups[group] = true;
          const members = els.filter((r) => r.type === 'radio' && (r.name || r.id) === group);
          const options = members.map((r) => {
            let lbl = '';
            if (r.id) {
              const forLbl = document.querySelector(`label[for="${r.id}"]`);
              if (forLbl) lbl = (forLbl.textContent || '').trim();
            }
            if (!lbl && r.closest('label')) lbl = (r.closest('label').textContent || '').trim();
            return { value: r.value, label: lbl || r.value, id: r.id };
          });
          out.push({
            id: el.id, name: el.name || '', type: 'radio_group',
            label: getLabel(el) || '', groupName: group, options,
          });
        }
      } else {
        out.push({ id: el.id, name: el.name || '', type, label: getLabel(el) || '' });
      }
    });
    return out;
  }, DOM_LABEL_SRC);

  console.log(`[poc] found ${fields.length} fillable fields/groups.`);

  // --- STEP B: classify; split into deterministic vs. needs-AI ---
  const plan = [];
  const freeText = [];
  const choices = [];
  for (const f of fields) {
    const cls = classifyField({ label: f.label, name: f.name, type: f.type === 'radio_group' ? 'radio' : f.type });

    if (f.type === 'select' || f.type === 'radio_group') {
      // deterministic value as intent, but Claude picks the real option
      const intent = mapProfileValue(cls, profile);
      choices.push({
        id: f.id,
        question: f.label || f.name,
        profile_intent: intent ?? null,
        options: f.type === 'select' ? f.options : f.options.map((o) => o.label),
      });
      plan.push({ ...f, cls, kind: f.type, intent });
    } else if (cls === 'free_text' || cls === 'cover_letter_text') {
      freeText.push({ id: f.id, question: f.label || f.name });
      plan.push({ ...f, cls, kind: 'free_text' });
    } else {
      const val = mapProfileValue(cls, profile);
      plan.push({ ...f, cls, kind: 'text', value: val ?? '' });
    }
  }

  // --- STEP C: one Claude call for free-text + choice matching ---
  let ai = {};
  const needAI = freeText.length + choices.length;
  if (needAI > 0) {
    console.log(`[poc] one Claude call: ${freeText.length} free-text + ${choices.length} choice fields ...`);
    ai = await askClaude({ free_text: freeText, choices }, cvMarkdown, profile);
    console.log('[poc] answer keys returned:', Object.keys(ai).join(', ') || '(none)');
  } else {
    console.log('[poc] no AI needed.');
  }

  // --- STEP D: execute ---
  console.log('\n[poc] filling...');
  const review = [];
  for (const p of plan) {
    const sel = `[id="${p.id}"]`;
    try {
      if (p.kind === 'select') {
        const choice = ai[p.id];
        if (!choice) { review.push(`${p.id} (dropdown) — no match; pick manually: "${p.label.slice(0,50)}"`); continue; }
        await page.locator(sel).first().selectOption({ label: choice }, { timeout: 4000 })
          .catch(() => page.locator(sel).first().selectOption(choice, { timeout: 4000 }));
        console.log(`   ✓ ${p.id} (dropdown) = "${choice}"`);
      } else if (p.kind === 'radio_group') {
        const choice = ai[p.id];
        if (!choice) { review.push(`${p.id} (radio) — no match; pick manually: "${p.label.slice(0,50)}"`); continue; }
        // find the radio whose label matches the chosen text
        const target = p.options.find((o) => o.label.trim() === choice.trim())
          || p.options.find((o) => o.label.toLowerCase().includes(choice.toLowerCase()));
        if (!target) { review.push(`${p.id} (radio) — Claude chose "${choice}" but no option matched`); continue; }

        // Lever (and many ATS) hide the real <input> behind a styled proxy, so
        // .check() on the input times out. Try, in order:
        //   1) normal check on the input
        //   2) click the associated <label> (what a human actually clicks)
        //   3) force-check the hidden input directly
        let done = false;
        try {
          await page.locator(`[id="${target.id}"]`).first().check({ timeout: 2000 });
          done = true;
        } catch {}
        if (!done) {
          try {
            await page.locator(`label[for="${target.id}"]`).first().click({ timeout: 2000 });
            done = true;
          } catch {}
        }
        if (!done) {
          try {
            await page.locator(`[id="${target.id}"]`).first().check({ force: true, timeout: 2000 });
            done = true;
          } catch {}
        }
        if (done) console.log(`   ✓ ${p.id} (radio) = "${target.label}"`);
        else review.push(`${p.id} (radio) — could not click "${target.label}"; pick manually`);
      } else if (p.kind === 'free_text') {
        const ans = ai[p.id];
        if (!ans) { review.push(`${p.id} (free-text) — left blank (no CV source / AI declined): "${p.label.slice(0,50)}"`); continue; }
        await page.locator(sel).first().fill(String(ans), { timeout: 4000 });
        console.log(`   ✓ ${p.id} (free-text) = "${String(ans).slice(0,50)}"`);
      } else if (p.type === 'file') {
        review.push(`${p.id} (file upload) — attach resume manually`);
      } else {
        if (!p.value) { review.push(`${p.id} (${p.cls}) — no profile value: "${p.label.slice(0,50)}"`); continue; }
        await page.locator(sel).first().fill(String(p.value), { timeout: 4000 });
        console.log(`   ✓ ${p.id} (text) = "${String(p.value).slice(0,50)}"`);
      }
    } catch (err) {
      review.push(`${p.id} (${p.kind}) — fill failed: ${err.message.split('\n')[0]}`);
    }
  }

  console.log('\n[poc] STOPPING — no submit, by design.');
  if (review.length) {
    console.log('\n[poc] REVIEW THESE before submitting:');
    for (const r of review) console.log(`   - ${r}`);
  }
  console.log('\n[poc] Check the browser window to verify every field.');

  await browser.close();
}

main().catch((err) => {
  console.error('[poc] ERROR:', err.message);
  process.exit(1);
});
