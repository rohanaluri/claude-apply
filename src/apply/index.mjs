#!/usr/bin/env node
/**
 * Phase 4 — /apply  (code-driven, one-shot AI)
 * ---------------------------------------------------------------------------
 * Replaces the agent playbook in .claude/commands/apply.md.
 *
 * WHY THIS EXISTS
 *   The playbook drove the browser through `claude-in-chrome` MCP tools, which
 *   means Claude itself had to read the page and decide each action — dozens of
 *   model turns per application. This script does the same work deterministically
 *   over Playwright/CDP and spends AI *only* on genuine free-text questions,
 *   batched into a single `claude -p` call.
 *
 * SAFETY TRIPWIRE (non-negotiable)
 *   This script NEVER clicks a submit button. It fills, injects a review banner,
 *   and stops. A human reviews and submits. `isSubmitButton()` is the guard that
 *   keeps the multi-step "Next" walker from ever tripping a submit.
 *
 * PREREQ
 *   Chrome running with --remote-debugging-port=9222 (the `chrome-apply` alias).
 *
 * USAGE
 *   node src/apply/index.mjs <job-url> [--dry-run] [--port 9222] [--max-ai-calls 1]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// js-yaml v4 ships a default export, v5 ships named exports. Support both.
import * as yamlNs from 'js-yaml';
const yaml = yamlNs.default ?? yamlNs;

import { EXTRACT_LABEL_SRC } from './dom-label.mjs';
import {
  classifyField,
  mapProfileValue,
  classifyAddButton,
  countEntriesForSection,
} from './field-classifier.mjs';
import { validateProfile } from '../lib/candidate-profile.schema.mjs';
import { detectLanguage } from './language-detect.mjs';
import { appendApplyLog } from './apply-log.mjs';
import { REACT_SELECT_SNIPPET } from './react-select-helper.mjs';

// ───────────────────────────────────────────────────────────── constants ────

const MAX_STEPS = 6; // hard cap on multi-step "Next" advances
const NAV_SETTLE_MS = 1200;

/**
 * Anything matching these is a SUBMIT and must never be auto-clicked.
 * Checked BEFORE the next-patterns, so "Submit" always wins a tie.
 */
const SUBMIT_PATTERNS = [
  /\bsubmit\b/i,
  /submit application/i,
  /send application/i,
  /\bapply now\b/i,
  /^\s*apply\s*$/i,
  /\benvoyer\b/i,
  /\bpostuler\b/i,
  /soumettre/i,
  /finish|complete application/i,
];

/** Safe forward-navigation buttons on multi-step forms. */
const NEXT_PATTERNS = [/\bnext\b/i, /\bcontinue\b/i, /save and continue/i, /\bsuivant\b/i, /\bcontinuer\b/i];

const CLOSED_PATTERNS = [
  /no longer accepting applications/i,
  /position (has been )?filled/i,
  /poste pourvu/i,
  /cette offre n'est plus disponible/i,
  /job expired/i,
];

const CAPTCHA_PATTERNS = [/captcha/i, /verify you are human/i, /cloudflare/i, /challenge/i];

/** classKeys that must be answered by AI rather than the profile. */
const AI_KEYS = new Set(['free_text', 'cover_letter_text']);

/** classKeys that resolve to a file upload. */
const UPLOAD_KEYS = new Set([
  'cv_upload',
  'cover_letter_upload',
  'transcript_upload',
  'portfolio_upload',
  'other_upload',
]);

// ────────────────────────────────────────────────── pure helpers (tested) ────

/**
 * Classify a button's text. Submit always takes precedence over next.
 * @returns {'submit'|'next'|null}
 */
export function classifyButton(text) {
  const t = (text || '').trim();
  if (!t) return null;
  if (SUBMIT_PATTERNS.some((r) => r.test(t))) return 'submit';
  if (NEXT_PATTERNS.some((r) => r.test(t))) return 'next';
  return null;
}

export const isSubmitButton = (t) => classifyButton(t) === 'submit';
export const isNextButton = (t) => classifyButton(t) === 'next';

/**
 * Pick the option label that best represents `desired` among `options`.
 * Deliberately conservative: returns null rather than guessing, so the caller
 * flags the field for human review instead of selecting something wrong.
 */
export function chooseOption(options, desired, classKey = '') {
  if (!Array.isArray(options) || options.length === 0) return null;
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

  const want = norm(desired);

  // EEO fields with no explicit profile value must land on a decline option.
  const isDecline = (o) => /prefer not to (say|answer|disclose)|decline to|do not wish/i.test(o);
  if (classKey.startsWith('eeo_') && (want === '' || want === 'prefer not to say')) {
    return options.find(isDecline) ?? null;
  }
  if (want === '') return null;

  // Boolean-ish questions (sponsorship, work auth) come through as Yes/No.
  const yes = options.find((o) => /^\s*(yes|oui)\b/i.test(o));
  const no = options.find((o) => /^\s*(no|non)\b/i.test(o));
  if (want === 'yes' || want === 'true') return yes ?? null;
  if (want === 'no' || want === 'false') return no ?? null;

  const exact = options.find((o) => norm(o) === want);
  if (exact) return exact;

  // Prefix and substring matches must be UNAMBIGUOUS. If two options both match
  // (e.g. "Master of Science" / "Master of Arts" for "Master"), we return null so
  // the field is flagged for human review rather than silently guessed.
  const starts = options.filter((o) => norm(o).startsWith(want));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;

  const contains = options.filter((o) => norm(o).includes(want));
  if (contains.length === 1) return contains[0];

  return null;
}

/** Build the single batched prompt for all AI-answered questions. */
export function buildAiPrompt({ company, role, language, jdText, cvMd, questions }) {
  const list = questions
    .map((q, i) => `${i + 1}. [id=${q.id}] ${q.question}${q.maxLength ? ` (max ${q.maxLength} chars)` : ''}`)
    .join('\n');

  return [
    `You are helping a candidate complete ONE job application.`,
    ``,
    `COMPANY: ${company || 'unknown'}`,
    `ROLE: ${role || 'unknown'}`,
    `LANGUAGE: answer in ${language === 'fr' ? 'French' : 'English'}`,
    ``,
    `JOB DESCRIPTION (truncated):`,
    (jdText || '').slice(0, 3000),
    ``,
    `CANDIDATE CV:`,
    (cvMd || '').slice(0, 4000),
    ``,
    `QUESTIONS TO ANSWER:`,
    list,
    ``,
    `RULES:`,
    `- Ground every claim in the CV above. NEVER invent experience, employers, or skills.`,
    `- 80-150 words per answer unless a max length is given.`,
    `- If the CV genuinely lacks the basis to answer, return an empty string for that id.`,
    ``,
    `Return ONLY valid JSON, no markdown fences, no preamble:`,
    `{"answers": {"<id>": "<answer text>"}}`,
  ].join('\n');
}

/** Parse the model's JSON reply defensively. */
export function parseAiResponse(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { answers: {} };
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { answers: parsed.answers ?? {} };
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        return { answers: parsed.answers ?? {} };
      } catch {
        /* fall through */
      }
    }
    return { answers: {}, parseError: true };
  }
}

/**
 * Collapse the raw scan into logical fields. Radios sharing a `name` become one
 * field carrying all its options.
 */
export function groupFields(raw) {
  const out = [];
  const radioGroups = new Map();

  for (const f of raw) {
    if (f.type === 'radio' && f.name) {
      if (!radioGroups.has(f.name)) {
        const g = { ...f, kind: 'radio-group', options: [], optionIdx: [] };
        radioGroups.set(f.name, g);
        out.push(g);
      }
      const g = radioGroups.get(f.name);
      g.options.push(f.optionLabel || f.label || '');
      g.optionIdx.push(f.idx);
      g.required = g.required || f.required;
      if (!g.questionText && f.questionText) g.questionText = f.questionText;
    } else {
      out.push({ ...f, kind: f.type === 'checkbox' ? 'checkbox' : 'simple' });
    }
  }
  return out;
}

/** Loose but safe: matches a field name/id/label that's clearly about location. */
const LOCATION_FIELD_RE = /\blocation\b/i;

/**
 * Decide what to do with every field. Pure — no page access.
 * Location-autocomplete fields are detected and routed BEFORE classifyField runs,
 * because their on-page helper text ("No location found...") tends to get pulled
 * into the label by the DOM label-reader, which otherwise makes them look like a
 * long open-ended question and routes them into the AI pool by mistake.
 */
export function planFields(fields, profile) {
  return fields.map((f) => {
    const labelForClass = f.kind === 'radio-group' ? f.questionText || f.label : f.label;

    if (f.kind === 'simple' && (f.type === 'text' || f.type === '')) {
      const haystack = `${f.name} ${f.id} ${f.placeholder} ${f.label}`;
      if (LOCATION_FIELD_RE.test(haystack)) {
        const value = [profile.city, profile.country].filter(Boolean).join(', ');
        return value
          ? { ...f, classKey: 'location', action: 'location', value }
          : { ...f, classKey: 'location', action: 'review', reason: 'no city/country in profile' };
      }
    }

    const classKey = classifyField({ ...f, label: labelForClass });

    if (UPLOAD_KEYS.has(classKey)) {
      return { ...f, classKey, action: 'upload', value: mapProfileValue(classKey, profile) ?? profile.cv_path };
    }
    if (AI_KEYS.has(classKey)) {
      return { ...f, classKey, action: 'ai', question: labelForClass || f.placeholder || '' };
    }

    const value = mapProfileValue(classKey, profile);

    if (f.kind === 'radio-group') {
      const choice = chooseOption(f.options, value, classKey);
      return choice
        ? { ...f, classKey, action: 'radio', value: choice }
        : { ...f, classKey, action: 'review', reason: 'no confident option match', value };
    }
    if (classKey === 'unknown' || value === undefined || value === null || value === '') {
      return { ...f, classKey, action: 'review', reason: classKey === 'unknown' ? 'unrecognized field' : 'no profile value' };
    }
    return { ...f, classKey, action: 'fill', value };
  });
}

// ─────────────────────────────────────────────────────── browser helpers ────

const scanScript = `(() => {
  ${EXTRACT_LABEL_SRC}

  const questionTextOf = (el) => {
    const c = el.closest('.application-question, [data-qa="question"], .field, fieldset');
    if (!c) return '';
    const q = c.querySelector('.text, [data-qa="label"], legend');
    return ((q ? q.textContent : c.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  };

  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden') continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    el.setAttribute('data-ca-idx', String(i));
    let label = '';
    try { label = extractLabel(el) || ''; } catch (e) { label = ''; }

    out.push({
      idx: i,
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      label: label,
      optionLabel: (el.type === 'radio' || el.type === 'checkbox') ? label : '',
      questionText: (el.type === 'radio' || el.type === 'checkbox') ? questionTextOf(el) : '',
      selectOptions: el.tagName.toLowerCase() === 'select'
        ? Array.from(el.options).map(o => o.textContent.trim())
        : [],
      isReactSelect: !!el.closest('.select__control, [class*="select__"]'),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
    });
    i++;
  }
  return out;
})()`;

async function scanPage(page) {
  return page.evaluate(scanScript);
}

async function expandSections(page, profile, log) {
  const buttons = await page.evaluate(`(() => {
    const out = [];
    let i = 0;
    for (const b of document.querySelectorAll('button, a[role="button"]')) {
      const t = (b.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!t) continue;
      b.setAttribute('data-ca-btn', String(i));
      out.push({ idx: i, text: t });
      i++;
    }
    return out;
  })()`);

  for (const b of buttons) {
    const section = classifyAddButton(b.text);
    if (!section) continue;
    // Guard: never let an "+ Add" scan click something submit-shaped.
    if (isSubmitButton(b.text)) continue;

    const n = countEntriesForSection(section, profile);
    // One entry usually already exists in the DOM, so click n-1 times.
    for (let k = 1; k < n; k++) {
      await page.click(`[data-ca-btn="${b.idx}"]`).catch(() => {});
      await page.waitForTimeout(250);
    }
    if (n > 1) log.push(`expanded section "${section}" (${n - 1} extra click(s))`);
  }
}

async function fillSimple(page, field, value) {
  const sel = `[data-ca-idx="${field.idx}"]`;

  if (field.tag === 'select' && !field.isReactSelect) {
    await page.selectOption(sel, { label: String(value) }).catch(async () => {
      await page.selectOption(sel, String(value));
    });
    return true;
  }

  if (field.isReactSelect) {
    const res = await page.evaluate(
      `(() => { const controlSelector = ${JSON.stringify(sel)}; const optionText = ${JSON.stringify(String(value))}; return ${REACT_SELECT_SNIPPET}; })()`
    );
    return !!(res && res.ok);
  }

  // Native setter so React/Vue state actually updates.
  return page.evaluate(
    ({ sel, value }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const proto =
        el.tagName.toLowerCase() === 'textarea'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === value;
    },
    { sel, value: String(value) }
  );
}

async function fillRadio(page, field, choiceLabel) {
  const pos = field.options.findIndex((o) => o === choiceLabel);
  if (pos < 0) return false;
  const targetIdx = field.optionIdx[pos];
  return page.evaluate((idx) => {
    const el = document.querySelector(`[data-ca-idx="${idx}"]`);
    if (!el) return false;
    el.click();
    return el.checked === true || el.getAttribute('aria-checked') === 'true';
  }, targetIdx);
}

/**
 * Location/Places-style autocompletes reject JS-set values — they only respond to
 * real keyboard events. Types the value character-by-character, waits for a
 * suggestion dropdown, and clicks the first option; falls back to ArrowDown+Enter
 * if no dropdown DOM is found. NOT verified against a live Places widget — this
 * follows the technique documented in the old playbook, but confirm on a real form.
 */
async function fillLocationAutocomplete(page, field, value) {
  const sel = `[data-ca-idx="${field.idx}"]`;
  const locator = page.locator(sel);

  await locator.click({ timeout: 3000 }).catch(() => {});
  await locator.fill('').catch(() => {});
  await locator.pressSequentially(value, { delay: 60 });
  await page.waitForTimeout(900); // let the autocomplete API respond

  const optionSel = '[role="option"], li[class*="suggest" i], li[class*="option" i], div[class*="suggest" i]';
  const option = page.locator(optionSel).first();
  const hasOption = await option.count().then((c) => c > 0).catch(() => false);

  if (hasOption) {
    await option.click({ timeout: 2000 }).catch(() => {});
  } else {
    await locator.press('ArrowDown').catch(() => {});
    await locator.press('Enter').catch(() => {});
  }

  await page.waitForTimeout(300);
  const finalValue = await locator.inputValue().catch(() => '');
  return finalValue.trim().length > 0;
}

async function detectBlockers(page) {
  const info = await page.evaluate(`(() => ({
    text: (document.body.innerText || '').slice(0, 20000),
    hasPassword: !!document.querySelector('input[type="password"]'),
    hasFile: !!document.querySelector('input[type="file"]'),
  }))()`);

  if (CLOSED_PATTERNS.some((r) => r.test(info.text))) return { blocker: 'closed_offer' };
  if (CAPTCHA_PATTERNS.some((r) => r.test(info.text))) return { blocker: 'captcha' };
  if (info.hasPassword && !info.hasFile) return { blocker: 'login_wall' };
  return { blocker: null };
}

async function findNavButtons(page) {
  return page.evaluate(`(() => {
    const out = [];
    let i = 0;
    for (const b of document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')) {
      const t = ((b.textContent || b.value || '')).replace(/\\s+/g, ' ').trim();
      if (!t) continue;
      const style = window.getComputedStyle(b);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      b.setAttribute('data-ca-nav', String(i));
      out.push({ idx: i, text: t, disabled: !!b.disabled });
      i++;
    }
    return out;
  })()`);
}

async function injectBanner(page, summary) {
  await page.evaluate((msg) => {
    const old = document.getElementById('claude-apply-review-banner');
    if (old) old.remove();
    const banner = document.createElement('div');
    banner.id = 'claude-apply-review-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:999999',
      'background:#f59e0b', 'color:#1a1a1a', 'font-size:15px', 'font-weight:bold',
      'text-align:center', 'padding:14px 16px', 'font-family:system-ui,sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
    ].join(';');
    banner.textContent = msg;
    document.body.prepend(banner);
  }, summary);
}

// ─────────────────────────────────────────────────────────────── AI call ────

function runClaudeBatch(prompt) {
  const emptyMcpPath = path.join(os.tmpdir(), 'claude-apply-empty-mcp.json');
  if (!fs.existsSync(emptyMcpPath)) fs.writeFileSync(emptyMcpPath, '{"mcpServers":{}}');

  const proc = spawnSync(
    'claude',
    [
      '-p',
      '--system-prompt',
      'You answer job application questions. Output ONLY valid JSON matching the requested shape.',
      '--disable-slash-commands',
      '--no-chrome',
      '--strict-mcp-config',
      '--mcp-config',
      emptyMcpPath,
      '--setting-sources',
      '',
      '--output-format',
      'json',
    ],
    { input: prompt, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, cwd: os.tmpdir() }
  );

  if (proc.status !== 0) {
    throw new Error(`claude -p failed (exit ${proc.status}): ${proc.stderr || 'no stderr'}`);
  }
  const parsed = JSON.parse(proc.stdout);
  return { text: parsed.result || '', usage: parsed.usage || {} };
}

// ────────────────────────────────────────────────────────────────── main ────

function parseArgs(argv) {
  const out = { dryRun: false, port: 9222, maxAiCalls: 1, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--max-ai-calls') out.maxAiCalls = Number(argv[++i]);
    else if (!a.startsWith('--')) out.url = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: node src/apply/index.mjs <job-url> [--dry-run] [--port 9222]');
    process.exit(2);
  }

  const startTime = Date.now();
  const log = [];
  const errors = [];

  // --- profile ---
  const profilePath = 'config/candidate-profile.yml';
  if (!fs.existsSync(profilePath)) {
    console.error(`✖ ${profilePath} not found. Run /apply-onboard first.`);
    process.exit(1);
  }
  const profile = yaml.load(fs.readFileSync(profilePath, 'utf8'));
  const v = validateProfile(profile);
  if (!v.ok) {
    console.error('✖ Invalid candidate profile:');
    v.errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }
  const cvMd = fs.existsSync('config/cv.md') ? fs.readFileSync('config/cv.md', 'utf8') : '';

  // --- browser ---
  const cdpUrl = `http://localhost:${args.port}`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    console.error(`✖ Cannot reach Chrome DevTools at ${cdpUrl}. Launch the \`chrome-apply\` alias first.`);
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  let finalStatus = 'Failed';
  let company = null;
  let role = null;
  let language = null;

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(NAV_SETTLE_MS);

    const { blocker } = await detectBlockers(page);
    if (blocker) {
      finalStatus = blocker === 'closed_offer' ? 'Discarded' : 'Failed';
      console.error(`✖ Blocked: ${blocker}. Resolve it in the browser, then re-run.`);
      errors.push(blocker);
      return;
    }

    // --- job metadata ---
    const meta = await page.evaluate(`(() => ({
      title: document.title || '',
      h1: (document.querySelector('h1') || {}).textContent || '',
      body: (document.body.innerText || '').slice(0, 8000),
    }))()`);
    role = meta.h1.trim();
    // Lever's h1 often duplicates the full "<company> - <role>" title rather than
    // giving just the role, so fall back to splitting the title in that case.
    const titleParts = meta.title.split(/[-|–]/).map((s) => s.trim()).filter(Boolean);
    if (!role || role === meta.title.trim()) {
      role = titleParts.length > 1 ? titleParts.slice(1).join(' - ') : meta.title.trim();
    }
    company = titleParts.length > 1 ? titleParts[0] : null;
    language = detectLanguage({ title: role, description: meta.body });
    log.push(`role="${role}" company="${company}" language=${language}`);

    let aiCallsUsed = 0;
    const allPlans = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      await expandSections(page, profile, log);

      const raw = await scanPage(page);
      const grouped = groupFields(raw);
      const plan = planFields(grouped, profile);
      allPlans.push(...plan);

      log.push(`step ${step}: ${plan.length} fields`);

      if (args.dryRun) {
        console.log(`\n── step ${step} (dry-run, nothing filled) ──`);
        for (const p of plan) {
          console.log(`  [${p.action.padEnd(6)}] ${p.classKey.padEnd(20)} ${(p.label || p.questionText || '').slice(0, 60)}`);
        }
      } else {
        // 1. deterministic fills
        for (const p of plan) {
          try {
            if (p.action === 'fill') {
              const ok = await fillSimple(page, p, p.value);
              if (!ok) { p.action = 'review'; p.reason = 'fill verification failed'; }
            } else if (p.action === 'radio') {
              const ok = await fillRadio(page, p, p.value);
              if (!ok) { p.action = 'review'; p.reason = 'radio click not confirmed'; }
            } else if (p.action === 'location') {
              const ok = await fillLocationAutocomplete(page, p, p.value);
              if (!ok) { p.action = 'review'; p.reason = 'location autocomplete: no value confirmed after typing + selecting'; }
            } else if (p.action === 'upload') {
              if (p.value && fs.existsSync(p.value)) {
                await page.locator(`[data-ca-idx="${p.idx}"]`).setInputFiles(path.resolve(p.value));
              } else {
                p.action = 'review';
                p.reason = `file not found: ${p.value}`;
              }
            }
          } catch (e) {
            p.action = 'review';
            p.reason = `error: ${e.message}`;
            errors.push(`${p.classKey}: ${e.message}`);
          }
        }

        // 2. ONE batched AI call for this step's free-text questions
        const aiFields = plan.filter((p) => p.action === 'ai' && p.question);
        if (aiFields.length) {
          if (aiCallsUsed >= args.maxAiCalls) {
            aiFields.forEach((p) => { p.action = 'review'; p.reason = 'AI call budget exhausted'; });
            log.push(`skipped ${aiFields.length} AI field(s): budget exhausted`);
          } else {
            const questions = aiFields.map((p, i) => ({ id: `q${p.idx}`, question: p.question, maxLength: p.maxLength }));
            const prompt = buildAiPrompt({ company, role, language, jdText: meta.body, cvMd, questions });
            try {
              const { text, usage } = runClaudeBatch(prompt);
              aiCallsUsed++;
              const { answers, parseError } = parseAiResponse(text);
              if (parseError) errors.push('AI response was not valid JSON');
              log.push(`AI call ${aiCallsUsed}: ${aiFields.length} question(s), usage=${JSON.stringify(usage)}`);
              for (const p of aiFields) {
                const ans = answers[`q${p.idx}`];
                if (ans && String(ans).trim()) {
                  const ok = await fillSimple(page, p, ans);
                  p.action = ok ? 'filled-ai' : 'review';
                  if (!ok) p.reason = 'AI answer fill failed';
                } else {
                  p.action = 'review';
                  p.reason = 'AI returned no answer';
                }
              }
            } catch (e) {
              aiFields.forEach((p) => { p.action = 'review'; p.reason = `AI call failed: ${e.message}`; });
              errors.push(`AI call failed: ${e.message}`);
            }
          }
        }
      }

      // 3. navigation: advance only on a confirmed NEXT, never a submit
      const navs = await findNavButtons(page);
      const submitBtn = navs.find((b) => classifyButton(b.text) === 'submit');
      const nextBtn = navs.find((b) => classifyButton(b.text) === 'next' && !b.disabled);

      if (submitBtn && !nextBtn) {
        log.push(`step ${step}: submit button found ("${submitBtn.text}") — stopping for human review`);
        break;
      }
      if (!nextBtn) {
        log.push(`step ${step}: no next button — assuming final page`);
        break;
      }
      if (step === MAX_STEPS) {
        log.push(`reached MAX_STEPS (${MAX_STEPS}) — stopping`);
        break;
      }

      const beforeUrl = page.url();
      const beforeCount = (await scanPage(page)).length;
      await page.click(`[data-ca-nav="${nextBtn.idx}"]`).catch((e) => errors.push(`next click: ${e.message}`));
      await page.waitForTimeout(NAV_SETTLE_MS);

      const afterUrl = page.url();
      const afterCount = (await scanPage(page)).length;
      if (afterUrl === beforeUrl && afterCount === beforeCount) {
        log.push(`step ${step}: page did not advance after "${nextBtn.text}" — stopping`);
        break;
      }
      log.push(`step ${step}: advanced via "${nextBtn.text}"`);
    }

    // --- tripwire ---
    const filled = allPlans.filter((p) => ['fill', 'radio', 'upload', 'filled-ai', 'location'].includes(p.action));
    const review = allPlans.filter((p) => p.action === 'review');
    const requiredReview = review.filter((p) => p.required);

    if (!args.dryRun) {
      await injectBanner(
        page,
        `AI FILL COMPLETE — ${filled.length} filled, ${review.length} need review` +
          (requiredReview.length ? ` (${requiredReview.length} REQUIRED)` : '') +
          '. Verify every field, then click Submit yourself.'
      );
    }

    finalStatus = 'Ready for review';

    console.log('\n══════════════ APPLY SUMMARY ══════════════');
    console.log(`URL:        ${args.url}`);
    console.log(`Company:    ${company ?? '—'}`);
    console.log(`Role:       ${role ?? '—'}`);
    console.log(`Language:   ${language}`);
    console.log(`Filled:     ${filled.length}`);
    console.log(`Review:     ${review.length}${requiredReview.length ? `  (${requiredReview.length} REQUIRED)` : ''}`);
    if (review.length) {
      console.log('\nNeeds human attention:');
      for (const p of review) {
        console.log(`  • ${p.required ? '[REQUIRED] ' : ''}${(p.label || p.questionText || '(no label)').slice(0, 70)}`);
        console.log(`      classKey=${p.classKey}  reason=${p.reason}`);
      }
    }
    console.log('\nTrace:');
    log.forEach((l) => console.log(`  - ${l}`));
    console.log('\n⚠  NOT SUBMITTED. The tab is open for your review.');
    console.log('═══════════════════════════════════════════\n');
  } catch (e) {
    errors.push(e.message);
    console.error(`✖ ${e.message}`);
  } finally {
    if (!args.dryRun) {
      appendApplyLog('data/apply-log.jsonl', {
        url: args.url,
        company,
        role,
        language,
        finalStatus,
        gifPath: null,
        durationMs: Date.now() - startTime,
        errors,
        notes: log.join(' | '),
      });
    }
    // Disconnect only — never close the user's Chrome or the tab under review.
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
