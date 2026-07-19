import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreatePollRequest, CreatePollResponse } from '../../shared/types';

export default function CreatePoll() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const body: CreatePollRequest = { title: trimmed };
      const res = await fetch('/api/polls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('설문을 만들지 못했습니다');
      const data: CreatePollResponse = await res.json();
      navigate(`/admin/${data.pollId}?k=${data.adminKey}`);
    } catch {
      setError('설문을 만들지 못했습니다. 잠시 후 다시 시도해주세요.');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-bento-bg px-6">
      <div className="w-full max-w-md">
        <p className="text-xs font-semibold tracking-wide uppercase text-bento-muted mb-2">PollPlus</p>
        <h1 className="text-2xl font-bold text-bento-ink mb-1">새 설문 만들기</h1>
        <p className="text-sm text-bento-muted mb-8">제목만 입력하면 바로 시작할 수 있어요. 로그인은 필요 없어요.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: 6-2반 여름방학 사전 설문"
            autoFocus
            className="w-full rounded-xl border border-bento-border bg-bento-surface px-4 py-3 text-bento-ink placeholder:text-bento-muted focus:outline-none focus:ring-2 focus:ring-bento-accent"
          />
          <button
            type="submit"
            disabled={!title.trim() || submitting}
            className="w-full rounded-xl bg-bento-accent px-4 py-3 font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '만드는 중…' : '설문 만들기'}
          </button>
          {error && <p className="text-sm text-bento-bad">{error}</p>}
        </form>
      </div>
    </div>
  );
}
