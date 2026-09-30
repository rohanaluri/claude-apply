import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJobsSheetSetupRequests } from '../../scripts/setup-jobs-sheet.mjs';

test('setup-jobs-sheet — dropdown + 3 color rules on the status column (H2:H)', () => {
  const requests = buildJobsSheetSetupRequests({ sheetId: 42 });
  assert.equal(requests.length, 4);

  const dv = requests[0].setDataValidation;
  assert.deepEqual(dv.range, {
    sheetId: 42,
    startRowIndex: 1,
    startColumnIndex: 7,
    endColumnIndex: 8,
  });
  assert.deepEqual(
    dv.rule.condition.values.map((v) => v.userEnteredValue),
    ['apply', 'applied', 'needs attention', 'skip']
  );
  assert.equal(dv.rule.strict, false);

  const colors = requests.slice(1).map((r) => r.addConditionalFormatRule.rule);
  assert.deepEqual(
    colors.map((r) => r.booleanRule.condition.values[0].userEnteredValue),
    ['apply', 'applied', 'needs attention']
  );
  const applied = colors[1].booleanRule.format.backgroundColor;
  assert.ok(applied.green > applied.red && applied.green > applied.blue, 'applied is green');
});

test('setup-jobs-sheet — re-running does not duplicate existing color rules', () => {
  const first = buildJobsSheetSetupRequests({ sheetId: 42 });
  const existingRules = first.slice(1).map((r) => r.addConditionalFormatRule.rule);
  const second = buildJobsSheetSetupRequests({ sheetId: 42, existingRules });
  assert.equal(second.length, 1);
  assert.ok(second[0].setDataValidation);
});
