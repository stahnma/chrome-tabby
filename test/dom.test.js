// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * setChildren exists because replaceChildren() takes varargs: handing it an array
 * stringifies to "[object HTMLDivElement],..." instead of failing loudly. Reproduced
 * here against a node just faithful enough to show the difference.
 */
function fakeNode() {
  return {
    kids: [],
    replaceChildren(...args) {
      // Matches the DOM: non-Node arguments are coerced to strings.
      this.kids = args.map((a) => (a && a.__node ? a : String(a)));
    },
  };
}
const node = (name) => ({ __node: true, name, toString: () => '[object HTMLDivElement]' });

const setChildren = (n, kids) => {
  n.replaceChildren(...[kids].flat(Infinity).filter((k) => k != null));
};

test('the original bug: passing an array stringifies it', () => {
  const n = fakeNode();
  n.replaceChildren([node('a'), node('b')]);
  assert.equal(n.kids.length, 1);
  assert.match(n.kids[0], /\[object HTMLDivElement\],\[object HTMLDivElement\]/);
});

test('setChildren spreads an array into real children', () => {
  const n = fakeNode();
  setChildren(n, [node('a'), node('b')]);
  assert.equal(n.kids.length, 2);
  assert.ok(n.kids.every((k) => k.__node));
});

test('setChildren accepts a single node', () => {
  const n = fakeNode();
  setChildren(n, node('solo'));
  assert.equal(n.kids.length, 1);
  assert.equal(n.kids[0].name, 'solo');
});

test('setChildren flattens nested arrays', () => {
  const n = fakeNode();
  setChildren(n, [node('a'), [node('b'), node('c')]]);
  assert.equal(n.kids.length, 3);
});

test('setChildren drops null and undefined rather than rendering them', () => {
  const n = fakeNode();
  setChildren(n, [node('a'), null, undefined, node('b')]);
  assert.equal(n.kids.length, 2);
});

test('setChildren clears with an empty array', () => {
  const n = fakeNode();
  setChildren(n, [node('a')]);
  setChildren(n, []);
  assert.equal(n.kids.length, 0);
});

/**
 * `dataset` is a read-only accessor on a real Element: Object.assign onto the element
 * silently drops it, and assigning to it throws under module strict mode. The helper has
 * to merge into it. Reproduced against a node that behaves the same way.
 */
function elementLike() {
  const ds = {};
  const node = { kids: [], className: '', textContent: '' };
  Object.defineProperty(node, 'dataset', {
    get: () => ds,
    set() { throw new TypeError('Cannot set property dataset'); },
  });
  return node;
}

const el = (node, props = {}) => {
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  return node;
};

test('assigning dataset wholesale throws, which is why el() splits it out', () => {
  assert.throws(() => Object.assign(elementLike(), { dataset: { code: 'X' } }), TypeError);
});

test('el merges into dataset instead of replacing it', () => {
  const n = el(elementLike(), { className: 'group', dataset: { code: 'WIP' } });
  assert.equal(n.dataset.code, 'WIP');
  assert.equal(n.className, 'group');
});

test('el is unaffected when no dataset is passed', () => {
  const n = el(elementLike(), { textContent: 'hi' });
  assert.equal(n.textContent, 'hi');
  assert.deepEqual(n.dataset, {});
});
