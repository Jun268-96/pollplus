import type { Env } from './env';
import type { CreatePollRequest, CreatePollResponse } from '../shared/types';

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
  let body: CreatePollRequest;
  try {
    body = await request.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) {
    return new Response('title required', { status: 400 });
  }

  const pollId = randomId(8);
  const adminKey = randomId(24);

  const stub = env.POLL_ROOM.getByName(pollId);
  await stub.initPoll(pollId, title, adminKey);

  const responseBody: CreatePollResponse = { pollId, adminKey };
  return Response.json(responseBody);
}
