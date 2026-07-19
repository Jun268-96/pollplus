import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, Role, ServerMessage } from '../../shared/types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'rejected';

interface UsePollSocketOptions {
  adminKey?: string;
  onMessage: (msg: ServerMessage) => void;
}

// 이 횟수만큼 연속으로 "한 번도 open되지 못한 채" 실패하면 더 이상 재시도하지 않고
// 'rejected'로 고정한다 — WS 핸드셰이크가 서버에서 401/400/404로 거부되는 경우
// (예: adminKey 불일치) JS WebSocket API는 HTTP 상태코드를 노출하지 않으므로
// "일시적 네트워크 문제"와 구분할 수 없다. 대신 "여러 번 시도해도 단 한 번도 못 붙는다"를
// 신호로 삼아 무한 재연결 대신 명확한 실패 상태로 전환한다.
const GIVE_UP_AFTER_ATTEMPTS = 4;

/**
 * 참여자/뷰어/관리자 공용 WS 훅. "무캐싱 거울" 원칙:
 * - localStorage/sessionStorage에 poll 데이터를 저장하지 않는다(adminKey만 Admin 페이지에서 별도 저장).
 * - 재연결 시 옛 화면을 이어 붙이지 않는다 — status가 'connecting'이 되는 즉시 호출부가 "연결 중…"을 보여주고,
 *   서버가 다시 보내는 최신 state로 통째 교체한다.
 * - 지수 백오프로 자동 재연결. 단 한 번도 연결 성공한 적 없이 계속 실패하면 'rejected'로 멈춘다.
 * - 알 수 없는 메시지는 무시(크래시 금지) — JSON.parse 실패 시에도 무시.
 */
export function usePollSocket(pollId: string, role: Role, { adminKey, onMessage }: UsePollSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const attemptRef = useRef(0);
  const everOpenedRef = useRef(false);
  const unmountedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    setStatus('connecting');

    const url = new URL(`/api/polls/${pollId}/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('role', role);
    if (adminKey) url.searchParams.set('key', adminKey);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      everOpenedRef.current = true;
      setStatus('open');
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        onMessageRef.current(msg);
      } catch {
        // 알 수 없는/깨진 메시지는 무시
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // 이미 새 연결로 교체됨
      if (unmountedRef.current) return;

      if (!everOpenedRef.current && attemptRef.current >= GIVE_UP_AFTER_ATTEMPTS) {
        setStatus('rejected');
        return;
      }

      setStatus('closed');
      const delay = Math.min(1000 * 2 ** attemptRef.current, 8000);
      attemptRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollId, role, adminKey]);

  useEffect(() => {
    unmountedRef.current = false;
    attemptRef.current = 0;
    everOpenedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { status, send };
}
