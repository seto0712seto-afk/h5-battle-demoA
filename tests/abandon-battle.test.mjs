import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function withModules(context) {
  const vite = await createServer({
    root: projectRoot,
    configFile: false,
    cacheDir: '.vite-cache',
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  });
  context.after(() => vite.close());
  const [integration, systems] = await Promise.all([
    vite.ssrLoadModule('/src/battleIntegration.ts'),
    vite.ssrLoadModule('/src/battleSystems.ts')
  ]);
  return {
    mountBattle: integration.mountBattle,
    battleSystemConfig: systems.battleSystemConfig
  };
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  values() {
    return this.owner.className.split(/\s+/u).filter(Boolean);
  }

  contains(value) {
    return this.values().includes(value);
  }

  add(...values) {
    this.owner.className = [...new Set([...this.values(), ...values])].join(' ');
  }

  remove(...values) {
    this.owner.className = this.values().filter((value) => !values.includes(value)).join(' ');
  }

  toggle(value, force) {
    const next = force ?? !this.contains(value);
    if (next) this.add(value);
    else this.remove(value);
    return next;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.textContent = '';
    this.id = '';
    this.type = '';
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ currentTarget: this, target: this, stopPropagation() {} });
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40 };
  }

  set innerHTML(value) {
    this.children.forEach((child) => {
      child.parentNode = null;
    });
    this.children = [];
    this.textContent = value;
  }

  get innerHTML() {
    return this.textContent;
  }
}

function dataValue(element, attributeName) {
  const key = attributeName
    .slice(5)
    .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  return element.dataset[key];
}

function matchesSelector(element, selector) {
  return selector.split(',').some((part) => {
    const simple = part.trim().split(/\s+/u).at(-1);
    if (!simple) return false;
    const id = simple.match(/#([\w-]+)/u)?.[1];
    if (id && element.id !== id) return false;
    const tag = simple.match(/^[a-z][\w-]*/iu)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    for (const className of [...simple.matchAll(/\.([\w-]+)/gu)].map((match) => match[1])) {
      if (!element.classList.contains(className)) return false;
    }
    for (const match of simple.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/gu)) {
      const [, name, expected] = match;
      const actual = name.startsWith('data-')
        ? dataValue(element, name)
        : element.attributes.get(name);
      if (actual === undefined || (expected !== undefined && String(actual) !== expected)) return false;
    }
    return true;
  });
}

function findButton(root, label) {
  return root.querySelectorAll('button').find((node) => node.textContent === label) ?? null;
}

function installDom() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let nextTimer = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const body = new FakeElement('body');
  globalThis.window = {
    performance: { now: () => 0 },
    setInterval(callback) {
      const handle = nextTimer++;
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    setTimeout(callback) {
      const handle = nextTimer++;
      timeouts.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      timeouts.delete(handle);
    }
  };
  globalThis.document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector)
  };
  return {
    body,
    intervals,
    runIntervals() {
      [...intervals.values()].forEach((callback) => callback());
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
}

function createMountOptions(config, root, callbacks = {}) {
  return {
    root,
    config,
    selectedSpiritIds: [config.creatureConfig[0].id],
    enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }],
    battleSeed: 'battle-s1-abandon',
    ...callbacks
  };
}

test('abandon confirmation cancels without state mutation and confirms through defeat exactly once', async (context) => {
  const { mountBattle, battleSystemConfig } = await withModules(context);
  const dom = installDom();
  try {
    const config = battleSystemConfig();
    const root = new FakeElement('div');
    dom.body.append(root);
    const battleEnds = [];
    const mounted = mountBattle(createMountOptions(config, root, {
      onBattleEnd: (result) => battleEnds.push(result)
    }));
    const stateBeforeConfirmation = structuredClone(mounted.game.state);

    const abandon = findButton(root, '放弃');
    assert.ok(abandon, 'an in-progress battle must show the abandon control');
    assert.equal(abandon.disabled, false);
    abandon.click();
    assert.ok(root.querySelector('.abandon-confirm-overlay'));
    assert.deepEqual(mounted.game.state, stateBeforeConfirmation);
    assert.equal(battleEnds.length, 0);

    findButton(root, '取消').click();
    assert.equal(root.querySelector('.abandon-confirm-overlay'), null);
    assert.deepEqual(mounted.game.state, stateBeforeConfirmation);
    assert.equal(battleEnds.length, 0);

    findButton(root, '放弃').click();
    const staleConfirm = findButton(root, '确认放弃');
    staleConfirm.click();
    assert.equal(mounted.game.state.phase, 'defeat');
    assert.equal(battleEnds.length, 1);
    assert.equal(battleEnds[0].result, 'defeat');
    assert.deepEqual(Object.keys(battleEnds[0]).sort(), ['playerSnapshot', 'result', 'state']);
    assert.deepEqual(Object.keys(battleEnds[0].playerSnapshot).sort(), [
      'mana',
      'selectedSpiritIds',
      'slots',
      'spirits'
    ]);
    assert.equal(findButton(root, '放弃'), null);

    staleConfirm.click();
    abandon.click();
    assert.equal(mounted.game.abandonBattle().ok, false);
    assert.equal(battleEnds.length, 1);
    assert.equal(root.querySelector('.abandon-confirm-overlay'), null);
    mounted.stop();
  } finally {
    dom.restore();
  }
});

test('stop neutralizes an open confirmation and normal victory and defeat remain authoritative', async (context) => {
  const { mountBattle, battleSystemConfig } = await withModules(context);
  const dom = installDom();
  try {
    const config = battleSystemConfig();
    const stoppedRoot = new FakeElement('div');
    dom.body.append(stoppedRoot);
    const stoppedEnds = [];
    const stopped = mountBattle(createMountOptions(config, stoppedRoot, {
      onBattleEnd: (result) => stoppedEnds.push(result)
    }));
    findButton(stoppedRoot, '放弃').click();
    const staleConfirm = findButton(stoppedRoot, '确认放弃');
    const stateBeforeStop = structuredClone(stopped.game.state);
    stopped.stop();
    staleConfirm.click();
    assert.equal(stoppedRoot.children.length, 0);
    assert.deepEqual(stopped.game.state, stateBeforeStop);
    assert.equal(stoppedEnds.length, 0);

    const victoryRoot = new FakeElement('div');
    dom.body.append(victoryRoot);
    const victoryEnds = [];
    const victory = mountBattle(createMountOptions(config, victoryRoot, {
      onBattleEnd: (result) => victoryEnds.push(result)
    }));
    Object.values(victory.game.state.enemies).forEach((enemy) => {
      enemy.hp = 0;
    });
    dom.runIntervals();
    assert.equal(victoryEnds.length, 1);
    assert.equal(victoryEnds[0].result, 'victory');
    assert.equal(findButton(victoryRoot, '放弃'), null);
    victory.stop();

    const defeatRoot = new FakeElement('div');
    dom.body.append(defeatRoot);
    const defeatEnds = [];
    const defeat = mountBattle(createMountOptions(config, defeatRoot, {
      onBattleEnd: (result) => defeatEnds.push(result)
    }));
    defeat.game.state.selectedSpiritIds.forEach((instanceId) => {
      defeat.game.state.spirits[instanceId].hp = 0;
    });
    dom.runIntervals();
    assert.equal(defeatEnds.length, 1);
    assert.equal(defeatEnds[0].result, 'defeat');
    assert.equal(findButton(defeatRoot, '放弃'), null);
    defeat.stop();
  } finally {
    dom.restore();
  }
});
