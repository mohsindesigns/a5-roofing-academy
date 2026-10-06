import { describe, expect, it } from 'vitest';
import {
  changedFields,
  emptyValues,
  fieldForPath,
  organizationToken,
  parseOffsets,
  toRequest,
  validateForm,
  type DefinitionFormValues,
} from './definition-form';
import { UNSET } from './rule-model';

const PROGRAM = '0190aaaa-0000-7000-8000-0000000000a1';
const ASSESSMENT = '0190aaaa-0000-7000-8000-0000000000a2';

function valid(overrides: Partial<DefinitionFormValues> = {}): DefinitionFormValues {
  return {
    ...emptyValues('A5 Roofing LLC'),
    name: 'Certified Closer',
    code: 'closer',
    eligibilityRule: {
      type: 'all',
      rules: [
        { type: 'program_completed', programId: PROGRAM, minPercent: 100 },
        { type: 'assessment_score', assessmentId: ASSESSMENT, minPercent: 85 },
      ],
    },
    ...overrides,
  };
}

describe('validateForm', () => {
  it('accepts a complete form and returns the request the API will see', () => {
    const { errors, request } = validateForm(valid({ validityKind: 'months', validityMonths: 24 }));
    expect(errors).toEqual({});
    expect(request).toMatchObject({
      name: 'Certified Closer',
      code: 'CLOSER',
      validity: { kind: 'months', months: 24 },
      approvalPolicy: 'none',
      numberPattern: '{ORG}-{CODE}-{YYYY}-{SEQ:6}',
    });
  });

  it('reports required fields next to the field they belong to', () => {
    const { errors, request } = validateForm(emptyValues(''));
    expect(request).toBeNull();
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(['name', 'code', 'issuingOrganizationName']),
    );
  });

  it('asks for the number that goes with the chosen validity', () => {
    expect(
      validateForm(valid({ validityKind: 'months', validityMonths: UNSET })).errors[
        'validityMonths'
      ],
    ).toBe('Enter a number of months.');
    expect(
      validateForm(valid({ validityKind: 'years', validityYears: UNSET })).errors['validityYears'],
    ).toBe('Enter a number of years.');
    expect(
      validateForm(valid({ validityKind: 'fixed_date', validityDate: '' })).errors['validityDate'],
    ).toBe('Choose the expiration date.');
    expect(
      validateForm(valid({ validityKind: 'years', validityYears: 21 })).errors['validityYears'],
    ).toBeTruthy();
  });

  it('points at requirements that are incomplete', () => {
    const { errors } = validateForm(
      valid({
        eligibilityRule: {
          type: 'all',
          rules: [{ type: 'assessment_score', assessmentId: '', minPercent: UNSET }],
        },
      }),
    );
    expect(errors['eligibilityRule']).toBe('1 requirement needs attention.');
  });

  it('checks the numbering pattern with the shared rules', () => {
    expect(
      validateForm(valid({ numberPattern: '{ORG}-{YYYY}-{SEQ:6}' })).errors['numberPattern'],
    ).toMatch(/\{CODE\}/);
    expect(
      validateForm(valid({ numberPattern: '{CODE}-{SEQ:2}' })).errors['numberPattern'],
    ).toMatch(/width between 3 and 10/);
  });

  it('checks reminders, custom text and badge colour', () => {
    expect(validateForm(valid({ reminderOffsets: '90, soon' })).errors['reminderOffsets']).toMatch(
      /whole numbers/,
    );
    expect(validateForm(valid({ badgeColor: 'orange' })).errors['badgeColor']).toBeTruthy();
    const errors = validateForm(
      valid({ customVariables: [{ key: 'Bad Key', label: 'X', value: 'Y' }] }),
    ).errors;
    expect(errors['customVariables.0.key']).toBeTruthy();
  });

  it('does not allow two signatories to be the same person', () => {
    const errors = validateForm(valid({ signatory1: PROGRAM, signatory2: PROGRAM })).errors;
    expect(errors['signatories']).toBeTruthy();
  });
});

describe('toRequest', () => {
  it('sends blanks as null and slots only for the signatories that are set', () => {
    const request = toRequest(
      valid({ templateId: '', stampId: '', signatory2: PROGRAM, badgeLabel: '', badgeAssetId: '' }),
    );
    expect(request).toMatchObject({
      templateId: null,
      stampId: null,
      signatories: [{ slot: 2, signatoryId: PROGRAM }],
      badge: { label: null, assetId: null },
    });
  });
});

describe('parseOffsets', () => {
  it('reads days separated by commas or spaces and keeps mistakes visible', () => {
    expect(parseOffsets('90, 60 30,7')).toEqual([90, 60, 30, 7]);
    expect(parseOffsets('')).toEqual([]);
    expect(parseOffsets('90, x').some(Number.isNaN)).toBe(true);
    expect(parseOffsets('-5').some(Number.isNaN)).toBe(true);
  });
});

describe('changedFields', () => {
  it('only sends what changed, so people who cannot list signatories can still edit requirements', () => {
    const before = validateForm(valid()).request!;
    const after = validateForm(
      valid({
        eligibilityRule: {
          type: 'all',
          rules: [{ type: 'assessment_score', assessmentId: ASSESSMENT, minPercent: 90 }],
        },
      }),
    ).request!;
    expect(Object.keys(changedFields(before, after))).toEqual(['eligibilityRule']);
    expect(changedFields(before, before)).toEqual({});
  });
});

describe('fieldForPath', () => {
  it('maps API paths onto the form fields that show them', () => {
    expect(fieldForPath(['validity', 'months'])).toBe('validityMonths');
    expect(fieldForPath(['validity', 'date'])).toBe('validityDate');
    expect(fieldForPath(['renewal', 'requirements'])).toBe('renewalRequirements');
    expect(fieldForPath(['renewal', 'reminderOffsets', 2])).toBe('reminderOffsets');
    expect(fieldForPath(['badge', 'assetId'])).toBe('badgeAssetId');
    expect(fieldForPath(['signatories', 0, 'signatoryId'])).toBe('signatories');
    expect(fieldForPath(['customVariables', 1, 'key'])).toBe('customVariables.1.key');
    expect(fieldForPath(['templateId'])).toBe('templateId');
  });
});

describe('organizationToken', () => {
  it('mirrors how the API derives the {ORG} part of a number', () => {
    expect(organizationToken('A5', 'Anything')).toBe('A5');
    expect(organizationToken(null, 'A5 Roofing LLC')).toBe('A5');
    expect(organizationToken(null, '  Ridge-Line Co ')).toBe('RIDGELINE');
    expect(organizationToken(null, '')).toBe('ORG');
  });
});
