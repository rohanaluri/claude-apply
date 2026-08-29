const norm = (s) =>
  (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const test_norm = (pattern, label, name) => {
  const combined = norm(label) + ' ' + norm(name);
  return pattern.test(combined);
};

const RULES = [
  {
    key: 'cover_letter_upload',
    when: (f) => f.type === 'file' && test_norm(/(cover|motivation|lettre)/, f.label, f.name),
  },
  {
    key: 'transcript_upload',
    when: (f) =>
      f.type === 'file' &&
      test_norm(
        /transcript|releve de notes|academic record|grade report|bulletin.*notes|bulletin scolaire/,
        f.label,
        f.name
      ),
  },
  {
    key: 'portfolio_upload',
    when: (f) =>
      f.type === 'file' &&
      test_norm(
        /portfolio|work sample|travaux|\bbook\b|writing sample|echantillon/,
        f.label,
        f.name
      ),
  },
  {
    key: 'other_upload',
    when: (f) =>
      f.type === 'file' &&
      test_norm(/additional.*doc|other.*doc|autre.*doc|supplement|piece jointe/, f.label, f.name),
  },
  {
    key: 'cv_upload',
    when: (f) => f.type === 'file' && test_norm(/(resume|curriculum|cv|cv.file)/, f.label, f.name),
  },
  { key: 'cv_upload', when: (f) => f.type === 'file' },
  {
    key: 'cover_letter_text',
    when: (f) =>
      f.type === 'textarea' && test_norm(/(cover letter|motivation|lettre)/, f.label, f.name),
  },
  {
    key: 'email',
    when: (f) => f.type === 'email' || test_norm(/email|courriel|e-mail/, f.label, f.name),
  },
  {
    key: 'phone',
    when: (f) => f.type === 'tel' || test_norm(/phone|telephone|mobile|portable/, f.label, f.name),
  },
  { key: 'linkedin', when: (f) => test_norm(/linkedin/, f.label, f.name) },
  { key: 'github', when: (f) => test_norm(/github|git-hub/, f.label, f.name) },
  {
    key: 'website',
    when: (f) => test_norm(/website|portfolio|personal site|site perso/, f.label, f.name),
  },
  { key: 'full_name', when: (f) => test_norm(/full name|nom complet|your name/, f.label, f.name) },
  {
    key: 'full_name',
    when: (f) =>
      test_norm(/\bname\b/, f.label, f.name) &&
      f.label &&
      f.label.toLowerCase().match(/^name$|^full name$|^nom$/),
  },
  {
    key: 'first_name',
    when: (f) => test_norm(/first name|given name|prenom|firstname/, f.label, f.name),
  },
  {
    key: 'last_name',
    when: (f) => test_norm(/last name|family name|surname|nom|lastname/, f.label, f.name),
  },
  {
    key: 'education_school',
    when: (f) =>
      test_norm(/school|university|universite|ecole|college|etablissement/, f.label, f.name),
  },
  {
    key: 'education_degree',
    when: (f) => test_norm(/degree|diplome|diploma|qualification/, f.label, f.name),
  },
  {
    key: 'education_field',
    when: (f) =>
      test_norm(/field of study|major|discipline|specialisation|domaine/, f.label, f.name),
  },
  {
    key: 'education_start',
    when: (f) =>
      test_norm(/start.*(education|school|studies|etudes)|debut.*etudes/, f.label, f.name),
  },
  {
    key: 'education_end',
    when: (f) =>
      test_norm(
        /end.*(education|school|studies|etudes)|fin.*etudes|graduation date/,
        f.label,
        f.name
      ),
  },
  {
    key: 'graduation_year',
    when: (f) =>
      test_norm(/graduation year|promo|year of graduation|annee diplome/, f.label, f.name),
  },
  // FIX 4 (2026-08-22, live test on PointClickCare Lever posting): work_auth and
  // sponsorship must be checked BEFORE experience_company. Real forms phrase
  // authorization/sponsorship questions as "...for our Company?", which the broad
  // experience_company regex (/company|employer|.../ ) matched first, silently
  // misclassifying two required work-authorization questions as job-history fields.
  {
    key: 'work_auth',
    when: (f) =>
      test_norm(
        /work auth|authorized to work|right to work|eligible.*work|autorisation.*travail/,
        f.label,
        f.name
      ),
  },
  { key: 'sponsorship', when: (f) => test_norm(/sponsor|visa/, f.label, f.name) },
  {
    key: 'experience_company',
    when: (f) =>
      test_norm(/company|employer|entreprise|organisation|organization/, f.label, f.name),
  },
  // FIX 2 (2026-08-20 POC): tightened from /job title|position|poste|role|intitule/.
  // The old pattern matched the bare word "position", so labels like "How did you hear
  // about us or this position?" were misclassified as a job-title field. Now requires
  // real job-title phrasing (a "title" word paired with job/position/poste, or an
  // explicit French "intitule (du poste)" / "titre du poste").
  // FIX 5 (2026-08-22, caught by the repo's own existing test suite): Fix 2 also
  // dropped bare standalone "Poste"/"Intitulé" — French forms commonly use just that
  // one word as the field label, with none of the English ambiguity ("position" alone
  // is the risky one, not "poste" alone). Restored as explicit word-boundary matches.
  {
    key: 'experience_title',
    when: (f) =>
      test_norm(
        /job title|position title|role title|title of position|intitule du poste|titre du poste|current position title|\bposte\b|\bintitule\b/,
        f.label,
        f.name
      ),
  },
  // FIX 1 (2026-08-20 POC): moved 'availability' ahead of 'experience_start'. Both
  // regexes originally matched bare "start date", and RULES is first-match-wins — with
  // the old order, a top-level "earliest start date" question was misclassified as a
  // past job's start date instead of the candidate's own availability date.
  // FIX 6 (2026-08-22, caught by the repo's own existing test suite): narrowed
  // availability's match from bare "start date" (too broad — broke the existing test
  // expecting generic "Start Date" to mean a job's start date) to specifically
  // "earliest start", matching the actual real-world label that caused Fix 1. Restored
  // "start date"/"date de debut" to experience_start, where they originally belonged.
  {
    key: 'availability',
    when: (f) => test_norm(/availability|earliest start|disponibilite/, f.label, f.name),
  },
  {
    key: 'experience_start',
    // Word-boundary fix: bare "start.*(work|job)" matched words like
    // "jumpstart" as a false positive substring match. \bstart\b requires
    // "start" as its own word.
    when: (f) => test_norm(/start date|date de debut|\bstart\b.*(work|job)/, f.label, f.name),
  },
  {
    key: 'experience_end',
    // Word-boundary fix (2026-08-27, live test on Epoch AI Lever posting):
    // bare "end.*(work|job)" matched "Which country do you intend to
    // primarily work from?" — "end" is a substring of "intend", and "work"
    // appears later in the same sentence, so the unanchored regex matched
    // across word boundaries by accident. \bend\b requires "end" as its own
    // standalone word, not embedded inside a longer word like "intend".
    when: (f) => test_norm(/end date|date de fin|\bend\b.*(work|job)/, f.label, f.name),
  },
  {
    key: 'experience_summary',
    when: (f) =>
      test_norm(/description|summary.*(role|job|experience)|taches|missions/, f.label, f.name),
  },
  { key: 'eeo_gender', when: (f) => test_norm(/gender/, f.label, f.name) },
  { key: 'eeo_ethnicity', when: (f) => test_norm(/ethnicity|race/, f.label, f.name) },
  { key: 'eeo_veteran', when: (f) => test_norm(/veteran/, f.label, f.name) },
  { key: 'eeo_disability', when: (f) => test_norm(/disability|handicap/, f.label, f.name) },
  // Added 2026-08-27: catches both a plain residential "Country" address field
  // and application-specific phrasing like "Which country do you intend to
  // primarily work from?" — the profile has one country field, and both
  // questions map to it. Deliberately placed LAST among the specific-key
  // rules (moved here after live testing caught it stealing a match from
  // work_auth's "...in the country you have stated above?" phrasing when
  // positioned earlier) — "country" is too common a word to risk running
  // before more specific rules get a chance. RADIO_INVALID_KEYS in
  // apply/index.mjs additionally guards this key against the same
  // long-paragraph false-positive risk as email/phone for radio-groups.
  { key: 'country', when: (f) => test_norm(/\bcountry\b/, f.label, f.name) },
  // FIX 3 (2026-08-20 POC): short open-ended TEXT inputs (not just <textarea>) were
  // silently falling through to 'unknown' and getting skipped rather than routed to
  // the AI free-text step. This catches text inputs whose label reads like a genuine
  // question (contains '?' or is a longer phrase), while still leaving short factual
  // labels ("City", "Postal Code") to fall through to 'unknown' as before.
  {
    key: 'free_text',
    when: (f) =>
      f.type === 'text' &&
      f.label &&
      (/\?/.test(f.label) || f.label.trim().split(/\s+/).length >= 5),
  },
  { key: 'free_text', when: (f) => f.type === 'textarea' },
];

export function classifyField(field) {
  for (const rule of RULES) {
    if (rule.when(field)) return rule.key;
  }
  return 'unknown';
}

export function mapProfileValue(classKey, profile, opts = {}) {
  const eduIdx = opts.educationIndex ?? 0;
  const expIdx = opts.experienceIndex ?? 0;
  const edu = profile.education?.[eduIdx] || {};
  const exp = profile.experiences?.[expIdx] || {};
  const map = {
    email: profile.email,
    first_name: profile.first_name,
    last_name: profile.last_name,
    full_name: `${profile.first_name} ${profile.last_name}`,
    phone: profile.phone,
    linkedin: profile.linkedin_url,
    github: profile.github_url,
    website: profile.website_url,
    // Added 2026-08-27, alongside the new 'country' classifier rule above.
    country: profile.country,
    education_school: edu.school ?? profile.school,
    education_degree: edu.degree ?? profile.degree,
    education_field: edu.field,
    education_start: edu.start,
    education_end: edu.end,
    graduation_year: profile.graduation_year,
    experience_company: exp.company,
    experience_title: exp.title,
    experience_start: exp.start,
    experience_end: exp.end,
    experience_summary: exp.description,
    // Changed 2026-08-27: was `profile.work_authorization` (a descriptive
    // sentence, e.g. "EU citizen — no sponsorship needed"), which never
    // matched a Yes/No radio's actual options — chooseOption() only
    // recognizes literal yes/no/true/false as boolean signals, so this
    // question always fell to "no confident option match" review. Now reads
    // the new dedicated boolean field instead, mirroring the existing
    // `sponsorship` pattern below. Falls through to `undefined` (→ "no
    // profile value" review) if work_authorized was never set, same
    // conservative behavior as everywhere else rather than guessing.
    work_auth:
      profile.work_authorized === true ? 'Yes' : profile.work_authorized === false ? 'No' : undefined,
    sponsorship: profile.requires_sponsorship ? 'Yes' : 'No',
    availability: profile.availability_start,
    eeo_gender: profile.gender ?? 'Prefer not to say',
    eeo_ethnicity: profile.ethnicity ?? 'Prefer not to say',
    eeo_veteran: profile.veteran_status ?? 'Prefer not to say',
    eeo_disability: profile.disability_status ?? 'Prefer not to say',
    transcript_upload: profile.transcript_path ?? profile.cv_path,
    portfolio_upload: profile.portfolio_path ?? profile.cv_path,
    other_upload: profile.other_document_path ?? profile.cv_path,
  };
  return map[classKey];
}

const SECTION_BUTTON_PATTERNS = [
  {
    section: 'education',
    pattern: /\+?\s*add.*(education|school|studies|formation)|ajouter.*(formation|etudes)/i,
  },
  {
    section: 'experience',
    pattern:
      /\+?\s*add.*(experience|employment|work|job|emploi|poste)|ajouter.*(experience|emploi)/i,
  },
  { section: 'language', pattern: /\+?\s*add.*(language|langue)|ajouter.*langue/i },
  { section: 'link', pattern: /\+?\s*add.*(link|url|website|social)|ajouter.*(lien|url)/i },
  { section: 'skill', pattern: /\+?\s*add.*(skill|competence)|ajouter.*competence/i },
];

export function classifyAddButton(label) {
  const s = norm(label || '').trim();
  for (const { section, pattern } of SECTION_BUTTON_PATTERNS) {
    if (pattern.test(s)) return section;
  }
  return null;
}

export function countEntriesForSection(section, profile) {
  if (section === 'education') return profile.education?.length ?? 0;
  if (section === 'experience') return profile.experiences?.length ?? 0;
  if (section === 'language') return profile.languages?.length ?? 0;
  return 0;
}
