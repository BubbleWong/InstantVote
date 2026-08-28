import test from "node:test";
import assert from "node:assert/strict";
import { createUuid } from "../public/uuid.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("creates a UUID when randomUUID is unavailable", () => {
  let seed = 0;
  const compatibleCrypto = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed++;
      return bytes;
    },
  };

  assert.match(createUuid(compatibleCrypto), UUID_V4_PATTERN);
});

test("requires secure random bytes", () => {
  assert.throws(() => createUuid({}), /Secure random number generation/);
});
