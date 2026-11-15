import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, SETTING_KEYS, loadSettings, mergeSettingsRaw, settingsOverrides } from '../src/follower-settings.ts';

const json = JSON.parse(readFileSync(new URL('../src/follower-settings.json', import.meta.url), 'utf8'));

test('JSON parses, starts with _doc and loads as the defaults', () => {
  assert.equal(Object.keys(json)[0], '_doc');
  const result = loadSettings(json);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test('_doc has one non-empty text for each setting key', () => {
  assert.deepEqual(Object.keys(json._doc).sort(), [...SETTING_KEYS].sort());
  for (const text of Object.values(json._doc)) {
    assert.equal(typeof text, 'string');
    assert.ok((text as string).length > 0);
  }
});

test('SETTING_KEYS has 48 dotted paths in default order', () => {
  const paths: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) walk(value as Record<string, unknown>, path);
      else paths.push(path);
    }
  };
  walk(DEFAULT_SETTINGS as unknown as Record<string, unknown>, '');
  assert.equal(SETTING_KEYS.length, 48);
  assert.deepEqual([...SETTING_KEYS], paths);
});

test('non-object input gives defaults and the object warning', () => {
  for (const raw of [undefined, null, 5, []]) {
    const result = loadSettings(raw);
    assert.deepEqual(result.settings, DEFAULT_SETTINGS);
    assert.deepEqual(result.warnings, ['settings: must be an object, using defaults']);
  }
});

test('empty object gives no warnings', () => {
  const result = loadSettings({});
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.deepEqual(result.warnings, []);
});

test('bad number warns and keeps the default', () => {
  const result = loadSettings({ live: { windowMs: 'abc' } });
  assert.deepEqual(result.warnings, ['live.windowMs: must be a number from 50 to 1000, using 200']);
  assert.equal(result.settings.live.windowMs, 200);
});

test('bad enum warns and keeps the default', () => {
  const result = loadSettings({ mode: 'fast' });
  assert.deepEqual(result.warnings, ['mode: must be one of wait, live, using "wait"']);
  assert.equal(result.settings.mode, 'wait');
});

test('fractional whole-number setting warns', () => {
  const result = loadSettings({ countIn: { bars: 1.5 } });
  assert.deepEqual(result.warnings, ['countIn.bars: must be a whole number from 0 to 4, using 1']);
  assert.equal(result.settings.countIn.bars, 1);
});

test('bad boolean warns and keeps the default', () => {
  const result = loadSettings({ loop: 'yes' });
  assert.deepEqual(result.warnings, ['loop: must be true or false, using false']);
  assert.equal(result.settings.loop, false);
});

test('tempo above maximum is clamped', () => {
  const result = loadSettings({ tempo: { percent: 200 } });
  assert.equal(result.settings.tempo.percent, 150);
  assert.deepEqual(result.warnings, ['tempo.percent: outside 20 to 150, using 150']);
});

test('tempo min not below max resets both', () => {
  const result = loadSettings({ tempo: { minPercent: 100, maxPercent: 100 } });
  assert.equal(result.settings.tempo.minPercent, 20);
  assert.equal(result.settings.tempo.maxPercent, 150);
  assert.deepEqual(result.warnings, ['tempo.minPercent: must be lower than tempo.maxPercent, using 20 and 150']);
});

test('onTimeMs larger than windowMs is capped', () => {
  const result = loadSettings({ live: { windowMs: 60 } });
  assert.equal(result.settings.live.onTimeMs, 60);
  assert.deepEqual(result.warnings, ['live.onTimeMs: larger than live.windowMs, using 60']);
});

test('unknown keys warn and keys starting with _ are ignored', () => {
  const result = loadSettings({ foo: 1, tempo: { bar: 2 }, _x: 1, tempo2: null });
  assert.deepEqual(result.warnings, [
    'foo: unknown setting, ignored',
    'tempo.bar: unknown setting, ignored',
    'tempo2: unknown setting, ignored',
  ]);
});

test('non-object section warns and uses defaults', () => {
  const result = loadSettings({ tempo: 5 });
  assert.deepEqual(result.settings.tempo, DEFAULT_SETTINGS.tempo);
  assert.deepEqual(result.warnings, ['tempo: must be an object, using defaults']);
});

test('offsetMs accepts a value in range and rejects one out of range', () => {
  const ok = loadSettings({ autoplay: { offsetMs: 150 } });
  assert.equal(ok.settings.autoplay.offsetMs, 150);
  assert.deepEqual(ok.settings.autoplay, { ...DEFAULT_SETTINGS.autoplay, offsetMs: 150 });
  assert.deepEqual(ok.warnings, []);

  const bad = loadSettings({ autoplay: { offsetMs: -1001 } });
  assert.equal(bad.settings.autoplay.offsetMs, 0);
  assert.deepEqual(bad.warnings, ['autoplay.offsetMs: must be a number from -1000 to 1000, using 0']);
});

test('changing returned settings does not change DEFAULT_SETTINGS', () => {
  const result = loadSettings({});
  result.settings.tempo.percent = 99;
  result.settings.mode = 'live';
  assert.equal(DEFAULT_SETTINGS.tempo.percent, 60);
  assert.equal(DEFAULT_SETTINGS.mode, 'wait');
});

test('holds.minPercent out of range warns and uses 50', () => {
  const result = loadSettings({ holds: { minPercent: 5 } });
  assert.deepEqual(result.warnings, ['holds.minPercent: must be a number from 10 to 100, using 50']);
  assert.equal(result.settings.holds.minPercent, 50);
});

test('followJumps must be a boolean', () => {
  const result = loadSettings({ followJumps: 'yes' });
  assert.deepEqual(result.warnings, ['followJumps: must be true or false, using true']);
  assert.equal(result.settings.followJumps, true);
});

test('holds that is not an object warns and uses defaults', () => {
  const result = loadSettings({ holds: 3 });
  assert.deepEqual(result.settings.holds, DEFAULT_SETTINGS.holds);
  assert.deepEqual(result.warnings, ['holds: must be an object, using defaults']);
});

test('autoplay.shortEvery must be a whole number', () => {
  const result = loadSettings({ autoplay: { shortEvery: 2.5 } });
  assert.deepEqual(result.warnings, ['autoplay.shortEvery: must be a whole number from 0 to 1000, using 0']);
  assert.equal(result.settings.autoplay.shortEvery, 0);
});

test('new settings with valid values give no warnings', () => {
  const result = loadSettings({
    repeatsAfterJump: true,
    tempo: { followChanges: false },
    holds: { wait: true, pedal: false },
    view: { zoomRedrawMs: 0 },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.settings.repeatsAfterJump, true);
  assert.equal(result.settings.tempo.followChanges, false);
  assert.equal(result.settings.holds.wait, true);
  assert.equal(result.settings.holds.pedal, false);
  assert.equal(result.settings.view.zoomRedrawMs, 0);
});

test('ramp settings load, validate and warn', () => {
  const ok = loadSettings({ ramp: { enabled: true, stepPercent: 10, targetPercent: 120, backAfterBad: 0 } });
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(ok.settings.ramp, { enabled: true, stepPercent: 10, targetPercent: 120, backAfterBad: 0 });

  const step = loadSettings({ ramp: { stepPercent: 0 } });
  assert.deepEqual(step.warnings, ['ramp.stepPercent: must be a whole number from 1 to 50, using 5']);
  assert.equal(step.settings.ramp.stepPercent, 5);

  const target = loadSettings({ ramp: { targetPercent: 2.5 } });
  assert.equal(target.warnings.length, 1);
  assert.ok(target.warnings[0].startsWith('ramp.targetPercent:'));

  const unknown = loadSettings({ ramp: { speed: 1 } });
  assert.deepEqual(unknown.warnings, ['ramp.speed: unknown setting, ignored']);
});

test('settingsOverrides parses dotted keys into nested values', () => {
  const result = settingsOverrides('followJumps:false,holds.wait:true,autoplay.shortEvery:2,tempo.followChanges:false,view.zoomRedrawMs:null,holds.minPercent:abc');
  assert.deepEqual(result.raw, {
    followJumps: false,
    holds: { wait: true, minPercent: 'abc' },
    autoplay: { shortEvery: 2 },
    tempo: { followChanges: false },
    view: { zoomRedrawMs: null },
  });
  assert.deepEqual(result.warnings, []);
});

test('settingsOverrides splits each pair at the first colon', () => {
  assert.deepEqual(settingsOverrides('view.zoomRedrawMs:a:b').raw, { view: { zoomRedrawMs: 'a:b' } });
});

test('settingsOverrides warns about bad pairs and forbidden keys', () => {
  const result = settingsOverrides('followJumps,holds.wait:true,constructor.x:1,__proto__:1,prototype:2,:3');
  assert.deepEqual(result.raw, { holds: { wait: true } });
  assert.deepEqual(result.warnings, [
    'followJumps: expected key:value, skipped',
    'constructor.x: not a setting key, skipped',
    '__proto__: not a setting key, skipped',
    'prototype: not a setting key, skipped',
    ':3: expected key:value, skipped',
  ]);
});

test('mergeSettingsRaw deep merges with overrides winning and does not change the base', () => {
  const base = { mode: 'wait', holds: { live: true, wait: false } };
  const merged = mergeSettingsRaw(base, { mode: 'live', holds: { wait: true } });
  assert.deepEqual(merged, { mode: 'live', holds: { live: true, wait: true } });
  assert.deepEqual(base, { mode: 'wait', holds: { live: true, wait: false } });
});

test('mergeSettingsRaw skips forbidden keys', () => {
  const overrides = JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"tempo":{"percent":70}}');
  const merged = mergeSettingsRaw({}, overrides);
  assert.deepEqual(merged, { tempo: { percent: 70 } });
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('settingsOverrides and mergeSettingsRaw feed loadSettings', () => {
  const merged = mergeSettingsRaw(json, settingsOverrides('holds.wait:true,followJumps:false').raw);
  const result = loadSettings(merged);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.settings.holds.wait, true);
  assert.equal(result.settings.followJumps, false);
});
