#!/usr/bin/env node
/**
 * Добавление игры в PLAYDROP.
 *
 *   node tools/add-game.js "C:\\build\\jackie" --id jackie --title "Джеки: Свалка до Луны" --genre Платформер
 *
 * Что делает:
 *   1. копирует билд в games/<id>/
 *   2. подменяет подключение Yandex SDK на playdrop-sdk.js (или вставляет его)
 *   3. предупреждает об абсолютных путях, которые сломаются в подпапке
 *   4. дописывает запись в games.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const src = args[0];

function opt(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

if (!src || src.startsWith('--')) {
  console.log('Использование: node tools/add-game.js <папка-с-билдом> --id <id> --title "<название>" [--genre <жанр>] [--tag <плашка>] [--desc "<описание>"]');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error('Папка не найдена:', src);
  process.exit(1);
}

const id = opt('id', path.basename(src).toLowerCase().replace(/[^a-z0-9-]/g, '-'));
const title = opt('title', id);
const genre = opt('genre', 'Игра');
const tag = opt('tag', '');
const desc = opt('desc', '');
const dest = path.join(ROOT, 'games', id);

// ── 1. копируем билд ─────────────────────────────────────────
if (fs.existsSync(dest)) {
  console.log('! games/' + id + ' уже существует — перезаписываю');
  fs.rmSync(dest, { recursive: true, force: true });
}
fs.cpSync(src, dest, { recursive: true });

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p) : files.push(p);
  }
})(dest);

const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`Скопировано: ${files.length} файлов, ${(bytes / 1048576).toFixed(1)} МБ`);

// ── 2. правим index.html игры ────────────────────────────────
const indexPath = path.join(dest, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('! В билде нет index.html — портал не сможет открыть игру');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');
const SDK_TAG = '<script src="../../sdk/playdrop-sdk.js"></script>';
const yandexSdk = /<script[^>]*src=["'][^"']*yandex[^"']*(?:sdk|games)[^"']*["'][^>]*>\s*<\/script>/gi;

if (yandexSdk.test(html)) {
  html = html.replace(yandexSdk, SDK_TAG);
  console.log('Подключение Yandex SDK заменено на playdrop-sdk.js');
} else if (!html.includes('playdrop-sdk.js')) {
  html = html.replace(/<\/head>/i, '  ' + SDK_TAG + '\n</head>');
  console.log('playdrop-sdk.js добавлен в <head>');
} else {
  console.log('playdrop-sdk.js уже подключён');
}

fs.writeFileSync(indexPath, html);

// ── 3. проверка абсолютных путей ─────────────────────────────
const absolute = [...html.matchAll(/(?:src|href)=["']\/(?!\/)([^"']*)["']/g)].map(m => '/' + m[1]);
if (absolute.length) {
  console.log('\n! Найдены пути от корня сайта — в подпапке они не найдутся:');
  [...new Set(absolute)].slice(0, 10).forEach(p => console.log('   ' + p));
  console.log('  Замените на относительные: "/build/game.js" → "build/game.js"');
}

// ── 4. запись в games.json ───────────────────────────────────
const listPath = path.join(ROOT, 'games.json');
const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const entry = {
  id, title, developer: 'ttsshhl', genre, tag,
  cover: `./assets/covers/${id}.jpg`,
  url: `./games/${id}/index.html`,
  description: desc,
  products: []
};

const at = list.findIndex(g => g.id === id);
at === -1 ? list.push(entry) : (list[at] = { ...list[at], ...entry });
fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');

console.log(`\nГотово: ${title} → games/${id}/`);
console.log(`Осталось положить обложку: assets/covers/${id}.jpg (640×480)`);
console.log(`Проверить: http://localhost:3000/game.html?id=${id}`);
