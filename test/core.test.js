import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator, ValidationError } from '../src/index.js';

describe('createValidator — happy path', () => {
  it('accepts a payload that matches a simple schema', () => {
    const v = createValidator({
      level: { type: 'string' },
      message: { type: 'string' },
      timestamp: { type: 'number' },
    });
    assert.equal(v.check({ level: 'info', message: 'hi', timestamp: 1 }), null);
    assert.equal(v.validate({ level: 'info', message: 'hi', timestamp: 1 }), undefined);
  });

  it('accepts extra unknown fields without error', () => {
    const v = createValidator({ level: { type: 'string' } });
    assert.equal(v.check({ level: 'info', extra: 'fine' }), null);
  });

  it('accepts an empty payload when all fields are optional', () => {
    const v = createValidator({
      traceId: { type: 'string', optional: true },
    });
    assert.equal(v.check({}), null);
  });
});

describe('createValidator — required fields', () => {
  it('reports a missing required field', () => {
    const v = createValidator({
      level: { type: 'string' },
      message: { type: 'string' },
    });
    const err = v.check({ level: 'info' });
    assert.ok(err instanceof ValidationError);
    assert.equal(err.errors.length, 1);
    assert.equal(err.errors[0].field, 'message');
  });

  it('reports multiple missing fields', () => {
    const v = createValidator({
      a: { type: 'string' },
      b: { type: 'number' },
    });
    const err = v.check({});
    assert.equal(err.errors.length, 2);
    const fields = err.errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ['a', 'b']);
  });

  it('treats explicit undefined as missing', () => {
    const v = createValidator({ level: { type: 'string' } });
    const err = v.check({ level: undefined });
    assert.ok(err instanceof ValidationError);
    assert.equal(err.errors[0].field, 'level');
  });
});

describe('createValidator — type checks', () => {
  it('rejects a number where a string is expected', () => {
    const v = createValidator({ level: { type: 'string' } });
    const err = v.check({ level: 5 });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /expected string/);
  });

  it('rejects NaN and Infinity for number fields', () => {
    const v = createValidator({ n: { type: 'number' } });
    const e1 = v.check({ n: NaN });
    assert.ok(e1 instanceof ValidationError);
    const e2 = v.check({ n: Infinity });
    assert.ok(e2 instanceof ValidationError);
  });

  it('rejects an array where a plain object is expected', () => {
    const v = createValidator({ meta: { type: 'object' } });
    const err = v.check({ meta: [1, 2] });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /plain object/);
  });

  it('rejects a class instance for an object field', () => {
    const v = createValidator({ meta: { type: 'object' } });
    class Bag {}
    const err = v.check({ meta: new Bag() });
    assert.ok(err instanceof ValidationError);
  });

  it('accepts a null-prototype object for an object field', () => {
    const v = createValidator({ meta: { type: 'object' } });
    const o = Object.create(null);
    o.k = 'v';
    assert.equal(v.check({ meta: o }), null);
  });
});

describe('createValidator — arrays', () => {
  it('accepts a typed array of strings', () => {
    const v = createValidator({ tags: { type: 'array<string>' } });
    assert.equal(v.check({ tags: ['a', 'b'] }), null);
  });

  it('accepts an empty array', () => {
    const v = createValidator({ tags: { type: 'array<string>' } });
    assert.equal(v.check({ tags: [] }), null);
  });

  it('rejects a non-array for an array<string> field', () => {
    const v = createValidator({ tags: { type: 'array<string>' } });
    const err = v.check({ tags: 'not-an-array' });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /expected array<string>/);
  });

  it('reports the index of a bad element', () => {
    const v = createValidator({ tags: { type: 'array<string>' } });
    const err = v.check({ tags: ['a', 3, 'c'] });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /element 1/);
  });

  it('accepts a bare array type with mixed element types', () => {
    const v = createValidator({ items: { type: 'array' } });
    assert.equal(v.check({ items: ['a', 1, true] }), null);
  });
});

describe('createValidator — custom validators', () => {
  it('runs the custom validator after the type check passes', () => {
    const v = createValidator({
      level: {
        type: 'string',
        validate: (s) => ['debug', 'info', 'warn', 'error'].includes(s),
      },
    });
    const err = v.check({ level: 'bogus' });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /custom validation failed/);
  });

  it('does not run the custom validator when the type is wrong', () => {
    let called = false;
    const v = createValidator({
      level: { type: 'string', validate: () => { called = true; return true; } },
    });
    v.check({ level: 5 });
    assert.equal(called, false);
  });

  it('surfaces a throwing custom validator as a field error', () => {
    const v = createValidator({
      level: { type: 'string', validate: () => { throw new Error('boom'); } },
    });
    const err = v.check({ level: 'info' });
    assert.ok(err instanceof ValidationError);
    assert.match(err.errors[0].message, /custom validator threw: boom/);
  });
});

describe('createValidator — non-object payloads', () => {
  it('reports a single structural error for a null payload', () => {
    const v = createValidator({ level: { type: 'string' } });
    const err = v.check(null);
    assert.ok(err instanceof ValidationError);
    assert.equal(err.errors.length, 1);
    assert.equal(err.errors[0].field, '(root)');
  });

  it('reports a single structural error for an array payload', () => {
    const v = createValidator({ level: { type: 'string' } });
    const err = v.check(['info']);
    assert.ok(err instanceof ValidationError);
    assert.equal(err.errors[0].field, '(root)');
  });
});

describe('createValidator — validate() throws', () => {
  it('throws a ValidationError on failure', () => {
    const v = createValidator({ level: { type: 'string' } });
    assert.throws(
      () => v.validate({ level: 5 }),
      (err) => err instanceof ValidationError && /expected string/.test(err.message),
    );
  });
});

describe('createValidator — schema errors', () => {
  it('throws when schema is not an object', () => {
    assert.throws(
      () => createValidator(null),
      (e) => e.name === 'SchemaError',
    );
  });

  it('throws when a field definition lacks a type', () => {
    assert.throws(
      () => createValidator({ level: { optional: true } }),
      (e) => e.name === 'SchemaError' && /missing required/.test(e.message),
    );
  });

  it('throws for an unknown type keyword', () => {
    assert.throws(
      () => createValidator({ level: { type: 'integer' } }),
      (e) => e.name === 'SchemaError' && /unknown type/.test(e.message),
    );
  });

  it('throws when optional is not a boolean', () => {
    assert.throws(
      () => createValidator({ level: { type: 'string', optional: 'yes' } }),
      (e) => e.name === 'SchemaError',
    );
  });

  it('throws when validate is not a function', () => {
    assert.throws(
      () => createValidator({ level: { type: 'string', validate: 'nope' } }),
      (e) => e.name === 'SchemaError',
    );
  });
});

describe('ValidationError', () => {
  it('exposes the errors array with field and message', () => {
    const err = new ValidationError([{ field: 'a', message: 'bad' }]);
    assert.deepEqual(err.errors, [{ field: 'a', message: 'bad' }]);
    assert.match(err.message, /a: bad/);
  });
});
