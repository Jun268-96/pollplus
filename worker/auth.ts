// Cloudflare Workers WebCrypto PBKDF2의 현재 반복 횟수 상한은 100,000이다.
const PASSWORD_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createPasswordSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

/** 길이·문자열을 먼저 검사한 뒤 고정 길이 해시를 비교한다. */
export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashPassword(password, salt);
  if (actualHash.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) {
    difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

export async function fingerprintClient(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}
