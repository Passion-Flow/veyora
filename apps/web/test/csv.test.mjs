/**
 * CSV interchange tests against the generic-login-csv-v1 contract:
 * RFC-4180 quoting, BOM/header/duplicate rejection, field mapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLoginCsv, exportLoginCsv, typeFromTagsJson, CSV_ERRORS } from '../src/data/csv.js';

const HEADER = 'name,website,username,password,notes,tags_json';

test('parses plain rows and maps contract columns', () => {
  const { rows } = parseLoginCsv(`${HEADER}\nGitHub,https://github.com,me@example.com,secret1,,[]\n`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'github', name: 'GitHub', website: 'https://github.com',
    username: 'me@example.com', secret: 'secret1', notes: '', tagsJson: '[]',
  });
});

test('honors RFC-4180 quoting, escaped quotes, commas, and CRLF', () => {
  const csv = `${HEADER}\r\n"Acme, Inc.",https://acme.example,u,"pw""with,quotes","a,b",[]\r\n`;
  const { rows } = parseLoginCsv(csv);
  assert.equal(rows[0].name, 'Acme, Inc.');
  assert.equal(rows[0].secret, 'pw"with,quotes');
  assert.equal(rows[0].notes, 'a,b');
});

test('rejects a byte order mark', () => {
  assert.throws(() => parseLoginCsv(`\uFEFF${HEADER}\n`), error => error.code === CSV_ERRORS.bom);
});

test('rejects wrong, missing, and duplicate headers', () => {
  assert.throws(() => parseLoginCsv('name,password\nx,y\n'), error => error.code === CSV_ERRORS.header);
  assert.throws(() => parseLoginCsv(''), error => error.code === CSV_ERRORS.header);
  assert.throws(() => parseLoginCsv(`${HEADER},extra\n`), error => error.code === CSV_ERRORS.header);
});

test('rejects rows with wrong arity or missing secrets', () => {
  assert.throws(() => parseLoginCsv(`${HEADER}\nOnlyName\n`), error => error.code === CSV_ERRORS.row);
  assert.throws(
    () => parseLoginCsv(`${HEADER}\nNoSecret,https://x,u,,n,[]\n`),
    error => error.code === CSV_ERRORS.row,
  );
});

test('rejects duplicate derived ids within the file and against the vault', () => {
  const twice = `${HEADER}\nGitHub,u,p,1,,[]\nGitHub,u2,p2,2,,[]\n`;
  assert.throws(() => parseLoginCsv(twice), error => error.code === CSV_ERRORS.duplicateId);
  assert.throws(
    () => parseLoginCsv(`${HEADER}\nGitHub,u,p,1,,[]\n`, ['github']),
    error => error.code === CSV_ERRORS.duplicateId,
  );
});

test('empty trailing lines and whitespace-only rows are tolerated', () => {
  const { rows } = parseLoginCsv(`${HEADER}\nSolo,https://s,u,pw,,[]\n\n\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'solo');
});

test('export serializes contract CSV and round-trips through import', () => {
  const entries = [
    { name: 'Acme, Inc.', website: 'https://acme', username: 'u"q"', secret: 'p,w', notes: 'n1', type: 'login' },
    { name: 'Runbook', secret: 'multi\nline', notes: '', type: 'note' },
  ];
  const csv = exportLoginCsv(entries);
  const { rows } = parseLoginCsv(csv, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Acme, Inc.');
  assert.equal(rows[0].secret, 'p,w');
  assert.equal(rows[0].username, 'u"q"');
  assert.equal(typeFromTagsJson(rows[1].tagsJson), 'note');
  assert.equal(typeFromTagsJson(rows[0].tagsJson), 'login');
  assert.equal(typeFromTagsJson('not json'), 'login');
});

test('export escapes quotes, commas, and newlines per RFC-4180', () => {
  const csv = exportLoginCsv([{ name: 'A"B', username: 'x,y', secret: 's', notes: 'l1\nl2', type: 'login' }]);
  const { rows } = parseLoginCsv(csv, []);
  assert.equal(rows[0].name, 'A"B');
  assert.equal(rows[0].username, 'x,y');
  assert.equal(rows[0].notes, 'l1\nl2');
});
