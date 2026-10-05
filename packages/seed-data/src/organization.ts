import type { SystemRoleKey } from '@a5/permissions';
import { seedId } from './ids.js';

export const ORGANIZATION = {
  id: seedId('org:a5'),
  slug: 'a5-roofing',
  name: 'A5 Roofing',
  legalName: 'A5 Roofing LLC',
  timezone: 'America/Chicago',
  emailDomain: 'a5roofing.example',
};

export const LOCATIONS = [
  { id: seedId('loc:dallas'), name: 'Dallas', code: 'DAL', city: 'Dallas', state: 'TX', timezone: 'America/Chicago' },
  { id: seedId('loc:fort-worth'), name: 'Fort Worth', code: 'FTW', city: 'Fort Worth', state: 'TX', timezone: 'America/Chicago' },
  { id: seedId('loc:austin'), name: 'Austin', code: 'AUS', city: 'Austin', state: 'TX', timezone: 'America/Chicago' },
] as const;

export const DEPARTMENTS = [
  { id: seedId('dept:sales'), name: 'Residential Sales', code: 'SALES' },
  { id: seedId('dept:training'), name: 'Sales Training & Enablement', code: 'ENABLE' },
  { id: seedId('dept:operations'), name: 'Operations', code: 'OPS' },
  { id: seedId('dept:compliance'), name: 'Compliance', code: 'COMP' },
] as const;

const loc = (code: 'DAL' | 'FTW' | 'AUS') => LOCATIONS.find((l) => l.code === code)!.id;
const dept = (code: 'SALES' | 'ENABLE' | 'OPS' | 'COMP') => DEPARTMENTS.find((d) => d.code === code)!.id;

export interface SeedPerson {
  key: string;
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  employeeId: string;
  roles: SystemRoleKey[];
  locationId: string;
  departmentId: string;
  hiredAt: string;
  phone: string;
}

function person(
  key: string,
  firstName: string,
  lastName: string,
  jobTitle: string,
  employeeNumber: number,
  roles: SystemRoleKey[],
  location: 'DAL' | 'FTW' | 'AUS',
  department: 'SALES' | 'ENABLE' | 'OPS' | 'COMP',
  hiredAt: string,
): SeedPerson {
  return {
    key,
    id: seedId(`user:${key}`),
    firstName,
    lastName,
    jobTitle,
    employeeId: `A5-${String(employeeNumber).padStart(4, '0')}`,
    roles,
    locationId: loc(location),
    departmentId: dept(department),
    hiredAt,
    phone: `(214) 555-${String(1000 + employeeNumber).slice(-4)}`,
  };
}

export const PEOPLE = {
  priya: person('priya', 'Priya', 'Raman', 'Director of Sales Enablement', 1003, ['super_admin'], 'DAL', 'ENABLE', '2019-03-11'),
  grant: person('grant', 'Grant', 'Holloway', 'Operations Administrator', 1011, ['admin'], 'DAL', 'OPS', '2020-08-03'),
  shelby: person('shelby', 'Shelby', 'Hartman', 'Sales Training Manager', 1024, ['training_admin', 'trainer'], 'DAL', 'ENABLE', '2021-01-18'),
  hector: person('hector', 'Hector', 'Villanueva', 'Field Sales Trainer', 1032, ['trainer'], 'FTW', 'ENABLE', '2021-06-07'),
  ruth: person('ruth', 'Ruth', 'Abernathy', 'Compliance Analyst', 1040, ['auditor'], 'DAL', 'COMP', '2022-02-14'),
  danielle: person('danielle', 'Danielle', 'Okafor', 'Residential Sales Manager', 1045, ['manager'], 'DAL', 'SALES', '2020-04-20'),
  andre: person('andre', 'Andre', 'Coleman', 'Residential Sales Manager', 1052, ['manager'], 'DAL', 'SALES', '2021-09-13'),
  luis: person('luis', 'Luis', 'Ortega', 'Storm Response Sales Manager', 1058, ['manager'], 'FTW', 'SALES', '2019-11-04'),
  meilin: person('meilin', 'Mei Lin', 'Chou', 'Branch Sales Manager', 1063, ['manager'], 'AUS', 'SALES', '2022-05-09'),
  marcus: person('marcus', 'Marcus', 'Delgado', 'Sales Representative', 1201, ['sales_rep'], 'DAL', 'SALES', '2026-08-31'),
  tyler: person('tyler', 'Tyler', 'Brennan', 'Sales Representative', 1202, ['sales_rep'], 'DAL', 'SALES', '2026-08-31'),
  kayla: person('kayla', 'Kayla', 'Simmons', 'Sales Representative', 1203, ['sales_rep'], 'DAL', 'SALES', '2026-09-14'),
  jordan: person('jordan', 'Jordan', 'Whitfield', 'Sales Representative', 1204, ['sales_rep'], 'DAL', 'SALES', '2026-09-14'),
  brianna: person('brianna', 'Brianna', 'Castillo', 'Sales Representative', 1205, ['sales_rep'], 'DAL', 'SALES', '2026-07-06'),
  devon: person('devon', 'Devon', 'Mitchell', 'Sales Representative', 1206, ['sales_rep'], 'DAL', 'SALES', '2026-09-28'),
  ashlyn: person('ashlyn', 'Ashlyn', 'Pierce', 'Sales Representative', 1207, ['sales_rep'], 'DAL', 'SALES', '2025-03-03'),
  caleb: person('caleb', 'Caleb', 'Ramirez', 'Sales Representative', 1208, ['sales_rep'], 'DAL', 'SALES', '2026-08-17'),
  naomi: person('naomi', 'Naomi', 'Fischer', 'Storm Response Representative', 1209, ['sales_rep'], 'FTW', 'SALES', '2026-08-03'),
  isaiah: person('isaiah', 'Isaiah', 'Grant', 'Storm Response Representative', 1210, ['sales_rep'], 'FTW', 'SALES', '2026-09-14'),
  sofia: person('sofia', 'Sofia', 'Navarro', 'Storm Response Representative', 1211, ['sales_rep'], 'FTW', 'SALES', '2024-10-21'),
  ethan: person('ethan', 'Ethan', 'Kowalski', 'Storm Response Representative', 1212, ['sales_rep'], 'FTW', 'SALES', '2026-09-28'),
  jasmine: person('jasmine', 'Jasmine', 'Reyes', 'Sales Representative', 1213, ['sales_rep'], 'AUS', 'SALES', '2026-08-17'),
  colton: person('colton', 'Colton', 'Hayes', 'Sales Representative', 1214, ['sales_rep'], 'AUS', 'SALES', '2026-09-14'),
  destiny: person('destiny', 'Destiny', 'Morales', 'Sales Representative', 1215, ['sales_rep'], 'AUS', 'SALES', '2025-06-02'),
  darius: person('darius', 'Darius', 'Washington', 'Sales Representative', 1216, ['sales_rep'], 'AUS', 'SALES', '2026-09-28'),
} as const;

export type PersonKey = keyof typeof PEOPLE;

export function emailOf(p: SeedPerson): string {
  return `${p.firstName}.${p.lastName}`.toLowerCase().replace(/\s+/g, '') + `@${ORGANIZATION.emailDomain}`;
}

export const TEAMS = [
  {
    id: seedId('team:dallas-a'),
    name: 'Dallas Residential A',
    description: 'Retail residential sales covering north Dallas and Richardson.',
    locationId: loc('DAL'),
    departmentId: dept('SALES'),
    managers: ['danielle'] as PersonKey[],
    members: ['marcus', 'tyler', 'kayla', 'jordan', 'ashlyn'] as PersonKey[],
  },
  {
    id: seedId('team:dallas-b'),
    name: 'Dallas Residential B',
    description: 'Retail residential sales covering Garland, Mesquite and Rockwall.',
    locationId: loc('DAL'),
    departmentId: dept('SALES'),
    managers: ['andre'] as PersonKey[],
    members: ['brianna', 'devon', 'caleb'] as PersonKey[],
  },
  {
    id: seedId('team:fort-worth-storm'),
    name: 'Fort Worth Storm Response',
    description: 'Hail and wind claim canvassing across Tarrant County.',
    locationId: loc('FTW'),
    departmentId: dept('SALES'),
    managers: ['luis'] as PersonKey[],
    members: ['naomi', 'isaiah', 'sofia', 'ethan'] as PersonKey[],
  },
  {
    id: seedId('team:austin'),
    name: 'Austin Residential',
    description: 'Residential replacements across Travis and Williamson counties.',
    locationId: loc('AUS'),
    departmentId: dept('SALES'),
    managers: ['meilin'] as PersonKey[],
    members: ['jasmine', 'colton', 'destiny', 'darius'] as PersonKey[],
  },
] as const;

/** Trainers assigned to new hires (in addition to team managers). */
export const TRAINER_ASSIGNMENTS: Array<{ trainer: PersonKey; trainees: PersonKey[] }> = [
  { trainer: 'hector', trainees: ['naomi', 'isaiah', 'ethan', 'devon', 'caleb'] },
  { trainer: 'shelby', trainees: ['marcus', 'tyler', 'kayla', 'jordan', 'jasmine', 'colton', 'darius'] },
];

/** Development-only default password for seeded accounts. */
export const DEFAULT_SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'RidgeLine-2026!';
