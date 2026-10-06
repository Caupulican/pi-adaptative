'use strict';

const { validatePatternStructure } = require('./pattern-policy.cjs');

const { fillPatternRange, createPatternBudget, appendPatternResult } = require('./pattern-policy.cjs');
const stringify = require('./stringify');
const utils = require('./utils');

const append = (queue = '', stash = '', enclose = false, budget) => {
  const result = [];

  queue = [].concat(queue);
  stash = [].concat(stash);

  if (!stash.length) return queue;
  if (!queue.length) {
    const values = enclose ? utils.flatten(stash).map(ele => `{${ele}}`) : stash;
    for (const value of values) appendPatternResult(result, value, budget);
    return result;
  }

  for (const item of queue) {
    if (Array.isArray(item)) {
      for (const value of item) {
        appendPatternResult(result, append(value, stash, enclose, budget), budget);
      }
    } else {
      for (let ele of stash) {
        if (enclose === true && typeof ele === 'string') ele = `{${ele}}`;
        appendPatternResult(result, Array.isArray(ele) ? append(item, ele, enclose, budget) : item + ele, budget);
      }
    }
  }
  return utils.flatten(result);
};

const expand = (ast, options = {}) => {
  validatePatternStructure(ast);
  const budget = createPatternBudget();

  const walk = (node, parent = {}) => {
    node.queue = [];

    let p = parent;
    let q = parent.queue;

    while (p.type !== 'brace' && p.type !== 'root' && p.parent) {
      p = p.parent;
      q = p.queue;
    }

    if (node.invalid || node.dollar) {
      q.push(append(q.pop(), stringify(node, options), false, budget));
      return;
    }

    if (node.type === 'brace' && node.invalid !== true && node.nodes.length === 2) {
      q.push(append(q.pop(), ['{}'], false, budget));
      return;
    }

    if (node.nodes && node.ranges > 0) {
      const args = utils.reduce(node.nodes);

      let range = fillPatternRange(args, options, budget);
      if (range.length === 0) {
        range = stringify(node, options);
      }

      q.push(append(q.pop(), range, false, budget));
      node.nodes = [];
      return;
    }

    const enclose = utils.encloseBrace(node);
    let queue = node.queue;
    let block = node;

    while (block.type !== 'brace' && block.type !== 'root' && block.parent) {
      block = block.parent;
      queue = block.queue;
    }

    for (let i = 0; i < node.nodes.length; i++) {
      const child = node.nodes[i];

      if (child.type === 'comma' && node.type === 'brace') {
        if (i === 1) queue.push('');
        queue.push('');
        continue;
      }

      if (child.type === 'close') {
        q.push(append(q.pop(), queue, enclose, budget));
        continue;
      }

      if (child.value && child.type !== 'open') {
        queue.push(append(queue.pop(), child.value, false, budget));
        continue;
      }

      if (child.nodes) {
        walk(child, node);
      }
    }

    return queue;
  };

  return utils.flatten(walk(ast));
};

module.exports = expand;
