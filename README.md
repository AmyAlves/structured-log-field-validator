# structured-log-field-validator

Validates that structured log payloads conform to a schema of required and typed fields, rejecting malformed entries before they reach a sink.

```js
import { createValidator } from 'structured-log-field-validator';

const validate = createValidator({
  level:     { type: 'string', validate: (s) => ['debug','info','warn','error'].includes(s) },
  message:   { type: 'string' },
  timestamp:{ type: 'number' },
  tags:     { type: 'array<string>', optional: true },
});

// Returns null on success, a ValidationError on failure.
const err = validate.check({ level: 'info', message: 'hi', timestamp: 1 });

// Throws on failure, returns nothing on success.
validate.validate({ level: 'info', message: 'hi', timestamp: 1 });
```

Exported names: `createValidator`, `ValidationError`.

## Why this exists

Logging sinks — files, HTTP endpoints, search indexes — tend to assume their input is well-formed. A single entry with `timestamp: null` or `level: 123` can break ingestion for the whole batch or, worse, be silently dropped. This library checks each payload against a small schema **before** it reaches the sink, so malformed entries are caught at the application boundary.

The trade-off is simplicity over expressiveness. The type system is deliberately small: `string`, `number`, `boolean`, `object`, `array`, and `array<...>` for typed element arrays. There is no union type, no optional-with-default, no non-empty-array constraint. If you need those, write a `validate` function for the field — it runs after the type check and can assume the value is the right shape.

## Edge cases you will hit

- **Unknown fields are allowed.** This validator rejects malformed entries, not surprising ones. An extra `traceId` on a log line is not an error. If you want a closed schema, check `Object.keys(payload)` yourself.

- **`number` rejects `NaN` and `Infinity`.** These serialise to `null` or invalid JSON in most sinks, so they are treated as type errors, not valid numbers.

- **`object` means a plain object.** Arrays and class instances are rejected, because they often carry non-serialisable baggage. A `null`-prototype object (`Object.create(null)`) is accepted.

- **A missing field and an explicitly `undefined` field are the same thing.** Both are treated as "not present"; a required field in either state is an error.

- **A throwing custom validator does not crash the sink.** The exception is caught and reported as a field-level validation error so the entry is rejected rather than crashing the caller.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

