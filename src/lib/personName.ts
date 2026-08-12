export function normalizePersonName(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function personNamesMatch(left: string, right: string) {
  const normalizedLeft = normalizePersonName(left);
  const normalizedRight = normalizePersonName(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

export function normalizeVaultPath(value: string) {
  return value.replaceAll("/", "\\").toLocaleLowerCase();
}
