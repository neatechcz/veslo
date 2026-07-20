import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  sha256WindowsAuthenticode,
} from "./windows-authenticode-hash.mjs";

const makeMinimalPe32Plus = () => {
  const buffer = Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(0xf0, 0x94);

  const optionalHeaderOffset = 0x98;
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  buffer.writeUInt32LE(16, optionalHeaderOffset + 108);
  buffer.write("unsigned executable payload", 0x200, "utf8");
  return buffer;
};

test("ignores Authenticode-mutable PE fields and certificate data", () => {
  const unsigned = makeMinimalPe32Plus();
  const signed = Buffer.concat([
    Buffer.from(unsigned),
    Buffer.from("certificate bytes", "utf8"),
  ]);
  const optionalHeaderOffset = 0x98;
  const certificateDirectoryOffset =
    optionalHeaderOffset + 112 + 4 * 8;

  signed.writeUInt32LE(0x12345678, optionalHeaderOffset + 64);
  signed.writeUInt32LE(unsigned.length, certificateDirectoryOffset);
  signed.writeUInt32LE(
    signed.length - unsigned.length,
    certificateDirectoryOffset + 4,
  );

  assert.notEqual(
    createHash("sha256").update(unsigned).digest("hex"),
    createHash("sha256").update(signed).digest("hex"),
  );
  assert.equal(
    sha256WindowsAuthenticode(unsigned),
    sha256WindowsAuthenticode(signed),
  );
});

test("rejects data that is not a PE file", () => {
  assert.throws(
    () => sha256WindowsAuthenticode(Buffer.from("not a PE")),
    /missing DOS header/,
  );
});
