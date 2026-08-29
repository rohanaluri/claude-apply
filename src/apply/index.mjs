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
 * CAPTCHA HANDLING
 *   Some sites (e.g. Lever's hCaptcha) trigger a challenge reactively, based on
 *   interaction patterns, not just on initial page load — so a single check right
 *   after `page.goto()` isn't enough. `detectBlockers()` looks for real captcha
 *   DOM elements (iframes/widgets), not just page text, and `waitOutCaptcha()` is
 *   called both at the start of every step and again after each step's fill
 *   actions. When a captcha is found, the script pauses, prints a clear message,
 *   and polls every few seconds until it clears (or a max wait is hit) — it does
 *   NOT attempt to solve or bypass it, and never exits/restarts on this path; you
 *   solve it in the browser and the run continues on its own.
 *
 * AI-ANSWERED CHOICE QUESTIONS (added 2026-08-27)
 *   Some dropdowns/radios have no fixed classifier rule and no deterministic
 *   profile mapping — their exact wording and options vary too much per company
 *   (e.g. "how did you hear about us", relocation willingness). These are now
 *   routed to the SAME batched AI call as free-text questions, but with the
 *   REAL on-page options attached — Claude picks exactly one of them (or
 *   declines), never invents new text. Grounded by the profile's new
 *   application-preference fields (relocation_flexible, salary_expectation,
 *   etc.) alongside the CV. See buildAiPrompt() and planFields().
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

// Captcha pause/resume: how often to re-check, and how long to wait before
// giving up. Waiting is a UX choice, not a workaround — we never attempt to
// solve or bypass the challenge itself.
const CAPTCHA_POLL_MS = 3000;
const CAPTCHA_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

// Hard cap on any single field's fill attempt. Without this, a widget that
// behaves unexpectedly (e.g. a custom dropdown whose structure doesn't match
// what fillSimple()'s React-Select handling expects) can leave an awaited
// Playwright call hanging indefinitely — neither resolving nor throwing —
// which looks identical to the whole script being stuck. A timeout guarantees
// every field either succeeds or gets flagged for review within a bounded
// time, so the run always keeps moving.
const FIELD_TIMEOUT_MS = 8000;

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
const NEXT_PATTERNS = [
  /\bnext\b/i,
  /\bcontinue\b/i,
  /save and continue/i,
  /\bsuivant\b/i,
  /\bcontinuer\b/i,
];

const CLOSED_PATTERNS = [
  /no longer accepting applications/i,
  /position (has been )?filled/i,
  /poste pourvu/i,
  /cette offre n'est plus disponible/i,
  /job expired/i,
];

/**
 * Text signals for an ACTIVE captcha challenge.
 *
 * Deliberately narrow. Broad terms like /captcha/, /cloudflare/ or /challenge/
 * match routine boilerplate that appears on pages with no active challenge at
 * all — Lever footers every apply page with "This site is protected by hCaptcha
 * and its Privacy Policy and Terms of Service apply", and job descriptions
 * constantly use the word "challenge". Those matches produced false positives
 * that stalled the run. Match only phrasing that appears when the user is
 * actually being asked to prove they're human.
 */
const CAPTCHA_PATTERNS = [
  /verify (that )?you are (a )?human/i,
  /i am not a robot/i,
  /checking your browser before accessing/i,
  /please complete the (security |captcha )?(check|challenge) (to|before)/i,
  /attention required!\s*\|\s*cloudflare/i,
];

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

/**
 * classKeys that can never legitimately describe a radio-group. A radio-group
 * is always a yes/no or multiple-choice question — it can't literally BE "the
 * email field." These classes only exist because classifyField() is being
 * fed the radio-group's FULL question paragraph (up to 300 chars, via
 * questionTextOf() in the scan script), not just a short label — and a
 * generic keyword regex meant for short field labels can match an incidental
 * word buried deep in a long explanatory sentence (e.g. a consent question
 * that happens to mention "email" in passing got misclassified as the email
 * field itself). Guards against that whole class of false positive rather
 * than patching each one as it's found.
 */
const RADIO_INVALID_KEYS = new Set([
  'email',
  'phone',
  'linkedin',
  'github',
  'website',
  'country', // added 2026-08-27 alongside the new 'country' classifier rule
  'full_name',
  'first_name',
  'last_name',
  'education_school',
  'education_degree',
  'education_field',
  'education_start',
  'education_end',
  'graduation_year',
  'experience_company',
  'experience_title',
  'experience_start',
  'experience_end',
  'experience_summary',
  'availability',
  'free_text',
  'cover_letter_text',
  ...UPLOAD_KEYS,
]);

/**
 * Maps an eeo_* classKey to the raw profile field backing it, so planFields()
 * can tell whether the candidate actually set a value or is falling back to
 * mapProfileValue()'s default "Prefer not to say" string. See the EEO
 * select-decline handling in planFields() below.
 */
const EEO_PROFILE_KEYS = {
  eeo_gender: 'gender',
  eeo_ethnicity: 'ethnicity',
  eeo_veteran: 'veteran_status',
  eeo_disability: 'disability_status',
};

// ────────────────────────────────────────────────── pure helpers (tested) ────

/** Accent-insensitive, case-insensitive, trimmed text comparison. Shared by
 * chooseOption() (radio-group matching) and the AI-choice answer matching
 * below, so both use identical, predictable normalization. */
const normText = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/** True if `o` reads as a "prefer not to say"-style decline option, in
 * whatever exact wording a given company uses. Shared by chooseOption()
 * (radio-groups) and planFields()'s EEO select-decline handling. */
const isDeclineOption = (o) => /prefer not to (say|answer|disclose)|decline to|do not wish/i.test(o);

/**
 * Shared "smart" text matcher: exact match, then UNAMBIGUOUS prefix match,
 * then UNAMBIGUOUS substring match. Returns the real option string or null —
 * never guesses when multiple options plausibly match. Used by both
 * chooseOption() (radio-groups) and fillSimple()'s <select> handling, so a
 * profile value like "Asian" reliably matches a real option like "Asian (Not
 * Hispanic or Latino)" the same way in BOTH field types, not just radios.
 * Before 2026-08-27, <select> only did exact-string matching (a deliberate
 * fast-fail choice to avoid Playwright hanging on selectOption() — see
 * fillSimple()) — but that meant a real, correctly-set profile value like
 * "Asian" or "not a veteran" still failed to match a slightly longer real
 * option and fell to review, even though a human would obviously see it as
 * the right answer. This stays just as fast as exact-match, since it's pure
 * in-memory string comparison — no page interaction, so no hang risk.
 */
function matchOptionText(options, desired) {
  const want = normText(desired);
  if (want === '') return null;
  const exact = options.find((o) => normText(o) === want);
  if (exact) return exact;
  const starts = options.filter((o) => normText(o).startsWith(want));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return null;
  const contains = options.filter((o) => normText(o).includes(want));
  if (contains.length === 1) return contains[0];
  return null;
}

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
  const want = normText(desired);

  // EEO fields with no explicit profile value must land on a decline option.
  if (classKey.startsWith('eeo_') && (want === '' || want === 'prefer not to say')) {
    return options.find(isDeclineOption) ?? null;
  }
  if (want === '') return null;

  // Boolean-ish questions (sponsorship, work auth) come through as Yes/No.
  const yes = options.find((o) => /^\s*(yes|oui)\b/i.test(o));
  const no = options.find((o) => /^\s*(no|non)\b/i.test(o));
  if (want === 'yes' || want === 'true') return yes ?? null;
  if (want === 'no' || want === 'false') return no ?? null;

  return matchOptionText(options, desired);
}

/**
 * Build the single batched prompt for all AI-answered questions — both
 * open-ended free-text questions and AI-answered CHOICE questions (an
 * unrecognized dropdown/radio with real on-page options attached).
 *
 * `questions[i].options`, when present, marks a question as multiple-choice:
 * the model MUST answer with the exact text of one listed option (verified
 * against the real list before ever touching the page — see main()'s
 * ai-choice handling) or return an empty string if none genuinely fit.
 * `preferences`, when present, is a plain-text block of the candidate's
 * application preferences (relocation, salary, remote/onsite, etc.) — used as
 * grounding for both question types, since a free-text salary question
 * benefits from the same context as a multiple-choice relocation question.
 */
export function buildAiPrompt({ company, role, language, jdText, cvMd, questions, preferences }) {
  const list = questions
    .map((q, i) => {
      const header = `${i + 1}. [id=${q.id}]`;
      if (Array.isArray(q.options) && q.options.length) {
        const optsList = q.options.map((o) => `"${o}"`).join(' | ');
        return `${header} (MULTIPLE CHOICE — answer with the EXACT text of ONE option: ${optsList}) ${q.question}`;
      }
      return `${header} ${q.question}${q.maxLength ? ` (max ${q.maxLength} chars)` : ''}`;
    })
    .join('\n');

  const prefsBlock = preferences
    ? [
        `CANDIDATE PREFERENCES (use as grounding for relevant questions — relocation,`,
        `hours, remote/onsite, travel, salary, referral source, etc.):`,
        preferences,
        ``,
      ].join('\n')
    : '';

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
    prefsBlock,
    `QUESTIONS TO ANSWER:`,
    list,
    ``,
    `RULES:`,
    `- Ground every claim in the CV and preferences above. NEVER invent experience, employers, or skills.`,
    `- For MULTIPLE CHOICE questions, the PREFERENCES block is sufficient grounding on its own — you do NOT need separate CV evidence. If a preference clearly corresponds to one of the real options (e.g. "referral source: internet search" and an option literally says "AI or internet search"), select it confidently.`,
    `- For MULTIPLE CHOICE questions: your answer MUST be the exact text of one listed option — never invent a new option, never combine options, never add extra words. If none of the options genuinely fit, return an empty string for that id.`,
    `- For open-ended questions: 80-150 words per answer unless a max length is given.`,
    `- If the CV/preferences genuinely lack the basis to answer, return an empty string for that id.`,
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

    let classKey = classifyField({ ...f, label: labelForClass });
    if (f.kind === 'radio-group' && RADIO_INVALID_KEYS.has(classKey)) {
      classKey = 'unknown';
    }

    if (UPLOAD_KEYS.has(classKey)) {
      return {
        ...f,
        classKey,
        action: 'upload',
        value: mapProfileValue(classKey, profile) ?? profile.cv_path,
      };
    }
    if (AI_KEYS.has(classKey)) {
      return { ...f, classKey, action: 'ai', question: labelForClass || f.placeholder || '' };
    }

    // Added 2026-08-27: unrecognized multiple-choice questions (a radio-group
    // OR a <select> with real options) get routed to the AI with the REAL
    // on-page options attached — never a free-text guess, never an invented
    // choice. Wording for these varies a lot per company (e.g. "how did you
    // hear about us", relocation willingness) so no fixed classifier rule
    // could reliably cover them all. Only applies when classKey is genuinely
    // unrecognized AND the field actually has real options to choose from —
    // an unknown plain text field with nothing to pick from still falls
    // through to the ordinary 'review' path further below.
    if (classKey === 'unknown') {
      const choiceOptions =
        f.kind === 'radio-group' ? f.options : f.tag === 'select' ? f.selectOptions : null;
      if (Array.isArray(choiceOptions) && choiceOptions.length > 0) {
        return {
          ...f,
          classKey,
          action: 'ai-choice',
          question: labelForClass || f.placeholder || '',
          options: choiceOptions,
        };
      }
    }

    let value = mapProfileValue(classKey, profile);

    // Added 2026-08-27: EEO select-dropdown decline fallback. mapProfileValue()'s
    // default for an unset EEO field is the literal string "Prefer not to
    // say", which rarely matches a real <select>'s actual decline-option
    // wording (e.g. Lever's "Decline to self-identify") — fillSimple()'s
    // exact-match check then correctly fails fast rather than guessing, but
    // that meant every unset EEO select silently needed manual review even
    // when a perfectly good decline option existed on the page. Reuses the
    // same decline-detection regex chooseOption() already applies to
    // radio-groups, so a <select> gets the same treatment. Only kicks in when
    // the candidate genuinely never set the underlying profile field — an
    // explicit value (e.g. gender: Male) is left alone and matched normally.
    if (
      EEO_PROFILE_KEYS[classKey] &&
      !profile[EEO_PROFILE_KEYS[classKey]] &&
      f.kind === 'simple' &&
      f.tag === 'select' &&
      Array.isArray(f.selectOptions)
    ) {
      const declineOpt = f.selectOptions.find(isDeclineOption);
      if (declineOpt) value = declineOpt;
    }

    if (f.kind === 'radio-group') {
      const choice = chooseOption(f.options, value, classKey);
      return choice
        ? { ...f, classKey, action: 'radio', value: choice }
        : { ...f, classKey, action: 'review', reason: 'no confident option match', value };
    }
    if (classKey === 'unknown' || value === undefined || value === null || value === '') {
      return {
        ...f,
        classKey,
        action: 'review',
        reason: classKey === 'unknown' ? 'unrecognized field' : 'no profile value',
      };
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
    if (n > 1) {
      log.push(`expanded section "${section}" (${n - 1} extra click(s))`);
      console.error(`  → expanded "${section}" section (+${n - 1})`);
    }
  }
}

async function fillSimple(page, field, value) {
  const sel = `[data-ca-idx="${field.idx}"]`;

  if (field.tag === 'select' && !field.isReactSelect) {
    // Check for a REAL matching option before attempting to select it —
    // page.selectOption() doesn't fail fast when nothing matches, it quietly
    // retries internally for its own timeout (default ~30s), which looks
    // identical to a hang. matchOptionText() does exact/prefix/substring
    // matching in-memory (same logic chooseOption() uses for radio-groups,
    // see 2026-08-27), so a genuine value like "Asian" correctly matches a
    // real option like "Asian (Not Hispanic or Latino)" — while a truly
    // unrelated value still fails in milliseconds with a clear reason
    // instead of stalling.
    const optionTexts = await page
      .locator(sel)
      .evaluate((el) => Array.from(el.options).map((o) => o.textContent.trim()));
    const matched = matchOptionText(optionTexts, value);
    if (!matched) return false;
    await page.selectOption(sel, { label: matched });
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

  const optionSel =
    '[role="option"], li[class*="suggest" i], li[class*="option" i], div[class*="suggest" i]';
  const option = page.locator(optionSel).first();
  const hasOption = await option
    .count()
    .then((c) => c > 0)
    .catch(() => false);

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

/**
 * Checks for closed-offer, captcha, and login-wall blockers.
 * Captcha detection checks for REAL captcha DOM elements (iframes/widgets from
 * known vendors), not just page text — a visible hCaptcha/reCAPTCHA/Turnstile
 * widget often doesn't put the literal word "captcha" anywhere in the page's
 * visible text, so a text-only check can miss it.
 *
 * Both signals are deliberately narrow, because a false positive here is
 * expensive: it stalls the run for the full CAPTCHA_MAX_WAIT_MS waiting on a
 * challenge that was never there. Specifically:
 *   - the widget must be VISIBLE (real rendered size), since Lever and others
 *     embed a dormant/invisible captcha widget on every page for passive
 *     bot-scoring;
 *   - the text patterns match active-challenge phrasing only, never the
 *     "protected by hCaptcha" boilerplate that footers every Lever page.
 */
async function detectBlockers(page) {
  const info = await page.evaluate(`(() => ({
    text: (document.body.innerText || '').slice(0, 20000),
    hasPassword: !!document.querySelector('input[type="password"]'),
    hasFile: !!document.querySelector('input[type="file"]'),
    // Many sites (Lever included) embed an invisible/background captcha widget
    // on every page load for passive bot-scoring — that's normal and NOT
    // something to pause for. Only a widget that's actually VISIBLE on screen
    // (real rendered size, not display:none/visibility:hidden) represents a
    // real challenge the user needs to solve.
    hasCaptchaWidget: (() => {
      const els = document.querySelectorAll(
        'iframe[src*="hcaptcha"], iframe[title*="hcaptcha" i], ' +
        'iframe[src*="recaptcha"], iframe[title*="recaptcha" i], ' +
        'iframe[src*="turnstile"], div[class*="cf-turnstile"], ' +
        'div.h-captcha, div.g-recaptcha'
      );
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          r.width > 10 &&
          r.height > 10 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        ) {
          return true;
        }
      }
      return false;
    })(),
  }))()`);

  if (CLOSED_PATTERNS.some((r) => r.test(info.text))) return { blocker: 'closed_offer' };
  if (info.hasCaptchaWidget || CAPTCHA_PATTERNS.some((r) => r.test(info.text))) {
    return { blocker: 'captcha' };
  }
  if (info.hasPassword && !info.hasFile) return { blocker: 'login_wall' };
  return { blocker: null };
}

/**
 * If a captcha is present, pause and poll until it clears instead of failing
 * the run outright. Prints an immediate, visible message so a long wait reads
 * as "waiting on you," not a silent hang. Non-captcha blockers (closed offer,
 * login wall) are NOT things solved by waiting, so they're returned as-is with
 * no delay — the caller decides whether to stop.
 *
 * Never attempts to solve or bypass the captcha itself — only detects it and
 * waits for a human to clear it in the browser.
 */
async function waitOutCaptcha(page, log) {
  const first = await detectBlockers(page);
  if (first.blocker !== 'captcha') return first;

  console.error('\n⏸  Captcha detected — solve it in the browser window.');
  console.error(
    `   Waiting up to ${Math.round(CAPTCHA_MAX_WAIT_MS / 60000)} minute(s); I'll continue automatically once it clears.\n`
  );
  log.push('captcha detected — pausing for manual solve');

  const start = Date.now();
  while (Date.now() - start < CAPTCHA_MAX_WAIT_MS) {
    let check;
    try {
      await page.waitForTimeout(CAPTCHA_POLL_MS);
      check = await detectBlockers(page);
    } catch (e) {
      // Page/tab/browser closed while we were waiting — nothing left to poll.
      console.error('✖  Browser tab closed while waiting on the captcha — stopping.\n');
      log.push(`captcha wait aborted: ${e.message}`);
      return { blocker: 'captcha', pageGone: true };
    }
    if (check.blocker !== 'captcha') {
      const waitedSec = Math.round((Date.now() - start) / 1000);
      console.error('▶  Captcha cleared — resuming.\n');
      log.push(`captcha cleared after ${waitedSec}s — resumed`);
      return check; // may still carry a different blocker found on re-check
    }
  }

  console.error('✖  Captcha still present after the wait limit — stopping.\n');
  log.push(`captcha not resolved within ${Math.round(CAPTCHA_MAX_WAIT_MS / 60000)}min — stopping`);
  return { blocker: 'captcha', timedOut: true };
}

/**
 * Prints one line the instant a field is resolved, so the terminal shows real
 * progress instead of going silent until the final summary. A quiet run and a
 * hung run look identical without this — every fill/skip decision happens in
 * memory and previously wasn't visible until the very end.
 */
function logFieldResult(p) {
  const label = (p.label || p.questionText || p.classKey || '').slice(0, 40);
  if (p.action === 'review') {
    console.error(`  [review] ✗ ${p.classKey.padEnd(16)} ${label} — ${p.reason}`);
    return;
  }
  const tag =
    { fill: 'fill', radio: 'radio', location: 'locate', upload: 'upload', 'filled-ai': 'ai' }[
      p.action
    ] || p.action;
  const shown = String(p.value ?? '').slice(0, 50);
  console.error(`  [${tag}]${' '.repeat(Math.max(0, 7 - tag.length))} ✓ ${p.classKey.padEnd(16)} → ${shown}`);
}

/**
 * Races `promise` against FIELD_TIMEOUT_MS. If the timeout wins, throws a
 * distinct, clearly-labeled error instead of leaving the caller hanging.
 * The underlying Playwright call may still be running in the background when
 * this returns (it isn't cancelled) — but the run itself is never blocked by
 * it, which is what matters for keeping the script moving.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms)
    ),
  ]);
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
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:999999',
      'background:#f59e0b',
      'color:#1a1a1a',
      'font-size:15px',
      'font-weight:bold',
      'text-align:center',
      'padding:14px 16px',
      'font-family:system-ui,sans-serif',
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

/**
 * Builds a plain-text grounding block from the profile's application-preference
 * fields (added 2026-08-27), for use in the AI prompt. Only includes fields
 * that are actually set — an absent field is simply omitted, not guessed.
 */
function buildPreferencesText(profile) {
  const lines = [];
  if (profile.relocation_flexible !== undefined && profile.relocation_flexible !== null) {
    lines.push(`Willing to relocate: ${profile.relocation_flexible ? 'Yes' : 'No'}`);
  }
  if (profile.preferred_hours_per_week) {
    lines.push(`Preferred hours/week: ${profile.preferred_hours_per_week}`);
  }
  if (Array.isArray(profile.remote_preference) && profile.remote_preference.length) {
    lines.push(`Remote/onsite preference (priority order): ${profile.remote_preference.join(', ')}`);
  }
  if (profile.willing_to_travel_percent !== undefined && profile.willing_to_travel_percent !== null) {
    lines.push(`Willing to travel: ${profile.willing_to_travel_percent}%`);
  }
  if (profile.salary_expectation) {
    lines.push(`Salary expectation: ${profile.salary_expectation}`);
  }
  if (profile.referral_source) {
    lines.push(`How they typically find/hear about jobs: ${profile.referral_source}`);
  }
  return lines.join('\n');
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
  const preferencesText = buildPreferencesText(profile);
  console.error('✓ profile + cv.md loaded');

  // --- browser ---
  const cdpUrl = `http://localhost:${args.port}`;
  console.error(`→ connecting to Chrome DevTools at ${cdpUrl}...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    console.error(
      `✖ Cannot reach Chrome DevTools at ${cdpUrl}. Launch the \`chrome-apply\` alias first.`
    );
    process.exit(1);
  }
  console.error('✓ connected to Chrome');

  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  let finalStatus = 'Failed';
  let company = null;
  let role = null;
  let language = null;

  // Runs waitOutCaptcha() and, if a blocker remains, records finalStatus/errors
  // and returns true so the caller can `return` immediately. Centralizes the
  // stop-and-report logic used at every checkpoint below.
  const stopIfBlocked = async (context) => {
    const r = await waitOutCaptcha(page, log);
    if (!r.blocker) return false;
    finalStatus = r.blocker === 'closed_offer' ? 'Discarded' : 'Failed';
    console.error(`✖ Blocked (${context}): ${r.blocker}. Resolve it in the browser, then re-run.`);
    errors.push(`${context}: ${r.blocker}`);
    return true;
  };

  try {
    console.error(`→ opening ${args.url} ...`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(NAV_SETTLE_MS);
    console.error('✓ page loaded, checking for blockers...');

    if (await stopIfBlocked('initial load')) return;

    // --- job metadata ---
    const meta = await page.evaluate(`(() => ({
      title: document.title || '',
      h1: (document.querySelector('h1') || {}).textContent || '',
      body: (document.body.innerText || '').slice(0, 8000),
    }))()`);
    role = meta.h1.trim();
    // Lever's h1 often duplicates the full "<company> - <role>" title rather than
    // giving just the role, so fall back to splitting the title in that case.
    const titleParts = meta.title
      .split(/[-|–]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!role || role === meta.title.trim()) {
      role = titleParts.length > 1 ? titleParts.slice(1).join(' - ') : meta.title.trim();
    }
    company = titleParts.length > 1 ? titleParts[0] : null;
    language = detectLanguage({ title: role, description: meta.body });
    log.push(`role="${role}" company="${company}" language=${language}`);
    console.error(`Detected: company="${company ?? '—'}"  role="${role ?? '—'}"  language=${language}`);

    let aiCallsUsed = 0;
    const allPlans = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      // Re-check at the start of each step after the first — catches a captcha
      // that appeared on a newly-advanced page, before any typing happens on
      // it. Skipped on step 1 because main() ran the identical check moments
      // earlier, right after page.goto().
      if (!args.dryRun && step > 1) {
        if (await stopIfBlocked(`step ${step} start`)) return;
      }

      if (!args.dryRun) console.error(`\n── step ${step}: scanning page ──`);
      await expandSections(page, profile, log);

      const raw = await scanPage(page);
      const grouped = groupFields(raw);
      const plan = planFields(grouped, profile);
      allPlans.push(...plan);

      log.push(`step ${step}: ${plan.length} fields`);
      if (!args.dryRun) console.error(`\n── step ${step}: ${plan.length} field(s) found, filling now ──`);

      if (args.dryRun) {
        console.log(`\n── step ${step} (dry-run, nothing filled) ──`);
        for (const p of plan) {
          console.log(
            `  [${p.action.padEnd(6)}] ${p.classKey.padEnd(20)} ${(p.label || p.questionText || '').slice(0, 60)}`
          );
        }
      } else {
        // 1. deterministic fills
        for (const p of plan) {
          try {
            if (p.action === 'fill') {
              const ok = await withTimeout(
                fillSimple(page, p, p.value),
                FIELD_TIMEOUT_MS,
                p.classKey
              );
              if (!ok) {
                p.action = 'review';
                p.reason =
                  p.tag === 'select'
                    ? `no option matches "${p.value}"`
                    : 'fill verification failed';
              }
            } else if (p.action === 'radio') {
              const ok = await withTimeout(
                fillRadio(page, p, p.value),
                FIELD_TIMEOUT_MS,
                p.classKey
              );
              if (!ok) {
                p.action = 'review';
                p.reason = 'radio click not confirmed';
              }
            } else if (p.action === 'location') {
              const ok = await withTimeout(
                fillLocationAutocomplete(page, p, p.value),
                FIELD_TIMEOUT_MS,
                p.classKey
              );
              if (!ok) {
                p.action = 'review';
                p.reason = 'location autocomplete: no value confirmed after typing + selecting';
              }
            } else if (p.action === 'upload') {
              if (p.value && fs.existsSync(p.value)) {
                await withTimeout(
                  page.locator(`[data-ca-idx="${p.idx}"]`).setInputFiles(path.resolve(p.value)),
                  FIELD_TIMEOUT_MS,
                  p.classKey
                );
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

          // AI-answered fields (both free-text 'ai' and choice-question
          // 'ai-choice') aren't touched here — they're filled after the
          // batched Claude call below, where they get logged for real.
          // Logging them here printed a premature, empty line before any
          // answer existed.
          if (p.action !== 'ai' && p.action !== 'ai-choice') logFieldResult(p);

          // Check after EVERY field, not just once per step. hCaptcha can
          // trigger reactively mid-burst — a single per-step check can land
          // right after a challenge already appeared AND cleared between two
          // checks, missing it entirely even though it was genuinely there.
          if (await stopIfBlocked(`step ${step}, field "${p.classKey}"`)) return;
        }

        // 2. ONE batched AI call for this step's free-text AND AI-choice questions
        const aiFields = plan.filter((p) => p.action === 'ai' && p.question);
        const aiChoiceFields = plan.filter((p) => p.action === 'ai-choice' && p.question);
        const allAiFields = [...aiFields, ...aiChoiceFields];

        if (allAiFields.length) {
          if (aiCallsUsed >= args.maxAiCalls) {
            allAiFields.forEach((p) => {
              p.action = 'review';
              p.reason = 'AI call budget exhausted';
            });
            log.push(`skipped ${allAiFields.length} AI field(s): budget exhausted`);
            console.error(
              `  [review] ✗ ${allAiFields.length} AI-answered field(s) skipped — AI call budget exhausted`
            );
          } else {
            const questions = allAiFields.map((p) => ({
              id: `q${p.idx}`,
              question: p.question,
              maxLength: p.maxLength,
              options: p.action === 'ai-choice' ? p.options : undefined,
            }));
            const prompt = buildAiPrompt({
              company,
              role,
              language,
              jdText: meta.body,
              cvMd,
              questions,
              preferences: preferencesText,
            });
            console.error(
              `\n  → calling Claude for ${allAiFields.length} question(s) (free-text + multiple-choice, this can take 10-30s)...`
            );
            try {
              const { text, usage } = runClaudeBatch(prompt);
              aiCallsUsed++;
              const { answers, parseError } = parseAiResponse(text);
              if (parseError) errors.push('AI response was not valid JSON');
              log.push(
                `AI call ${aiCallsUsed}: ${allAiFields.length} question(s), usage=${JSON.stringify(usage)}`
              );
              console.error(
                `  ✓ AI responded (usage=${JSON.stringify(usage)})${parseError ? ' — WARNING: response was not valid JSON' : ''}`
              );
              // Raw answers, printed verbatim before any matching/filling
              // happens — this is what makes a "AI returned no answer" or a
              // mismatch diagnosable: without this, there was no way to tell
              // whether Claude genuinely returned nothing, returned an empty
              // string on purpose, or returned real text that just didn't
              // match a real option (see the per-field reason below for that
              // last case specifically).
              console.error(`  raw AI answers: ${JSON.stringify(answers)}`);
              for (const p of allAiFields) {
                const ans = answers[`q${p.idx}`];

                if (p.action === 'ai-choice') {
                  // Only ever fill an option that's ACTUALLY on the page —
                  // never trust the model's text blindly. Matched with the
                  // same normalization chooseOption() uses for radio-groups.
                  const matched = Array.isArray(p.options)
                    ? p.options.find((o) => normText(o) === normText(ans))
                    : null;
                  if (matched) {
                    const ok =
                      p.kind === 'radio-group'
                        ? await withTimeout(fillRadio(page, p, matched), FIELD_TIMEOUT_MS, p.classKey)
                        : await withTimeout(fillSimple(page, p, matched), FIELD_TIMEOUT_MS, p.classKey);
                    p.action = ok ? 'filled-ai' : 'review';
                    if (ok) p.value = matched;
                    else p.reason = 'AI-selected option fill failed';
                  } else {
                    p.action = 'review';
                    // Includes the raw text Claude returned (if any) so a
                    // mismatch is diagnosable from the summary alone —
                    // previously this just said "did not match," with no way
                    // to tell what the model actually said.
                    p.reason = ans
                      ? `AI answered "${ans}" — no matching option on the page`
                      : 'AI returned no answer';
                  }
                } else {
                  if (ans && String(ans).trim()) {
                    const ok = await withTimeout(fillSimple(page, p, ans), FIELD_TIMEOUT_MS, p.classKey);
                    p.action = ok ? 'filled-ai' : 'review';
                    if (!ok) p.reason = 'AI answer fill failed';
                    else p.value = ans;
                  } else {
                    p.action = 'review';
                    p.reason = 'AI returned no answer';
                  }
                }

                logFieldResult(p);
                // Same per-field check as the deterministic-fill loop above —
                // AI answers also involve real typing/DOM interaction, so the
                // same reactive-trigger risk applies here.
                if (await stopIfBlocked(`step ${step}, AI field "${p.classKey}"`)) return;
              }
            } catch (e) {
              console.error(`  ✗ AI call failed: ${e.message}`);
              allAiFields.forEach((p) => {
                p.action = 'review';
                p.reason = `AI call failed: ${e.message}`;
                logFieldResult(p);
              });
              errors.push(`AI call failed: ${e.message}`);
            }
          }
        }
      }

      // 3. navigation: advance only on a confirmed NEXT, never a submit
      console.error(`  → checking for Next/Submit buttons...`);
      const navs = await findNavButtons(page);
      const submitBtn = navs.find((b) => classifyButton(b.text) === 'submit');
      const nextBtn = navs.find((b) => classifyButton(b.text) === 'next' && !b.disabled);

      if (submitBtn && !nextBtn) {
        const msg = `step ${step}: submit button found ("${submitBtn.text}") — stopping for human review`;
        log.push(msg);
        console.error(`  ✓ ${msg}`);
        break;
      }
      if (!nextBtn) {
        const msg = `step ${step}: no next button — assuming final page`;
        log.push(msg);
        console.error(`  ✓ ${msg}`);
        break;
      }
      if (step === MAX_STEPS) {
        const msg = `reached MAX_STEPS (${MAX_STEPS}) — stopping`;
        log.push(msg);
        console.error(`  ✓ ${msg}`);
        break;
      }

      console.error(`  → clicking "${nextBtn.text}"...`);
      const beforeUrl = page.url();
      const beforeCount = (await scanPage(page)).length;
      await page
        .click(`[data-ca-nav="${nextBtn.idx}"]`)
        .catch((e) => errors.push(`next click: ${e.message}`));
      await page.waitForTimeout(NAV_SETTLE_MS);

      const afterUrl = page.url();
      const afterCount = (await scanPage(page)).length;
      if (afterUrl === beforeUrl && afterCount === beforeCount) {
        const msg = `step ${step}: page did not advance after "${nextBtn.text}" — stopping`;
        log.push(msg);
        console.error(`  ✗ ${msg}`);
        break;
      }
      const msg = `step ${step}: advanced via "${nextBtn.text}"`;
      log.push(msg);
      console.error(`  ✓ ${msg}`);
    }

    // --- tripwire ---
    const filled = allPlans.filter((p) =>
      ['fill', 'radio', 'upload', 'filled-ai', 'location'].includes(p.action)
    );
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
    console.log(
      `Review:     ${review.length}${requiredReview.length ? `  (${requiredReview.length} REQUIRED)` : ''}`
    );
    if (review.length) {
      console.log('\nNeeds human attention:');
      for (const p of review) {
        console.log(
          `  • ${p.required ? '[REQUIRED] ' : ''}${(p.label || p.questionText || '(no label)').slice(0, 70)}`
        );
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
