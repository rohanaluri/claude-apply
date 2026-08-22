import {
  classifyButton, isSubmitButton, isNextButton,
  chooseOption, parseAiResponse, groupFields, planFields,
} from './src/apply/index.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`}`);
};

console.log('\n=== SAFETY: button classification (must never call a submit "next") ===');
for (const s of ['Submit', 'Submit Application', 'submit application', 'Send Application',
                 'Apply', 'Apply Now', 'Envoyer', 'Postuler', 'Soumettre',
                 'Finish', 'Complete Application', 'SUBMIT APPLICATION']) {
  t(`"${s}" -> submit`, classifyButton(s), 'submit');
}
for (const s of ['Next', 'Continue', 'Save and Continue', 'Suivant', 'Continuer', 'next step']) {
  t(`"${s}" -> next`, classifyButton(s), 'next');
}
console.log('\n-- ambiguous/tie cases: submit MUST win --');
t('"Submit and Continue" -> submit', classifyButton('Submit and Continue'), 'submit');
t('"Continue to Submit" -> submit', classifyButton('Continue to Submit'), 'submit');
t('"Next: Submit Application" -> submit', classifyButton('Next: Submit Application'), 'submit');
console.log('\n-- non-nav buttons --');
for (const s of ['Back', 'Cancel', '+ Add Education', 'Upload Resume', '', null]) {
  t(`"${s}" -> null`, classifyButton(s), null);
}

console.log('\n=== chooseOption (must refuse to guess) ===');
t('Yes/No sponsorship -> No', chooseOption(['Yes', 'No'], 'No', 'sponsorship'), 'No');
t('boolean-ish "yes"', chooseOption(['Yes', 'No'], 'yes', 'sponsorship'), 'Yes');
t('EEO null -> decline option',
  chooseOption(['Male', 'Female', 'Prefer not to say'], 'Prefer not to say', 'eeo_gender'), 'Prefer not to say');
t('EEO empty -> decline option',
  chooseOption(['Male', 'Female', 'Decline to self-identify'], '', 'eeo_gender'), 'Decline to self-identify');
t('EEO with no decline option -> null (do NOT guess)',
  chooseOption(['Male', 'Female'], '', 'eeo_gender'), null);
t('exact match', chooseOption(['Bachelor', 'Master', 'PhD'], 'Master', 'education_degree'), 'Master');
t('ambiguous substring -> null',
  chooseOption(['Master of Science', 'Master of Arts'], 'Master', 'education_degree'), null);
t('unmatched -> null', chooseOption(['A', 'B'], 'Zebra', 'x'), null);
t('empty options -> null', chooseOption([], 'x', 'y'), null);

console.log('\n=== parseAiResponse ===');
t('plain json', parseAiResponse('{"answers":{"q1":"hi"}}').answers, { q1: 'hi' });
t('fenced json', parseAiResponse('```json\n{"answers":{"q1":"hi"}}\n```').answers, { q1: 'hi' });
t('json with preamble', parseAiResponse('Sure!\n{"answers":{"q2":"yo"}}').answers, { q2: 'yo' });
t('garbage -> empty + flag', parseAiResponse('not json at all').parseError, true);
t('empty -> empty answers', parseAiResponse('').answers, {});

console.log('\n=== groupFields (radios collapse into one logical field) ===');
const raw = [
  { idx: 0, type: 'text', name: 'email', label: 'Email' },
  { idx: 1, type: 'radio', name: 'spon', optionLabel: 'Yes', questionText: 'Do you require sponsorship?', required: true },
  { idx: 2, type: 'radio', name: 'spon', optionLabel: 'No', questionText: 'Do you require sponsorship?' },
];
const g = groupFields(raw);
t('3 raw -> 2 logical', g.length, 2);
t('radio options merged', g[1].options, ['Yes', 'No']);
t('radio idx preserved', g[1].optionIdx, [1, 2]);
t('required propagates', g[1].required, true);

console.log('\n=== planFields (end-to-end routing) ===');
const profile = {
  first_name: 'Alice', last_name: 'Martin', email: 'a@b.com', phone: '+33600000000',
  requires_sponsorship: false, gender: null, cv_path: 'config/cv.pdf',
  availability_start: '2026-09-01',
};
const plan = planFields(groupFields([
  { idx: 0, type: 'email', name: 'email', label: 'Email', required: true },
  { idx: 1, type: 'radio', name: 'spon', optionLabel: 'Yes', questionText: 'Do you require visa sponsorship?' },
  { idx: 2, type: 'radio', name: 'spon', optionLabel: 'No', questionText: 'Do you require visa sponsorship?' },
  { idx: 3, type: 'textarea', name: 'why', label: 'Why do you want to join us?' },
  { idx: 4, type: 'file', name: 'resume', label: 'Resume' },
  { idx: 5, type: 'text', name: 'weird', label: 'Internal ref code', required: true },
]), profile);

const byIdx = Object.fromEntries(plan.map(p => [p.idx, p]));
t('email -> fill', [byIdx[0].action, byIdx[0].value], ['fill', 'a@b.com']);
t('sponsorship radio -> No', [byIdx[1].action, byIdx[1].value], ['radio', 'No']);
t('free text -> ai', byIdx[3].action, 'ai');
t('file -> upload', [byIdx[4].action, byIdx[4].value], ['upload', 'config/cv.pdf']);
t('unknown required -> review', [byIdx[5].action, byIdx[5].classKey], ['review', 'unknown']);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
