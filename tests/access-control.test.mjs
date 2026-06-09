// Regression tests for the per-recruiter access-control logic (canAccess).
// These extract the REAL function source from worker.js and run it, so a
// change that breaks recruiter data-isolation fails CI before it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pull a named top-level function's source out of worker.js via brace matching
// and turn it into a callable. Only works for self-contained (dependency-free)
// helpers — which canAccess and constTimeEq are.
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found in worker.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return (0, eval)('(' + src.slice(start, j + 1) + ')');
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const canAccess = extractFn(worker, 'canAccess');

const superAdmin = { id: 'a', role: 'super_admin' };
const ownScope   = { id: 'u1', role: 'recruiter', viewScope: 'own' };
const viewAll    = { id: 'u1', role: 'recruiter', viewScope: 'view_all' };
const manageAll  = { id: 'u1', role: 'recruiter', viewScope: 'manage_all' };

const mine    = { ownerId: 'u1' };
const theirs  = { ownerId: 'u2' };
const legacy  = {}; // no ownerId (pre-SSO record)

test('null record or user is always denied', () => {
  assert.equal(canAccess(null, superAdmin, 'view'), false);
  assert.equal(canAccess(mine, null, 'view'), false);
});

test('super_admin sees and manages everything (incl. legacy)', () => {
  for (const rec of [mine, theirs, legacy]) {
    assert.equal(canAccess(rec, superAdmin, 'view'), true);
    assert.equal(canAccess(rec, superAdmin, 'manage'), true);
  }
});

test('own-scope recruiter: only their own records', () => {
  assert.equal(canAccess(mine, ownScope, 'view'), true);
  assert.equal(canAccess(mine, ownScope, 'manage'), true);
  assert.equal(canAccess(theirs, ownScope, 'view'), false);
  assert.equal(canAccess(theirs, ownScope, 'manage'), false);
  assert.equal(canAccess(legacy, ownScope, 'view'), false);
});

test('view_all recruiter: can VIEW all, can MANAGE only own', () => {
  assert.equal(canAccess(theirs, viewAll, 'view'), true);
  assert.equal(canAccess(theirs, viewAll, 'manage'), false); // critical: cannot edit others
  assert.equal(canAccess(mine, viewAll, 'manage'), true);
});

test('manage_all (Admin) recruiter: view AND manage everything', () => {
  assert.equal(canAccess(theirs, manageAll, 'view'), true);
  assert.equal(canAccess(theirs, manageAll, 'manage'), true);
});

test('default mode is manage (strict) when omitted', () => {
  // A view_all recruiter calling without an explicit mode must NOT get edit rights.
  assert.equal(canAccess(theirs, viewAll), false);
});
