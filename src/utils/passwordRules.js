export function validNewPassword(value) {
  return typeof value === 'string' && Array.from(value).length >= 12 &&
    new TextEncoder().encode(value).byteLength <= 72
}
