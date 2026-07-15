import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOS_SIGNATURE = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const CHECKSUM_OFFSET_IN_OPTIONAL_HEADER = 64;
const CERTIFICATE_DIRECTORY_INDEX = 4;
const DIRECTORY_ENTRY_SIZE = 8;

const assertRange = (buffer, offset, length, message) => {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(
      "Invalid Windows PE file for Authenticode hashing: " + message,
    );
  }
};

const optionalHeaderLayout = (magic) => {
  if (magic === PE32_MAGIC) {
    return {
      dataDirectoriesOffset: 96,
      numberOfRvaAndSizesOffset: 92,
    };
  }

  if (magic === PE32_PLUS_MAGIC) {
    return {
      dataDirectoriesOffset: 112,
      numberOfRvaAndSizesOffset: 108,
    };
  }

  throw new Error(
    "Invalid Windows PE file for Authenticode hashing: unsupported optional header magic 0x" +
      magic.toString(16) +
      ".",
  );
};

const hashSegments = (buffer, excludedRanges) => {
  const hash = createHash("sha256");
  let cursor = 0;

  for (const range of excludedRanges) {
    if (range.start > cursor) {
      hash.update(buffer.subarray(cursor, range.start));
    }
    cursor = Math.max(cursor, range.end);
  }

  if (cursor < buffer.length) {
    hash.update(buffer.subarray(cursor));
  }

  return hash.digest("hex");
};

/**
 * Calculates the Authenticode canonical SHA-256 for a Windows PE file.
 *
 * The PE checksum, certificate-directory entry and certificate table are
 * excluded by the Authenticode specification, keeping the result stable
 * before and after code signing.
 */
export const sha256WindowsAuthenticode = (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Expected a Buffer containing a Windows PE file.");
  }

  assertRange(buffer, 0, 64, "missing DOS header.");
  if (buffer.readUInt16LE(0) !== DOS_SIGNATURE) {
    throw new Error(
      "Invalid Windows PE file for Authenticode hashing: missing MZ signature.",
    );
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  assertRange(buffer, peOffset, 24, "missing PE and COFF headers.");
  if (buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error(
      "Invalid Windows PE file for Authenticode hashing: missing PE signature.",
    );
  }

  const coffHeaderOffset = peOffset + 4;
  const optionalHeaderSize = buffer.readUInt16LE(coffHeaderOffset + 16);
  const optionalHeaderOffset = peOffset + 24;
  assertRange(
    buffer,
    optionalHeaderOffset,
    optionalHeaderSize,
    "truncated optional header.",
  );
  assertRange(buffer, optionalHeaderOffset, 2, "missing optional-header magic.");

  const layout = optionalHeaderLayout(buffer.readUInt16LE(optionalHeaderOffset));
  const checksumOffset =
    optionalHeaderOffset + CHECKSUM_OFFSET_IN_OPTIONAL_HEADER;
  const numberOfRvaAndSizesOffset =
    optionalHeaderOffset + layout.numberOfRvaAndSizesOffset;
  const certificateDirectoryOffset =
    optionalHeaderOffset +
    layout.dataDirectoriesOffset +
    CERTIFICATE_DIRECTORY_INDEX * DIRECTORY_ENTRY_SIZE;

  assertRange(buffer, checksumOffset, 4, "missing checksum.");
  assertRange(
    buffer,
    numberOfRvaAndSizesOffset,
    4,
    "missing NumberOfRvaAndSizes.",
  );

  const numberOfRvaAndSizes = buffer.readUInt32LE(numberOfRvaAndSizesOffset);
  const excludedRanges = [
    { start: checksumOffset, end: checksumOffset + 4 },
  ];

  if (numberOfRvaAndSizes > CERTIFICATE_DIRECTORY_INDEX) {
    assertRange(
      buffer,
      certificateDirectoryOffset,
      DIRECTORY_ENTRY_SIZE,
      "missing certificate directory.",
    );

    excludedRanges.push({
      start: certificateDirectoryOffset,
      end: certificateDirectoryOffset + DIRECTORY_ENTRY_SIZE,
    });

    const certificateOffset = buffer.readUInt32LE(certificateDirectoryOffset);
    const certificateSize = buffer.readUInt32LE(
      certificateDirectoryOffset + 4,
    );

    if (certificateOffset !== 0 || certificateSize !== 0) {
      assertRange(
        buffer,
        certificateOffset,
        certificateSize,
        "certificate table extends outside the file.",
      );
      excludedRanges.push({
        start: certificateOffset,
        end: certificateOffset + certificateSize,
      });
    }
  }

  excludedRanges.sort((left, right) => left.start - right.start);
  return hashSegments(buffer, excludedRanges);
};

export const sha256WindowsAuthenticodeFile = (filePath) =>
  sha256WindowsAuthenticode(readFileSync(filePath));

const invokedAsCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCli) {
  const fileFlagIndex = process.argv.indexOf("--file");
  const filePath = fileFlagIndex === -1 ? undefined : process.argv[fileFlagIndex + 1];

  if (!filePath || process.argv.length !== 4) {
    console.error("Usage: node windows-authenticode-hash.mjs --file <path>");
    process.exitCode = 2;
  } else {
    console.log(sha256WindowsAuthenticodeFile(filePath));
  }
}
