'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load() {
  const filename = path.join(__dirname, '..', 'tariff-query.js');
  const realRequire = createRequire(filename);
  const context = {
    require: (name) => name === 'puppeteer-core' ? {} : realRequire(name),
    __dirname: path.dirname(filename), AbortController,
    process: { env: {}, pid: 12345 },
    console: { log() {}, error() {} },
    setTimeout: (fn) => { queueMicrotask(fn); return { unref() {} }; }, clearTimeout() {},
  };
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('(async () => {')), context, { filename });
  return context;
}

test('province switch timeout cannot label the previous province as the requested one', async () => {
  const api = load();
  api.waitUntil = async () => false;
  const page = { evaluate: async () => true, waitForSelector: async () => {} };
  await assert.rejects(api.selectProvince(page, '江苏省'), /省份|切换/);
});

test('missing local tab cannot silently fall back to nationwide results', async () => {
  const api = load();
  api.selectProvince = async () => true;
  api.getRangeTabs = async () => ['全网资费'];
  api.clickRangeTab = async () => false;
  await assert.rejects(api.scrapeProvince({}, '江苏省', { localOnly: true }), /页签|范围/);
});

test('a failed tab click cannot turn into a successful empty result', async () => {
  const api = load();
  api.selectProvince = async () => true;
  api.getRangeTabs = async () => ['全网资费'];
  api.clickRangeTab = async () => false;
  await assert.rejects(api.scrapeProvince({ evaluate: async () => 0 }, '江苏省', {}), /页签/);
});

test('pending lazy-load requests cannot be treated as completed pagination', async () => {
  const api = load();
  api.waitCardsStable = async () => 10;
  await assert.rejects(api.fullScroll({ evaluate: async () => ({ cards: 10, pending: 1 }) }, 3), /完整|上限/);
});

test('monthly price and traffic units still produce the expected comparison', () => {
  const api = load();
  const rows = api.enrich([{ code: 'one', name: '标准套餐', price: '30元/月', resources: '国内通用流量 15360 MB' }]);
  assert.equal(rows[0].gb, 15);
  assert.equal(rows[0].perGB, 2);
});

test('watchdog aborts the active attempt before exposing a failure', async () => {
  const api = load();
  let cancelled = false;
  await assert.rejects(api.withTimeout(new Promise(() => {}), 1, 'test', () => { cancelled = true; }), /超时/);
  assert.equal(cancelled, true);
});
