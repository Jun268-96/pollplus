import type { Env } from './env';
import type { AdminAccessRequest, AdminAccessResponse, CreatePollRequest, CreatePollResponse } from '../shared/types';
import { createPasswordSalt, fingerprintClient, hashPassword } from './auth';

export { PollRoom } from './PollRoom';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/polls' && request.method === 'POST') {
      return handleCreatePoll(request, env);
    }

    const adminAccessMatch = url.pathname.match(/^\/api\/polls\/([^/]+)\/admin-access$/);
    if (adminAccessMatch && request.method === 'POST') {
      return handleAdminAccess(request, env, adminAccessMatch[1]);
    }

    const wsMatch = url.pathname.match(/^\/api\/polls\/([^/]+)\/ws$/);
    if (wsMatch) {
      const pollId = wsMatch[1];
      const stub = env.POLL_ROOM.getByName(pollId);
      return stub.fetch(request);
    }

    // 그 외 전부 정적 자산(SPA). not_found_handling: single-page-application이
    // navigation 요청만 index.html로 폴백시키고, 위 두 라우트(POST/WS 업그레이드)는
    // navigation 요청이 아니라서 이 지점까지 안 내려온다.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleCreatePoll(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const rawTitle =
    body !== null && typeof body === 'object' && 'title' in body ? (body as CreatePollRequest).title : undefined;
  const rawPassword =
    body !== null && typeof body === 'object' && 'adminPassword' in body
      ? (body as CreatePollRequest).adminPassword
      : undefined;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title || title.length > 120 || typeof rawPassword !== 'string' || rawPassword.length < 8 || rawPassword.length > 128) {
    return new Response('title required', { status: 400 });
  }

  const pollId = randomId(8);
  const adminKey = randomId(24);
  const passwordSalt = createPasswordSalt();
  const passwordHash = await hashPassword(rawPassword, passwordSalt);

  const stub = env.POLL_ROOM.getByName(pollId);
  await stub.initPoll(pollId, title, adminKey, passwordHash, passwordSalt);

  const responseBody: CreatePollResponse = { pollId, adminKey, recoveryCode: adminKey };
  return Response.json(responseBody);
}

async function handleAdminAccess(request: Request, env: Env, pollId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const input = body !== null && typeof body === 'object' ? (body as AdminAccessRequest) : {};
  const password = typeof input.password === 'string' ? input.password : undefined;
  const recoveryCode = typeof input.recoveryCode === 'string' ? input.recoveryCode : undefined;
  if ((!password && !recoveryCode) || (password && (password.length < 8 || password.length > 128)) || (recoveryCode && recoveryCode.length > 128)) {
    return new Response('invalid credentials', { status: 400 });
  }

  const clientFingerprint = await fingerprintClient(request.headers.get('CF-Connecting-IP') ?? 'unknown-client');
  const stub = env.POLL_ROOM.getByName(pollId);
  const result: AdminAccessResponse = await stub.verifyAdminAccess(password ?? null, recoveryCode ?? null, clientFingerprint);
  if (!result.ok) {
    const status = result.reason === 'rate_limited' ? 429 : result.reason === 'password_not_configured' ? 409 : 401;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
