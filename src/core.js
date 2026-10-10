/**
 * Structured log field validator.
 *
 * Validates that structured log payloads conform to a schema of required and
 * typed fields, rejecting malformed entries before they reach a sink.
 *
 * Design choices (stated plainly so the reader knows what they get):
 *
 * - Unknown fields are allowed. The purpose is to reject malformed entries,
 *   not to enforce a closed schema. If a log entry carries an extra field, that
 *   is not treated as an error.
 *
 * - A field listed in the schema is REQUIRED unless explicitly marked optional.
 *   Missing required fields produce a validation error.
 *
 * - Type checks are strict. `string` does not accept arrays or objects even
 *   though `typeof` returns 'object' for both. A `number` must be a finite
 *   number; NaN and Infinity are rejected because they break JSON sinks.
 *
 * - `array<string>` means every element must be a string. Empty arrays are
 *   valid. There is no syntax for 'non-empty array' — that is a job for
 *   custom validators.
 *
 * - Custom validators receive the value and must return true/false. They are
 *   only called when the built-in type check passes, so they can assume the
 *   value is of the right shape.
 */

/**
 * Thrown when a schema definition is itself invalid (a programmer error),
 * distinct from a validation failure (a data error).
 */
export class SchemaError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/**
 * Accumulates field-level errors for a single payload. Thrown by validate()
 * when any field fails; returned (not thrown) by check() so callers can
 * decide what to do.
 */
export class ValidationError extends Error {
  /**
   * @param {Array<{field: string, message: string}>} errors
   */
  constructor(errors) {
    const detail = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    super(`Validation failed — ${detail}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Internal helper used while validating a single payload. Not exported.
 * Exists so the validator does not allocate an array on the hot path when
 * there are no errors.
 */
class ErrorBuilder {
  constructor() {
    /** @type {Array<{field: string, message: string}>|null} */
    this.errors = null;
  }

  /**
   * @param {string} field
   * @param {string} message
   */
  add(field, message) {
    if (this.errors === null) {
      this.errors = [];
    }
    this.errors.push({ field, message });
  }

  /**
   * @returns {ValidationError|null}
   */
  build() {
    if (this.errors === null) {
      return null;
    }
    return new ValidationError(this.errors);
  }
}

// Kept for API symmetry and future use; the README does not advertise it,
// but it is exported so callers building validators programmatically can
// construct errors if they need to.
export const ValidationErrorBuilder = ErrorBuilder;

const TYPE_KEYWORDS = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);

const ARRAY_ELEMENT_RE = /^array<(.+)>$/;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  // Reject arrays and anything with a modified prototype (class instances).
  // Logs should be plain data; accepting class instances would let callers
  // smuggle non-serialisable values through.
  if (Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {string} typeSpec
 * @returns {string|null}
 */
function arrayElementType(typeSpec) {
  const m = ARRAY_ELEMENT_RE.exec(typeSpec);
  return m ? m[1] : null;
}

/**
 * Validates a single value against a type spec.
 *
 * @param {unknown} value
 * @param {string} typeSpec
 * @returns {true|string} `true` if valid, otherwise an error message.
 */
function checkType(value, typeSpec) {
  // array<...> must be checked before the bare 'array' keyword.
  const elemType = arrayElementType(typeSpec);
  if (elemType !== null) {
    if (!Array.isArray(value)) {
      return `expected ${typeSpec}`;
    }
    for (let i = 0; i < value.length; i++) {
      const r = checkType(value[i], elemType);
      if (r !== true) {
        return `element ${i}: ${r}`;
      }
    }
    return true;
  }

  switch (typeSpec) {
    case 'string':
      return typeof value === 'string' ? true : 'expected string';
    case 'number':
      return isFiniteNumber(value) ? true : 'expected finite number';
    case 'boolean':
      return typeof value === 'boolean' ? true : 'expected boolean';
    case 'object':
      return isPlainObject(value) ? true : 'expected plain object';
    case 'array':
      return Array.isArray(value) ? true : 'expected array';
    default:
      // Should have been caught by validateSchema; defensive only.
      return `unknown type ${typeSpec}`;
  }
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isFunction(v) {
  return typeof v === 'function';
}

/**
 * Checks the schema itself is well-formed. Throwing here is intentional:
 * a bad schema is a programmer error, not a data error.
 *
 * @param {Record<string, any>} schema
 * @returns {void}
 */
function validateSchema(schema) {
  if (!isPlainObject(schema)) {
    throw new SchemaError('schema must be a plain object');
  }
  for (const key of Object.keys(schema)) {
    const def = schema[key];
    if (!isPlainObject(def)) {
      throw new SchemaError(`field "${key}": definition must be an object`);
    }
    if (!('type' in def)) {
      throw new SchemaError(`field "${key}": missing required "type" property`);
    }
    if (typeof def.type !== 'string') {
      throw new SchemaError(`field "${key}": "type" must be a string`);
    }
    const elemType = arrayElementType(def.type);
    const baseType = elemType ?? def.type;
    if (!TYPE_KEYWORDS.has(baseType)) {
      throw new SchemaError(`field "${key}": unknown type "${def.type}"`);
    }
    if (elemType !== null && !TYPE_KEYWORDS.has(elemType)) {
      throw new SchemaError(`field "${key}": unknown element type "${elemType}"`);
    }
    if ('optional' in def && typeof def.optional !== 'boolean') {
      throw new SchemaError(`field "${key}": "optional" must be a boolean`);
    }
    if ('validate' in def && !isFunction(def.validate)) {
      throw new SchemaError(`field "${key}": "validate" must be a function`);
    }
  }
}

/**
 * @typedef {Object} FieldDef
 * @property {string} type
 * @property {boolean} [optional]
 * @property {(value: any) => boolean} [validate]
 */

/**
 * @typedef {Object} Validator
 * @property {(payload: unknown) => ValidationError|null} check
 *   Validates a payload. Returns null on success, a ValidationError on failure.
 * @property {(payload: unknown) => void} validate
 *   Validates a payload. Returns nothing on success, throws ValidationError on failure.
 */

/**
 * Creates a validator bound to the given schema.
 *
 * @param {Record<string, FieldDef>} schema
 * @returns {Validator}
 */
export function createValidator(schema) {
  validateSchema(schema);
  const fields = Object.keys(schema);

  /**
   * @param {unknown} payload
   * @returns {ValidationError|null}
   */
  function check(payload) {
    const errors = new ErrorBuilder();

    if (!isPlainObject(payload)) {
      // A non-object payload cannot satisfy any schema field, so we report
      // a single structural error rather than one per missing field.
      errors.add('(root)', 'expected a plain object');
      return errors.build();
    }

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const def = schema[field];
      const has = Object.prototype.hasOwnProperty.call(payload, field);

      if (!has) {
        if (!def.optional) {
          errors.add(field, 'required field is missing');
        }
        continue;
      }

      const value = payload[field];
      const typeResult = checkType(value, def.type);
      if (typeResult !== true) {
        errors.add(field, typeResult);
        continue;
      }

      if (def.validate) {
        // Custom validator runs only after the type check, so it can safely
        // assume the value is of the right shape.
        let ok;
        try {
          ok = def.validate(value);
        } catch (err) {
          // A throwing custom validator is a programmer error, but we surface
          // it as a field-level validation error rather than crashing the sink.
          ok = false;
          errors.add(field, `custom validator threw: ${err && err.message ? err.message : String(err)}`);
          continue;
        }
        if (ok !== true) {
          errors.add(field, 'custom validation failed');
        }
      }
    }

    return errors.build();
  }

  /**
   * @param {unknown} payload
   * @returns {void}
   */
  function validate(payload) {
    const err = check(payload);
    if (err !== null) {
      throw err;
    }
  }

  return { check, validate };
}
