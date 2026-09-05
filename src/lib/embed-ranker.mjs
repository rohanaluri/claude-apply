// Local embedding-based relevance ranker (Phase 1.5 — "Layer 2" in the
// cascade architecture). Computes cosine similarity between the candidate's
// CV and each job description using a small transformer model that runs
// entirely on the CPU, with zero network calls and zero AI-token cost.
//
// Model: all-MiniLM-L6-v2 (~23MB, committed to the repo under models/).
// The library (@xenova/transformers) is configured to ONLY load from the
// local repo path — it will never attempt to download from huggingface.co,
// which is blocked by the cloud Routine's network allowlist anyway.
//
// Usage:
//   const { rankBySimilarity } = await import('./embed-ranker.mjs');
//   const ranked = await rankBySimilarity(candidates, cvMarkdownText);
//   // ranked = same array, sorted by .similarityScore descending

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODEL_DIR = path.join(REPO_ROOT, 'models');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// Lazy singleton — the model is ~23MB and takes a few seconds to load on
// first call. Subsequent calls reuse the same loaded instance.
let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // Dynamic import so the module doesn't hard-fail at parse time if
      // @xenova/transformers isn't installed (e.g. during unit tests that
      // don't exercise this path).
      const { env, pipeline: createPipeline } = await import('@xenova/transformers');

      // CRITICAL: never download from the internet. Load only from the
      // committed model directory. Without this, the cloud Routine would
      // attempt (and fail) to reach huggingface.co on every run.
      env.cacheDir = MODEL_DIR;
      env.allowRemoteModels = false;

      process.stderr.write(`[embed-ranker] loading model from ${MODEL_DIR}...\n`);
      const extractor = await createPipeline('feature-extraction', MODEL_NAME);
      process.stderr.write('[embed-ranker] model loaded.\n');
      return extractor;
    })();
  }
  return extractorPromise;
}

async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.data;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already L2-normalized by the pipeline
}

/**
 * Rank candidate offers by semantic similarity to the CV.
 *
 * @param {Array} candidates  Offer objects (must have .title, .company, .body)
 * @param {string} cvText     The candidate's CV/resume as plain text
 * @returns {Array}           Same objects with .similarityScore added, sorted descending
 */
export async function rankBySimilarity(candidates, cvText) {
  if (!candidates.length) return [];

  const startMs = Date.now();
  const cvVec = await embed(cvText);

  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const offer = candidates[i];
    // Combine title + company + body for the richest signal.
    // Title is repeated to give it extra weight (a keyword in the title
    // matters more than one buried in a 2000-word JD boilerplate).
    const jdText = [
      offer.title || '',
      offer.title || '',
      offer.company || '',
      (offer.body || '').slice(0, 2000), // cap body length for speed
    ].join(' ');

    const jdVec = await embed(jdText);
    const score = cosineSimilarity(cvVec, jdVec);
    scored.push({ ...offer, similarityScore: score });

    // Progress every 25 offers so long runs don't look stuck
    if ((i + 1) % 25 === 0 || i + 1 === candidates.length) {
      process.stderr.write(
        `[embed-ranker] ${i + 1}/${candidates.length} scored\n`
      );
    }
  }

  scored.sort((a, b) => b.similarityScore - a.similarityScore);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  process.stderr.write(
    `[embed-ranker] done in ${elapsedSec}s — top: ${scored[0]?.similarityScore.toFixed(3)}, bottom: ${scored[scored.length - 1]?.similarityScore.toFixed(3)}\n`
  );

  return scored;
}
