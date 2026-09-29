/** Keep operational error classes and codes without logging provider or SQL values. */
export function safeErrorKind(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name : 'UnknownError';
  const value = typeof error === 'object' && error !== null && 'code' in error
    ? error.code : undefined;
  const code = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${name} (${code})` : name;
}
