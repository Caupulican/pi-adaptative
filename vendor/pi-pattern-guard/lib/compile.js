'use strict';

const { validatePatternStructure } = require('./pattern-policy.cjs');

const { fillPatternRange, createPatternBudget, appendPatternOutput, joinPatternOutput } = require('./pattern-policy.cjs');
const utils = require('./utils');

const compile = (ast, options = {}) => {
  validatePatternStructure(ast);
  const budget = createPatternBudget();
  const walk = (node, parent = {}) => {
    const invalidBlock = utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    const invalid = invalidBlock === true || invalidNode === true;
    const prefix = options.escapeInvalid === true ? '\\' : '';
    const output = [];
    let outputLength = 0;

    if (node.isOpen === true) {
      return joinPatternOutput(prefix, node.value);
    }

    if (node.isClose === true) {
      console.log('node.isClose', prefix, node.value);
      return joinPatternOutput(prefix, node.value);
    }

    if (node.type === 'open') {
      return invalid ? joinPatternOutput(prefix, node.value) : '(';
    }

    if (node.type === 'close') {
      return invalid ? joinPatternOutput(prefix, node.value) : ')';
    }

    if (node.type === 'comma') {
      return node.prev.type === 'comma' ? '' : invalid ? node.value : '|';
    }

    if (node.value) {
      return node.value;
    }

    if (node.nodes && node.ranges > 0) {
      const args = utils.reduce(node.nodes);
      const range = fillPatternRange(args, { ...options, wrap: false, toRegex: true, strictZeros: true }, budget);

      if (range.length !== 0) {
        return args.length > 1 && range.length > 1 ? joinPatternOutput('(', range, ')') : range;
      }
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        outputLength = appendPatternOutput(output, walk(child, node), outputLength);
      }
    }

    return output.join('');
  };

  return walk(ast);
};

module.exports = compile;
