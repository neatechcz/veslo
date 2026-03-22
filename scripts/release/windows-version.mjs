const calverPattern = /^(\d{4})\.(?:([1-9]|1[0-2]))\.(\d+)$/;

export function deriveWindowsWixVersion(version) {
  const match = String(version || "").trim().match(calverPattern);
  if (!match) {
    throw new Error(`Invalid CalVer '${version}'. Expected YYYY.M.P.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = Number(match[3]);
  const major = year - 2000;

  if (major < 0 || major > 255) {
    throw new Error(
      `Cannot derive Windows MSI version from '${version}': major ${major} is outside 0-255.`,
    );
  }
  if (month > 255) {
    throw new Error(
      `Cannot derive Windows MSI version from '${version}': minor ${month} is outside 0-255.`,
    );
  }
  if (patch > 65535) {
    throw new Error(
      `Cannot derive Windows MSI version from '${version}': patch ${patch} is outside 0-65535.`,
    );
  }

  return `${major}.${month}.${patch}`;
}
