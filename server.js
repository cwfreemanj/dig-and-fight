/*
  Dig & Fight: Co-op Multiplayer Server
  Deploy target: Railway + GitHub
*/
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/status', (_req, res) => res.json({ ok: true, players: players.size, level: world.level, state: world.state }));

const TILE = 32;
const COLS = 18;
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const SNAPSHOT_RATE = 12;
const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;
const MAX_PLAYERS = 24;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));

function sanitizeName(raw) {
  return String(raw || 'Digger')
    .replace(/[^a-zA-Z0-9_ \-]/g, '')
    .slice(0, 16)
    .trim() || 'Digger';
}

const TILE_DEFS = {
  empty:   { hp: 0, value: 0 },
  dirt:    { hp: 28, value: 1 },
  clay:    { hp: 42, value: 2 },
  stone:   { hp: 62, value: 4 },
  iron:    { hp: 86, value: 9 },
  gold:    { hp: 112, value: 22 },
  emerald: { hp: 146, value: 42 },
  ruby:    { hp: 178, value: 70 },
  bedrock: { hp: 999999, value: 0 }
};
const RESOURCE_TYPES = ['dirt', 'clay', 'stone', 'iron', 'gold', 'emerald', 'ruby'];

const CLASS_DEFS = {
  mage: {
    name: 'Mage', emoji: '🧙', color: '#9a7cff', accent: '#72e9ff',
    hpMult: .92, damageMult: 1.22, speedMult: .96, resist: -.04, mineMult: .92, attackCd: .72,
    goldMult: 1.0, xpMult: 1.1, specialCd: 20, specialDuration: 6
  },
  bandit: {
    name: 'Bandit', emoji: '🗡️', color: '#4ee08a', accent: '#ffd45e',
    hpMult: .96, damageMult: 1.16, speedMult: 1.24, resist: -.02, mineMult: 1.0, attackCd: .34,
    goldMult: 1.28, xpMult: 1.25, specialCd: 18, specialDuration: 7
  },
  warrior: {
    name: 'Warrior', emoji: '⚔️', color: '#ffb34d', accent: '#ffe68c',
    hpMult: 1.18, damageMult: 1.05, speedMult: 1.0, resist: .03, mineMult: 1.0, attackCd: .52,
    goldMult: 1.0, xpMult: 1.0, specialCd: 14, specialDuration: .25
  },
  tank: {
    name: 'Tank', emoji: '🛡️', color: '#7fa4ff', accent: '#dfe9ff',
    hpMult: 1.48, damageMult: .9, speedMult: .84, resist: .17, mineMult: .95, attackCd: .62,
    goldMult: 1.0, xpMult: .95, specialCd: 24, specialDuration: 4.5
  },
  miner: {
    name: 'Miner', emoji: '⛏️', color: '#ffd45e', accent: '#72ff7f',
    hpMult: 1.04, damageMult: .96, speedMult: 1.0, resist: 0, mineMult: 1.55, attackCd: .54,
    goldMult: 1.1, xpMult: 1.05, specialCd: 20, specialDuration: 15
  }
};
const SPELLS = ['fireball', 'iceball', 'toxicball'];

const ENEMY_DEFS = {
  zombie:  { name: 'Zombie', hp: 34, damage: 8, armor: 0, speed: 42, value: 13, color: '#86d084' },
  orc:     { name: 'Orc', hp: 58, damage: 13, armor: 2, speed: 50, value: 23, color: '#5db25d' },
  armored: { name: 'Armored', hp: 88, damage: 18, armor: 7, speed: 35, value: 44, color: '#94a2b9' }
};
const CHEST_DEFS = {
  wood:    { name: 'Wooden Chest',  coinMult: 1.0, oreRolls: 2 },
  iron:    { name: 'Iron Chest',    coinMult: 1.55, oreRolls: 3 },
  gold:    { name: 'Golden Chest',  coinMult: 2.35, oreRolls: 4 },
  crystal: { name: 'Crystal Chest', coinMult: 3.4, oreRolls: 5 }
};

const UPGRADE_DEFS = {
  sword: { label: 'Sword', base: 70, scale: 1.32 },
  chest: { label: 'Chest Plate', base: 80, scale: 1.34 },
  helmet: { label: 'Helmet', base: 70, scale: 1.31 },
  boots: { label: 'Boots/Pantlegs', base: 65, scale: 1.30 },
  pickaxe: { label: 'Pickaxe', base: 75, scale: 1.33 },
  fireball: { label: 'Fireball', base: 110, scale: 1.37 },
  iceball: { label: 'Iceball', base: 110, scale: 1.37 },
  toxicball: { label: 'Toxic Ball', base: 110, scale: 1.37 }
};

let nextEnemyId = 1;
let nextProjectileId = 1;
let nextChestId = 1;
let nextDropId = 1;
const players = new Map();
const sockets = new Map();

const world = {
  state: 'playing',
  level: 1,
  rows: 80,
  tiles: [],
  enemies: [],
  chests: [],
  projectiles: [],
  drops: [],
  pressureY: 0,
  shopEndsAt: 0,
  levelStartedAt: now(),
  seed: Math.floor(Math.random() * 999999)
};

function upgradeCost(key, lvl) {
  const d = UPGRADE_DEFS[key];
  return Math.floor(d.base * Math.pow(d.scale, Math.max(0, lvl - 1)));
}
function defaultUpgrades() {
  return { sword: 1, chest: 1, helmet: 1, boots: 1, pickaxe: 1, fireball: 1, iceball: 1, toxicball: 1 };
}
function defaultStatsFor(p) {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.warrior;
  p.maxHp = Math.round((100 + (p.upgrades.helmet - 1) * 18) * cls.hpMult);
  p.speed = (130 + (p.upgrades.boots - 1) * 7) * cls.speedMult;
  p.defense = clamp((p.upgrades.chest - 1) * .035 + cls.resist, -0.1, .72);
  p.damage = (14 + (p.upgrades.sword - 1) * 4.8) * cls.damageMult;
  p.minePower = (22 + (p.upgrades.pickaxe - 1) * 7) * cls.mineMult;
  if (p.classKey === 'miner' && p.miningFocus > 0) p.minePower *= 2.6;
  if (p.classKey === 'bandit' && p.frenzy > 0) p.attackCdMult = .42; else p.attackCdMult = 1;
  p.hp = clamp(p.hp || p.maxHp, 0, p.maxHp);
}
function makePlayer(id, name, classKey) {
  classKey = CLASS_DEFS[classKey] ? classKey : 'warrior';
  const p = {
    id, name: sanitizeName(name), classKey,
    x: TILE * 9, y: TILE * 3, vx: 0, vy: 0,
    dir: 1, hp: 100, maxHp: 100, alive: true, downed: false,
    coins: 180, xp: 0, level: 1,
    upgrades: defaultUpgrades(),
    input: { left: false, right: false, up: false, down: false, mine: false, attack: false, special: false, aimX: TILE * 9, aimY: TILE * 5, spell: 'fireball' },
    attackCd: 0, mineCd: 0, specialCd: 0,
    invuln: 0, frenzy: 0, regen: 0, miningFocus: 0,
    lastHitAt: 0,
    statsVersion: 0
  };
  defaultStatsFor(p);
  return p;
}

function tileIndex(x, y) { return y * COLS + x; }
function inBounds(tx, ty) { return tx >= 0 && tx < COLS && ty >= 0 && ty < world.rows; }
function getTile(tx, ty) {
  if (!inBounds(tx, ty)) return { type: 'bedrock', hp: TILE_DEFS.bedrock.hp };
  return world.tiles[tileIndex(tx, ty)];
}
function setTile(tx, ty, t) {
  if (!inBounds(tx, ty)) return;
  world.tiles[tileIndex(tx, ty)] = t;
  io.emit('tileUpdate', { x: tx, y: ty, tile: t });
}
function isSolidType(type) { return type && type !== 'empty'; }
function isSolidAt(tx, ty) { return isSolidType(getTile(tx, ty).type); }
function chooseTileForDepth(depth, level) {
  if (depth < 0.08) return 'dirt';
  const r = Math.random();
  const richness = clamp(depth + level * 0.025, 0, 1.8);
  if (richness > 1.05 && r < 0.08) return 'ruby';
  if (richness > .82 && r < 0.12) return 'emerald';
  if (richness > .58 && r < 0.18) return 'gold';
  if (richness > .34 && r < 0.26) return 'iron';
  if (r < 0.58) return 'stone';
  if (r < 0.78) return 'clay';
  return 'dirt';
}
function makeTile(type, level) {
  if (type === 'empty') return { type: 'empty', hp: 0 };
  const def = TILE_DEFS[type] || TILE_DEFS.dirt;
  return { type, hp: Math.round(def.hp * (1 + (level - 1) * .22)) };
}
function generateWorld(level = 1) {
  world.state = 'playing';
  world.level = level;
  world.rows = Math.min(180, 76 + level * 8);
  world.tiles = new Array(COLS * world.rows);
  world.enemies = [];
  world.chests = [];
  world.projectiles = [];
  world.drops = [];
  world.pressureY = 0;
  world.levelStartedAt = now();
  world.seed = Math.floor(Math.random() * 999999999);
  nextEnemyId = 1; nextChestId = 1; nextProjectileId = 1; nextDropId = 1;

  for (let y = 0; y < world.rows; y++) {
    const depth = y / (world.rows - 1);
    for (let x = 0; x < COLS; x++) {
      let type = chooseTileForDepth(depth, level);
      if (x === 0 || x === COLS - 1 || y === world.rows - 1) type = 'bedrock';
      if (y < 5 && x > 2 && x < COLS - 3) type = 'empty';
      if (Math.random() < 0.14 && y > 7 && y < world.rows - 6 && x > 1 && x < COLS - 2) type = 'empty';
      world.tiles[tileIndex(x, y)] = makeTile(type, level);
    }
  }

  // Carve a rough, connected descent tunnel.
  let cx = Math.floor(COLS / 2);
  for (let y = 4; y < world.rows - 4; y++) {
    if (Math.random() < .45) cx += irand(-1, 1);
    cx = clamp(cx, 3, COLS - 4);
    for (let dx = -1; dx <= 1; dx++) world.tiles[tileIndex(cx + dx, y)] = makeTile('empty', level);
    if (Math.random() < .2) world.tiles[tileIndex(cx + irand(-2, 2), y)] = makeTile('empty', level);
  }
  // Exit chamber.
  for (let y = world.rows - 7; y < world.rows - 2; y++) {
    for (let x = 3; x < COLS - 3; x++) world.tiles[tileIndex(x, y)] = makeTile('empty', level);
  }

  const enemyCount = Math.min(80, 10 + level * 4);
  for (let i = 0; i < enemyCount; i++) spawnEnemyAtOpen(level);
  const chestCount = Math.min(34, 5 + Math.floor(level * 2.2));
  for (let i = 0; i < chestCount; i++) spawnChestAtOpen(level);

  for (const p of players.values()) {
    p.x = TILE * (8 + Math.random() * 2);
    p.y = TILE * 3;
    p.vx = p.vy = 0;
    p.alive = true; p.downed = false;
    defaultStatsFor(p);
    p.hp = p.maxHp;
    p.attackCd = p.mineCd = 0;
    p.invuln = p.frenzy = p.regen = p.miningFocus = 0;
  }
  emitMapInit();
}
function findOpenCell(minY = 7, maxY = world.rows - 8) {
  for (let tries = 0; tries < 900; tries++) {
    const x = irand(2, COLS - 3);
    const y = irand(minY, maxY);
    if (!isSolidAt(x, y) && !isSolidAt(x, y - 1)) return { x, y };
  }
  return { x: Math.floor(COLS / 2), y: minY };
}
function spawnEnemyAtOpen(level) {
  const cell = findOpenCell(9, world.rows - 9);
  let type = 'zombie';
  const depth = cell.y / world.rows;
  const roll = Math.random();
  if (level > 4 && depth > .56 && roll < .28) type = 'armored';
  else if (level > 2 && depth > .35 && roll < .5) type = 'orc';
  const def = ENEMY_DEFS[type];
  world.enemies.push({
    id: nextEnemyId++, type,
    x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2,
    vx: 0, vy: 0,
    hp: Math.round(def.hp * (1 + (level - 1) * .3)),
    maxHp: Math.round(def.hp * (1 + (level - 1) * .3)),
    damage: Math.round(def.damage * (1 + (level - 1) * .23)),
    armor: def.armor + Math.floor(level * .65),
    speed: def.speed + level * 1.5,
    freeze: 0, poison: 0, hitCd: 0,
    value: Math.round(def.value * (1 + level * .18))
  });
}
function chestTypeForDepth(depth, level) {
  const r = Math.random();
  if (depth > .78 && level > 4 && r < .35) return 'crystal';
  if (depth > .56 && level > 2 && r < .32) return 'gold';
  if (depth > .3 && r < .45) return 'iron';
  return 'wood';
}
function spawnChestAtOpen(level) {
  const cell = findOpenCell(8, world.rows - 8);
  const depth = cell.y / world.rows;
  world.chests.push({ id: nextChestId++, type: chestTypeForDepth(depth, level), x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2, opened: false });
}
function emitMapInit(socket = null) {
  const payload = {
    cols: COLS, rows: world.rows, tileSize: TILE, level: world.level, state: world.state,
    tiles: world.tiles.map(t => ({ type: t.type, hp: t.hp }))
  };
  if (socket) socket.emit('mapInit', payload); else io.emit('mapInit', payload);
}

function addFloatingDrop(x, y, kind, value) {
  world.drops.push({ id: nextDropId++, x, y, vx: rand(-35, 35), vy: rand(-90, -35), kind, value, ttl: 5 });
  if (world.drops.length > 160) world.drops.splice(0, world.drops.length - 160);
}
function awardPlayer(p, coins, xp, reason = 'Loot') {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.warrior;
  coins = Math.max(0, Math.floor(coins * cls.goldMult));
  xp = Math.max(0, Math.floor(xp * cls.xpMult));
  p.coins += coins;
  p.xp += xp;
  const need = 100 + p.level * 80;
  while (p.xp >= need) { p.xp -= need; p.level++; p.coins += 25 + p.level * 5; }
  sockets.get(p.id)?.emit('reward', { coins, xp, reason });
}
function mineTileByPlayer(p, tx, ty, amount, reason = 'Mining') {
  if (!inBounds(tx, ty)) return false;
  const tile = getTile(tx, ty);
  if (!tile || tile.type === 'empty' || tile.type === 'bedrock') return false;
  tile.hp -= amount;
  if (tile.hp <= 0) {
    const type = tile.type;
    setTile(tx, ty, makeTile('empty', world.level));
    const def = TILE_DEFS[type] || TILE_DEFS.dirt;
    const coins = Math.max(1, Math.round(def.value * (1 + world.level * .12)));
    awardPlayer(p, coins, Math.max(1, Math.round(coins * .6)), reason);
    addFloatingDrop(tx * TILE + TILE / 2, ty * TILE + TILE / 2, type, coins);
    return true;
  }
  io.emit('tileCrack', { x: tx, y: ty, hp: Math.max(0, tile.hp) });
  return false;
}
function damageEnemy(enemy, damage, attacker, reason = 'Hit') {
  if (!enemy || enemy.hp <= 0) return;
  const reduced = Math.max(1, Math.round(damage - enemy.armor * .5));
  enemy.hp -= reduced;
  enemy.hitCd = .12;
  io.emit('hitSpark', { x: enemy.x, y: enemy.y, text: String(reduced), color: '#ffdf72' });
  if (enemy.hp <= 0) {
    const p = attacker;
    if (p) awardPlayer(p, enemy.value, Math.round(enemy.value * 1.4), `Defeated ${ENEMY_DEFS[enemy.type].name}`);
    addFloatingDrop(enemy.x, enemy.y, 'coins', enemy.value);
  }
}
function openChest(chest, p) {
  if (!chest || chest.opened) return;
  chest.opened = true;
  const def = CHEST_DEFS[chest.type] || CHEST_DEFS.wood;
  const baseCoins = Math.round((35 + world.level * 16 + rand(0, 35)) * def.coinMult);
  awardPlayer(p, baseCoins, Math.round(baseCoins * .65), def.name);
  addFloatingDrop(chest.x, chest.y, 'chest', baseCoins);
  for (let i = 0; i < def.oreRolls; i++) {
    const type = RESOURCE_TYPES[Math.min(RESOURCE_TYPES.length - 1, irand(0, 2 + Math.floor((chest.y / (world.rows * TILE)) * 5)))];
    addFloatingDrop(chest.x + rand(-8, 8), chest.y + rand(-8, 8), type, Math.round(baseCoins / (def.oreRolls + 2)));
  }
  if (Math.random() < .42) p.hp = clamp(p.hp + p.maxHp * .22, 0, p.maxHp);
  io.emit('chestOpened', { id: chest.id, x: chest.x, y: chest.y, type: chest.type, by: p.name });
}

function collidePlayerWithWorld(p) {
  const radius = 11;
  p.x = clamp(p.x, TILE + radius, (COLS - 1) * TILE - radius);
  p.y = clamp(p.y, TILE * 1.2, (world.rows - 1) * TILE - radius);
  // Simple anti-embed: if inside a solid block, push upward into nearest empty spot.
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  if (isSolidAt(tx, ty)) {
    for (let off = 1; off < 8; off++) {
      if (!isSolidAt(tx, ty - off)) { p.y = (ty - off) * TILE + TILE / 2; break; }
      if (!isSolidAt(tx, ty + off)) { p.y = (ty + off) * TILE + TILE / 2; break; }
    }
  }
}
function nearestAlivePlayer(x, y) {
  let best = null, bd = Infinity;
  for (const p of players.values()) {
    if (!p.alive) continue;
    const d = dist(x, y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  return { player: best, distance: bd };
}
function tryMeleeAttack(p) {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.warrior;
  const cd = cls.attackCd * (p.attackCdMult || 1);
  if (p.attackCd > 0) return;
  p.attackCd = cd;
  const ax = Number.isFinite(p.input.aimX) ? p.input.aimX : p.x + p.dir * 80;
  const ay = Number.isFinite(p.input.aimY) ? p.input.aimY : p.y;
  const ang = Math.atan2(ay - p.y, ax - p.x);
  p.dir = Math.cos(ang) >= 0 ? 1 : -1;
  const reach = 58 + p.upgrades.sword * 3;
  const arc = Math.PI * .75;
  io.emit('swing', { id: p.id, x: p.x, y: p.y, angle: ang, reach, color: cls.accent });

  for (const e of world.enemies) {
    if (e.hp <= 0) continue;
    const d = dist(p.x, p.y, e.x, e.y);
    if (d > reach + 15) continue;
    const ea = Math.atan2(e.y - p.y, e.x - p.x);
    let da = Math.abs(ea - ang); while (da > Math.PI) da = Math.abs(da - Math.PI * 2);
    if (da <= arc / 2) damageEnemy(e, p.damage, p, 'Slash');
  }
  for (const c of world.chests) if (!c.opened && dist(p.x, p.y, c.x, c.y) < reach) openChest(c, p);

  // Let sword chip one tile in the swing direction.
  const tx = Math.floor((p.x + Math.cos(ang) * Math.min(reach, 52)) / TILE);
  const ty = Math.floor((p.y + Math.sin(ang) * Math.min(reach, 52)) / TILE);
  mineTileByPlayer(p, tx, ty, Math.max(2, p.damage * .55), 'Sword chip');
}
function castMageSpell(p) {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.mage;
  if (p.attackCd > 0) return;
  p.attackCd = cls.attackCd * .88;
  const spell = SPELLS.includes(p.input.spell) ? p.input.spell : 'fireball';
  const ax = Number.isFinite(p.input.aimX) ? p.input.aimX : p.x + p.dir * 90;
  const ay = Number.isFinite(p.input.aimY) ? p.input.aimY : p.y;
  const a = Math.atan2(ay - p.y, ax - p.x);
  const speed = 360;
  p.dir = Math.cos(a) >= 0 ? 1 : -1;
  world.projectiles.push({ id: nextProjectileId++, ownerId: p.id, spell, x: p.x, y: p.y - 5, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, ttl: 1.6, radius: 7 });
}
function explodeSpell(proj) {
  const owner = players.get(proj.ownerId);
  const lvl = owner?.upgrades?.[proj.spell] || 1;
  const radius = 58 + lvl * 5;
  const damage = (owner?.damage || 14) * (1.15 + lvl * .16);
  const color = proj.spell === 'iceball' ? '#72e9ff' : proj.spell === 'toxicball' ? '#72ff7f' : '#ff8a3d';
  io.emit('spellImpact', { x: proj.x, y: proj.y, spell: proj.spell, radius, color });
  for (const e of world.enemies) {
    if (e.hp <= 0 || dist(proj.x, proj.y, e.x, e.y) > radius) continue;
    if (proj.spell === 'iceball') { e.freeze = Math.max(e.freeze, 3 + lvl * .22); damageEnemy(e, damage * .72, owner, 'Iceball'); }
    else if (proj.spell === 'toxicball') { e.poison = Math.max(e.poison, 5 + lvl * .35); damageEnemy(e, damage * .65, owner, 'Toxic Ball'); }
    else damageEnemy(e, damage, owner, 'Fireball');
  }
  if (proj.spell === 'fireball') {
    const minX = Math.floor((proj.x - radius) / TILE), maxX = Math.floor((proj.x + radius) / TILE);
    const minY = Math.floor((proj.y - radius) / TILE), maxY = Math.floor((proj.y + radius) / TILE);
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      if (dist(proj.x, proj.y, tx * TILE + TILE / 2, ty * TILE + TILE / 2) <= radius) {
        mineTileByPlayer(owner, tx, ty, damage * .6, 'Fireball blast');
      }
    }
  }
  for (const c of world.chests) if (!c.opened && dist(proj.x, proj.y, c.x, c.y) <= radius) openChest(c, owner);
}
function useSpecial(p) {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.warrior;
  if (p.specialCd > 0) return;
  p.specialCd = cls.specialCd;
  if (p.classKey === 'mage') {
    p.regen = cls.specialDuration;
    io.emit('specialFx', { id: p.id, type: 'regen', x: p.x, y: p.y, color: cls.accent });
  } else if (p.classKey === 'bandit') {
    p.frenzy = cls.specialDuration;
    io.emit('specialFx', { id: p.id, type: 'frenzy', x: p.x, y: p.y, color: cls.accent });
  } else if (p.classKey === 'warrior') {
    const radius = 96 + p.upgrades.sword * 4;
    for (const e of world.enemies) if (e.hp > 0 && dist(p.x, p.y, e.x, e.y) <= radius) damageEnemy(e, p.damage * 2.4, p, 'Super Slash');
    const minX = Math.floor((p.x - radius) / TILE), maxX = Math.floor((p.x + radius) / TILE);
    const minY = Math.floor((p.y - radius) / TILE), maxY = Math.floor((p.y + radius) / TILE);
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      if (dist(p.x, p.y, tx * TILE + TILE / 2, ty * TILE + TILE / 2) <= radius) mineTileByPlayer(p, tx, ty, p.damage * .95, 'Super Slash');
    }
    io.emit('specialFx', { id: p.id, type: 'slash', x: p.x, y: p.y, radius, color: cls.accent });
  } else if (p.classKey === 'tank') {
    p.invuln = cls.specialDuration;
    io.emit('specialFx', { id: p.id, type: 'invuln', x: p.x, y: p.y, color: cls.accent });
  } else if (p.classKey === 'miner') {
    p.miningFocus = cls.specialDuration;
    io.emit('specialFx', { id: p.id, type: 'mining', x: p.x, y: p.y, color: cls.accent });
  }
}

function updatePlayer(p, dt) {
  defaultStatsFor(p);
  if (!p.alive) return;
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.mineCd = Math.max(0, p.mineCd - dt);
  p.specialCd = Math.max(0, p.specialCd - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  p.frenzy = Math.max(0, p.frenzy - dt);
  p.regen = Math.max(0, p.regen - dt);
  p.miningFocus = Math.max(0, p.miningFocus - dt);

  if (p.regen > 0) p.hp = clamp(p.hp + p.maxHp * .12 * dt, 0, p.maxHp);

  let mx = 0, my = 0;
  if (p.input.left) mx -= 1;
  if (p.input.right) mx += 1;
  if (p.input.up) my -= 1;
  if (p.input.down) my += 1;
  const len = Math.hypot(mx, my) || 1;
  p.vx = (mx / len) * p.speed;
  p.vy = (my / len) * p.speed;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (mx) p.dir = Math.sign(mx);
  collidePlayerWithWorld(p);

  if (p.input.mine && p.mineCd <= 0) {
    const ax = Number.isFinite(p.input.aimX) ? p.input.aimX : p.x;
    const ay = Number.isFinite(p.input.aimY) ? p.input.aimY : p.y + 32;
    const tx = Math.floor(ax / TILE), ty = Math.floor(ay / TILE);
    if (dist(p.x, p.y, tx * TILE + TILE / 2, ty * TILE + TILE / 2) < 72) {
      mineTileByPlayer(p, tx, ty, p.minePower * .55, 'Mining');
      p.mineCd = p.miningFocus > 0 ? .06 : .115;
    }
    for (const c of world.chests) if (!c.opened && dist(p.x, p.y, c.x, c.y) < 56) openChest(c, p);
  }
  if (p.input.attack) {
    if (p.classKey === 'mage') castMageSpell(p); else tryMeleeAttack(p);
  }
  if (p.input.special) useSpecial(p);

  if (p.y < world.pressureY + TILE * 1.2) {
    p.alive = false;
    p.downed = true;
    sockets.get(p.id)?.emit('downed', { reason: 'The crush ceiling caught you.' });
    io.emit('hitSpark', { x: p.x, y: p.y, text: 'CRUSHED', color: '#ff5364' });
  }
  if (p.y > (world.rows - 6) * TILE) {
    enterShop(`${p.name} reached the bottom!`);
  }
}
function updateEnemies(dt) {
  for (const e of world.enemies) {
    if (e.hp <= 0) continue;
    e.freeze = Math.max(0, e.freeze - dt);
    e.poison = Math.max(0, e.poison - dt);
    e.hitCd = Math.max(0, e.hitCd - dt);
    if (e.poison > 0) e.hp -= (5 + world.level * 1.5) * dt;
    if (e.hp <= 0) { addFloatingDrop(e.x, e.y, 'coins', e.value); continue; }
    if (e.freeze > 0) continue;
    const target = nearestAlivePlayer(e.x, e.y);
    if (!target.player || target.distance > 620) continue;
    const p = target.player;
    const a = Math.atan2(p.y - e.y, p.x - e.x);
    e.vx = Math.cos(a) * e.speed;
    e.vy = Math.sin(a) * e.speed;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.x = clamp(e.x, TILE * 1.5, (COLS - 1.5) * TILE);
    e.y = clamp(e.y, TILE * 2, (world.rows - 2) * TILE);
    if (target.distance < 24 && now() - p.lastHitAt > 700) {
      p.lastHitAt = now();
      if (p.invuln <= 0) {
        const dmg = Math.max(1, Math.round(e.damage * (1 - p.defense)));
        p.hp -= dmg;
        sockets.get(p.id)?.emit('damage', { amount: dmg, from: ENEMY_DEFS[e.type].name });
        if (p.hp <= 0) {
          p.alive = false;
          p.downed = true;
          sockets.get(p.id)?.emit('downed', { reason: `${ENEMY_DEFS[e.type].name} knocked you down.` });
        }
      }
    }
  }
  world.enemies = world.enemies.filter(e => e.hp > -40);
  if (world.enemies.length < Math.min(30, 7 + world.level * 2) && Math.random() < .012 + world.level * .002) spawnEnemyAtOpen(world.level);
}
function updateProjectiles(dt) {
  const remaining = [];
  for (const pr of world.projectiles) {
    pr.ttl -= dt;
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    let hit = pr.ttl <= 0 || pr.x < TILE || pr.x > (COLS - 1) * TILE || pr.y < 0 || pr.y > world.rows * TILE;
    const tx = Math.floor(pr.x / TILE), ty = Math.floor(pr.y / TILE);
    if (!hit && isSolidAt(tx, ty)) hit = true;
    for (const e of world.enemies) if (!hit && e.hp > 0 && dist(pr.x, pr.y, e.x, e.y) < 18) hit = true;
    if (hit) explodeSpell(pr); else remaining.push(pr);
  }
  world.projectiles = remaining;
}
function updateDrops(dt) {
  for (const d of world.drops) {
    d.ttl -= dt;
    d.vy += 180 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.y > (world.rows - 2) * TILE) d.y = (world.rows - 2) * TILE;
  }
  world.drops = world.drops.filter(d => d.ttl > 0);
}
function pressureSpeed() {
  return 5.5 + world.level * .8 + Math.max(0, players.size - 1) * .45;
}
function enterShop(reason) {
  if (world.state === 'shop') return;
  world.state = 'shop';
  world.shopEndsAt = now() + 35000;
  for (const p of players.values()) {
    if (p.alive) awardPlayer(p, 70 + world.level * 18, 60 + world.level * 10, 'Level clear bonus');
  }
  io.emit('roomNotice', { text: reason || 'Level complete!', state: 'shop', shopEndsAt: world.shopEndsAt });
}
function maybeGameOver() {
  const list = [...players.values()];
  if (list.length > 0 && list.every(p => !p.alive) && world.state === 'playing') {
    world.state = 'shop';
    world.shopEndsAt = now() + 25000;
    io.emit('roomNotice', { text: 'Everyone was knocked down. Regroup in the shop.', state: 'shop', shopEndsAt: world.shopEndsAt });
  }
}
function gameTick() {
  const dt = TICK_MS / 1000;
  if (world.state === 'playing') {
    world.pressureY += pressureSpeed() * dt;
    for (const p of players.values()) updatePlayer(p, dt);
    updateEnemies(dt);
    updateProjectiles(dt);
    updateDrops(dt);
    maybeGameOver();
  } else if (world.state === 'shop') {
    if (now() > world.shopEndsAt) generateWorld(world.level + 1);
  }
}
function publicPlayer(p) {
  const cls = CLASS_DEFS[p.classKey] || CLASS_DEFS.warrior;
  return {
    id: p.id, name: p.name, classKey: p.classKey, className: cls.name, emoji: cls.emoji, color: cls.color, accent: cls.accent,
    x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, hp: Math.round(p.hp), maxHp: p.maxHp,
    alive: p.alive, coins: p.coins, xp: p.xp, level: p.level,
    upgrades: p.upgrades, specialCd: Number(p.specialCd.toFixed(1)), invuln: p.invuln, frenzy: p.frenzy, regen: p.regen, miningFocus: p.miningFocus
  };
}
function snapshot() {
  const snap = {
    state: world.state, level: world.level, rows: world.rows, cols: COLS, tileSize: TILE,
    pressureY: Math.round(world.pressureY), shopEndsAt: world.shopEndsAt,
    players: [...players.values()].map(publicPlayer),
    enemies: world.enemies.filter(e => e.hp > 0).map(e => ({ id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y), hp: Math.round(e.hp), maxHp: e.maxHp, freeze: e.freeze, poison: e.poison })),
    chests: world.chests.map(c => ({ id: c.id, type: c.type, x: Math.round(c.x), y: Math.round(c.y), opened: c.opened })),
    projectiles: world.projectiles.map(p => ({ id: p.id, spell: p.spell, x: Math.round(p.x), y: Math.round(p.y) })),
    drops: world.drops.map(d => ({ id: d.id, kind: d.kind, value: d.value, x: Math.round(d.x), y: Math.round(d.y), ttl: Number(d.ttl.toFixed(1)) }))
  };
  io.emit('snapshot', snap);
}
function handleBuyUpgrade(socket, key) {
  const p = players.get(socket.id);
  if (!p || !UPGRADE_DEFS[key]) return;
  if (p.classKey !== 'mage' && ['fireball', 'iceball', 'toxicball'].includes(key)) return;
  const lvl = p.upgrades[key] || 1;
  const cost = upgradeCost(key, lvl);
  if (p.coins < cost) { socket.emit('shopError', { message: `Need ${cost} coins.` }); return; }
  p.coins -= cost;
  p.upgrades[key] = lvl + 1;
  defaultStatsFor(p);
  socket.emit('shopBought', { key, level: p.upgrades[key], coins: p.coins });
}

io.on('connection', socket => {
  if (players.size >= MAX_PLAYERS) { socket.emit('serverFull'); socket.disconnect(true); return; }
  sockets.set(socket.id, socket);
  socket.emit('hello', { id: socket.id, classes: CLASS_DEFS, upgrades: UPGRADE_DEFS, tileDefs: TILE_DEFS, enemyDefs: ENEMY_DEFS, chestDefs: CHEST_DEFS });
  emitMapInit(socket);

  socket.on('join', data => {
    const p = makePlayer(socket.id, data?.name, data?.classKey);
    players.set(socket.id, p);
    sockets.set(socket.id, socket);
    socket.emit('joined', { id: socket.id, player: publicPlayer(p) });
    io.emit('roomNotice', { text: `${p.name} joined as ${CLASS_DEFS[p.classKey].name}.` });
    if (world.state !== 'playing') socket.emit('roomNotice', { text: 'You joined during shop time. Buy upgrades or start the next level.', state: world.state, shopEndsAt: world.shopEndsAt });
  });

  socket.on('input', data => {
    const p = players.get(socket.id);
    if (!p) return;
    p.input = {
      left: !!data.left, right: !!data.right, up: !!data.up, down: !!data.down,
      mine: !!data.mine, attack: !!data.attack, special: !!data.special,
      aimX: Number(data.aimX), aimY: Number(data.aimY),
      spell: SPELLS.includes(data.spell) ? data.spell : p.input.spell
    };
  });
  socket.on('buyUpgrade', key => handleBuyUpgrade(socket, String(key || '')));
  socket.on('startNextLevel', () => {
    if (world.state === 'shop') generateWorld(world.level + 1);
  });
  socket.on('revive', () => {
    const p = players.get(socket.id);
    if (!p || p.alive) return;
    const cost = Math.min(2500, 80 + world.level * 25);
    if (p.coins >= cost || world.state === 'shop') {
      if (world.state !== 'shop') p.coins -= cost;
      p.alive = true; p.downed = false; defaultStatsFor(p); p.hp = Math.max(1, Math.floor(p.maxHp * .55));
      p.x = TILE * 9; p.y = Math.max(world.pressureY + TILE * 3, TILE * 3);
      socket.emit('roomNotice', { text: 'Revived!' });
    }
  });
  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    players.delete(socket.id);
    sockets.delete(socket.id);
    if (p) io.emit('roomNotice', { text: `${p.name} left the dig.` });
  });
});

generateWorld(1);
setInterval(gameTick, TICK_MS);
setInterval(snapshot, SNAPSHOT_MS);
server.listen(PORT, () => console.log(`Dig & Fight co-op server listening on ${PORT}`));
