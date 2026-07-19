import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreatePollRequest, CreatePollResponse } from '../../shared/types';
import { getRecentPolls, saveRecentPoll } from '../lib/recentPolls';

export default function CreatePoll() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatePollResponse | null>(null);
  const recentPolls = getRecentPolls();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || adminPassword.length < 8 || adminPassword !== passwordConfirm || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const body: CreatePollRequest = { title: trimmed, adminPassword };
      const res = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('설문을 만들지 못했습니다');
      const data: CreatePollResponse = await res.json();
      saveRecentPoll(data.pollId, trimmed);
      setCreated(data);
    } catch {
      setError('설문을 만들지 못했습니다. 잠시 후 다시 시도해주세요.');
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-full flex items-center justify-center bg-bento-bg px-6">
        <div className="w-full max-w-md rounded-2xl border border-bento-accent bg-bento-surface p-6 text-center">
          <p className="text-2xl mb-2">🔐</p>
          <h1 className="text-xl font-bold text-bento-ink">관리자 복구 코드를 보관하세요</h1>
          <p className="mt-2 text-sm text-bento-muted">비밀번호를 잊었거나 다른 기기에서 관리해야 할 때 필요합니다. 지금 이 화면에서만 다시 확인할 수 있어요.</p>
          <div className="my-5 rounded-xl border border-bento-border bg-bento-bg px-4 py-3 font-mono text-base font-bold break-all select-all">
            {created.recoveryCode}
          </div>
          <p className="text-xs text-bento-muted">방 번호: <b className="font-mono text-bento-ink">{created.pollId}</b></p>
          <button
            type="button"
            onClick={() => navigate(`/admin/${created.pollId}#k=${created.adminKey}`)}
            className="mt-6 w-full rounded-xl bg-bento-accent px-4 py-3 font-semibold text-white"
          >
            코드를 저장했어요 · 관리 시작
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-bento-bg px-6 py-10">
      <div className="w-full max-w-md">
        <p className="text-xs font-semibold tracking-wide uppercase text-bento-muted mb-2">PollPlus</p>
        <h1 className="text-2xl font-bold text-bento-ink mb-1">새 설문 만들기</h1>
        <p className="text-sm text-bento-muted mb-8">로그인 없이 만들고, 방 번호와 관리자 비밀번호로 언제든 다시 관리할 수 있어요.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: 6-2반 여름방학 사전 설문"
            autoFocus
            className="w-full rounded-xl border border-bento-border bg-bento-surface px-4 py-3 text-bento-ink placeholder:text-bento-muted focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
          <input
            type="password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            placeholder="관리자 비밀번호 (8자 이상)"
            autoComplete="new-password"
            className="w-full rounded-xl border border-bento-border bg-bento-surface px-4 py-3 text-bento-ink placeholder:text-bento-muted focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            placeholder="관리자 비밀번호 확인"
            autoComplete="new-password"
            className="w-full rounded-xl border border-bento-border bg-bento-surface px-4 py-3 text-bento-ink placeholder:text-bento-muted focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
          {passwordConfirm && adminPassword !== passwordConfirm && <p className="text-xs text-bento-bad">비밀번호가 일치하지 않아요.</p>}
          <button
            type="submit"
            disabled={!title.trim() || adminPassword.length < 8 || adminPassword !== passwordConfirm || submitting}
            className="w-full rounded-xl bg-bento-accent px-4 py-3 font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '만드는 중…' : '설문 만들기'}
          </button>
          {error && <p className="text-sm text-bento-bad">{error}</p>}
        </form>

        {recentPolls.length > 0 && (
          <section className="mt-8 border-t border-bento-border pt-5">
            <h2 className="text-sm font-bold text-bento-ink mb-2">이 기기에서 최근 관리한 설문</h2>
            <div className="flex flex-col gap-2">
              {recentPolls.map((poll) => (
                <button
                  key={poll.pollId}
                  type="button"
                  onClick={() => navigate(`/admin/${poll.pollId}`)}
                  className="rounded-xl border border-bento-border bg-bento-surface px-3 py-2.5 text-left hover:border-bento-accent"
                >
                  <span className="block text-sm font-semibold text-bento-ink truncate">{poll.title}</span>
                  <span className="block mt-0.5 font-mono text-[11px] text-bento-muted">방 번호 {poll.pollId}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
