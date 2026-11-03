// Parser tests for index.html. Run: node test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1], ctx);
const { extract, toJSON } = ctx.LogJSON;
const example = html.match(/<script type="text\/plain" id="example-text">([\s\S]*?)<\/script>/)[1].trim();

const structs = t => extract(t).filter(s => s.type === 'struct');
// Every structure must serialize to valid JSON; parsing it also moves values into this realm.
const plain = (s, unwrap = true) => JSON.parse(toJSON(s.node, unwrap));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message.split('\n').join('\n      ')); }
}

test('example log: three structures with the surrounding text kept', () => {
  const segs = extract(example);
  const s = segs.filter(x => x.type === 'struct');
  assert.equal(s.length, 3);
  assert.match(segs[0].text, /\(details=$/);
  assert.match(segs.at(-1).text, /^\nexample\.com\/billing\/client\.TranslateErr/);

  assert.equal(s[0].kind, 'JSON');
  assert.equal(s[0].valid, true);
  assert.deepEqual(plain(s[0]), [{ '@type': 'retry', suspend: true, suspend_duration: 3600000000000 }]);

  assert.equal(s[1].kind, 'Go struct');
  assert.deepEqual(plain(s[1]), {
    ID: '9f2c4e1a-5b3d-4c7e-8a61-2d9e0f3b7c45',
    Number: '',
    Description: '',
    CreatedAt: '0001-01-01 00:00:00 +0000 UTC',
    UpdatedAt: '0001-01-01 00:00:00 +0000 UTC',
    Tags: [],
    Currency: '',
  });

  const e = plain(s[2]);
  assert.equal(s[2].kind, 'Go struct');
  assert.equal(e.StatusCode, 429);
  assert.equal(e.Err.Code, 'TooManyRequests');
  assert.equal(e.Err.Message.ErrorCode, 'Throttled');
  assert.equal(e.Err.Message.Message._version, 3);
  assert.equal(e.Err.Message.Message.RetryAfter, '00:00:02');
  assert.match(e.Err.Message.Message.Message, /Activity ID: 4b8e2f10.* - Url: https:\/\/api\.example\.com\/.*api-version=2026-01-01$/);
  assert.deepEqual(e.Err.Message.Message.HttpHeaders, {});
  assert.equal(e.Err.Message.Target, null);
  assert.deepEqual(e.Err.Message.Annotations, []);
  assert.deepEqual(e.Err.Details, []);
  assert.deepEqual(e.Err.InnerError, { Message: '', Code: '', RequestID: '4b8e2f10-7c3a-4d59-9e21-6a0f5c8d3b72', Date: '2026-11-03T09:51:22' });

  assert.equal(typeof plain(s[2], false).Err.Message.Message, 'string', 'unwrap=false keeps the JSON string as a string');
});

test('Go struct: error chain inside a value is not split into keys', () => {
  const [s] = structs('err {Message:failed backup: BackupFn: rate limit is reached Code:5 Url:https://x.io/a?b=c Addr:localhost:8080}');
  assert.deepEqual(plain(s), { Message: 'failed backup: BackupFn: rate limit is reached', Code: 5, Url: 'https://x.io/a?b=c', Addr: 'localhost:8080' });
});

test('Go struct: pointer, nil and nested slice of structs', () => {
  const [s] = structs('got &{Name:a b Err:<nil> Items:[{ID:1} {ID:2}] Ptr:0xc000123456}');
  assert.deepEqual(plain(s), { Name: 'a b', Err: null, Items: [{ ID: 1 }, { ID: 2 }], Ptr: '0xc000123456' });
});

test('Go map', () => {
  const [s] = structs('labels=map[app:web env:prod tags:map[a:1 b:[x y]]] done');
  assert.equal(s.kind, 'Go map');
  assert.deepEqual(plain(s), { app: 'web', env: 'prod', tags: { a: 1, b: ['x', 'y'] } });
});

test('backslash-escaped JSON in text', () => {
  const segs = extract('msg="{\\"a\\":1,\\"b\\":{\\"c\\":\\"d\\"}}" end');
  const s = segs.filter(x => x.type === 'struct');
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, 'Escaped JSON');
  assert.deepEqual(plain(s[0]), { a: 1, b: { c: 'd' } });
  assert.equal(segs.at(-1).text, '" end');
});

test('double-escaped JSON', () => {
  const [s] = structs('"{\\\\\\"a\\\\\\":[1,2]}"');
  assert.deepEqual(plain(s), { a: [1, 2] });
});

test('JSON string nested inside JSON string inside JSON', () => {
  const [s] = structs('{"outer":"{\\"inner\\":\\"{\\\\\\"deep\\\\\\":true}\\"}"}');
  assert.equal(s.valid, true);
  assert.deepEqual(plain(s), { outer: { inner: { deep: true } } });
});

test('JSON embedded in the middle of a string value', () => {
  const [s] = structs('{"msg":"request failed: {\\"code\\":42} retrying"}');
  const msg = s.node.entries[0].v;
  assert.ok(msg.embedded, 'string value has embedded segments');
  const inner = msg.embedded.filter(x => x.type === 'struct');
  assert.deepEqual(JSON.parse(toJSON(inner[0].node)), { code: 42 });
});

test('truncated JSON is closed', () => {
  const [s] = structs('prefix {"a": [1, 2, {"b": "c');
  assert.ok(s.flags.includes('truncated'));
  assert.deepEqual(plain(s), { a: [1, 2, { b: 'c' }] });
});

test('JS-style: bare keys, single quotes, comments, trailing commas, missing commas', () => {
  const [s] = structs(`cfg = {
    // comment
    name: 'it\\'s', /* block */ count: 3,
    list: [1, 2, 3,],
    "x": 1 "y": 2,
  }`);
  assert.deepEqual(plain(s), { name: "it's", count: 3, list: [1, 2, 3], x: 1, y: 2 });
  for (const f of ['comments', 'trailing-comma', 'missing-comma', 'single-quotes', 'bare-keys']) assert.ok(s.flags.includes(f), f);
});

test('JS-style object without commas, one key per line', () => {
  const [s] = structs('{\n  a: 1\n  b: two words\n}');
  assert.deepEqual(plain(s), { a: 1, b: 'two words' });
});

test('Python dict repr', () => {
  const [s] = structs("{'a': None, 'b': [True, False], 'c': 'x', 'd': 1.5}");
  assert.equal(s.kind, 'Python-style dict');
  assert.deepEqual(plain(s), { a: null, b: [true, false], c: 'x', d: 1.5 });
});

test('Java toString key=value', () => {
  const [s] = structs('User{id=5, name=Bob Smith, tags=[a, b], url=https://x.io/?q=1}');
  assert.equal(s.kind, 'Key=value object');
  assert.deepEqual(plain(s), { id: 5, name: 'Bob Smith', tags: ['a', 'b'], url: 'https://x.io/?q=1' });
});

test('NDJSON lines are separate structures', () => {
  const s = structs('{"a":1}\n{"b":2}\n[{"c":3}]');
  assert.equal(s.length, 3);
  assert.deepEqual(Array.from(s, x => plain(x)), [{ a: 1 }, { b: 2 }, [{ c: 3 }]]);
});

test('big integers and duplicate keys survive serialization', () => {
  const [s] = structs('{"id": 12345678901234567890, "k": 1, "k": 2}');
  const text = toJSON(s.node);
  assert.match(text, /12345678901234567890/);
  assert.equal(text.match(/"k"/g).length, 2);
});

test('plain text is not reported as data', () => {
  const text = '[INFO] started at [2026-11-03 09:51:22] {name} ${var} array[0] got {} want [] f(x)[...] see [docs]';
  assert.equal(structs(text).length, 0);
});

test('number arrays with commas and quoted-string arrays are accepted', () => {
  assert.equal(structs('vals [1, 2, 3]').length, 1);
  assert.equal(structs('ids ["a" "b"]').length, 1);
});

test('stray and mismatched closers', () => {
  const [s] = structs('{"a": [1, 2}, "b": 3}');
  assert.deepEqual(plain(s), { a: [1, 2], b: 3 });
});

test('every structure in the example round-trips through JSON.parse with unwrap off and on', () => {
  for (const s of structs(example)) { plain(s, true); plain(s, false); }
});

test('performance: 2 MB of mixed log lines', () => {
  const line = i => `2026-11-03T09:51:${String(i % 60).padStart(2, '0')}Z INFO [worker-${i}] request done {"id":${i},"ok":true,"tags":["a","b"],"msg":"{\\"x\\":${i}}"} took 12ms\n`;
  let text = '';
  for (let i = 0; text.length < 2e6; i++) text += line(i);
  const t0 = performance.now();
  const s = structs(text);
  const ms = performance.now() - t0;
  assert.ok(s.length > 10000);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  console.log(`      ${s.length} structures in ${Math.round(ms)} ms`);
});

test('performance: many unclosed braces do not hang', () => {
  const text = 'note { at line 5: unexpected token, see [ the docs ('.repeat(3000);
  const t0 = performance.now();
  structs(text);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  console.log(`      ${text.length} chars in ${Math.round(ms)} ms`);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
