// Pure data access for the settings table. Defaults live in config, secrets are masked here
// so no caller can accidentally leak one.
const { db } = require('../db');
const { DEFAULTS, SETTING_KEYS, SECRET_KEYS, ENV_SEEDS } = require('../config/defaults');

const rowFor = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key);

function get(key) {
  const row = rowFor(key);
  return row ? row.value : DEFAULTS[key];
}
const getInt = (key, fallback = 0) => parseInt(get(key), 10) || fallback;
const getBool = (key) => get(key) === '1';
const has = (key) => !!String(get(key) || '').trim();

function set(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
}

function all() {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = get(k);
  return out;
}

// What the browser may see: secret values replaced by a "do you have one" flag.
function publicView() {
  const s = all();
  for (const [key, flag] of Object.entries(SECRET_KEYS)) {
    s[flag] = !!s[key];
    s[key] = '';
  }
  return s;
}

// Fill empty settings from the environment on first boot; saved values always win.
function seedFromEnv() {
  for (const [key, envName] of Object.entries(ENV_SEEDS)) {
    const value = process.env[envName];
    if (!value) continue;
    const row = rowFor(key);
    if (!row || !String(row.value || '').trim()) set(key, value);
  }
}

module.exports = { get, getInt, getBool, has, set, all, publicView, seedFromEnv };
