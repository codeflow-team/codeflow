/**
 * The registry fingerprint rests on this hash, so it is checked against the
 * published SHA-256 test vectors rather than against itself.
 */

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/util/canonical-json.js";
import { sha256Hex } from "../src/util/sha256.js";

describe("sha256Hex", () => {
  it("matches the standard test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles exact block boundaries and long input", () => {
    expect(sha256Hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
    expect(sha256Hex("a".repeat(1000000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("encodes UTF-8, including astral characters", () => {
    expect(sha256Hex("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
    expect(sha256Hex("🐙")).toBe(
      "35642a24fabc97f8e0d27aa5556f58907ab48ac4a5e390f3eb40caf8b6379b9b",
    );
  });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined and function values", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: () => 1 })).toBe('{"a":1}');
  });
});
