'use client';

import { useEffect, useState } from 'react';

type Job = {
  id: string; kind: string; status: string; total: number; completed: number;
  failed: number; fetched: number; inserted: number; progress: number; message?: string | null;
};

export default function SyncControls() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const saved = window.localStorage.getItem('sync-admin-key');
    if (saved) setKey(saved);
    const savedJob = window.localStorage.getItem('sync-job-id');
    if (savedJob && saved) void loadJob(savedJob, saved);
  }, []);

  async function request(url: string, method: 'GET' | 'POST', body?: unknown, secret = key) {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-sync-key': secret },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || 'درخواست ناموفق بود');
    return json;
  }

  async function loadJob(jobId: string, secret = key) {
    const result = await request(`/api/sync?jobId=${encodeURIComponent(jobId)}`, 'GET', undefined, secret);
    setJob(result.job);
    return result.job as Job;
  }

  async function start(action: 'start-backfill' | 'start-incremental') {
    if (!key.trim()) { setMessage('ابتدا کلید مدیریت همگام‌سازی را وارد کن.'); return; }
    setBusy(true); setMessage('در حال ایجاد عملیات...');
    window.localStorage.setItem('sync-admin-key', key);
    try {
      const result = await request('/api/sync', 'POST', { action });
      window.localStorage.setItem('sync-job-id', result.jobId);
      const current = await loadJob(result.jobId);
      setMessage(current.status === 'RUNNING' ? 'عملیات ایجاد شد. پردازش توسط Worker ورسل انجام می‌شود.' : 'عملیاتی برای پردازش وجود ندارد.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'خطای نامشخص');
    } finally { setBusy(false); }
  }

  async function runNext() {
    if (!job || !key) return;
    setBusy(true);
    try {
      const result = await request('/api/sync', 'POST', { action: 'tick', jobId: job.id });
      setJob(result.job);
      setMessage(result.job.status === 'RUNNING' ? 'یک مرحله پردازش شد.' : 'عملیات به پایان رسید.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'خطای نامشخص');
    } finally { setBusy(false); }
  }

  async function refresh() {
    if (!job || !key) return;
    try { await loadJob(job.id); } catch (error) {
      setMessage(error instanceof Error ? error.message : 'خطا در دریافت وضعیت');
    }
  }

  async function syncInstruments() {
    if (!key.trim()) { setMessage('ابتدا کلید مدیریت همگام‌سازی را وارد کن.'); return; }
    setBusy(true); setMessage('در حال دریافت فهرست نمادها...');
    try {
      const result = await request('/api/sync', 'POST', { action: 'instruments' });
      setMessage(`فهرست نمادها به‌روزرسانی شد: ${result.result.processed} نماد`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'خطا'); }
    finally { setBusy(false); }
  }

  return (
    <div className="sync-manager">
      <label className="sync-key-label">کلید مدیریت (SYNC_ADMIN_KEY)
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="کلید تعریف‌شده در Vercel" />
      </label>
      <div className="actions">
        <button disabled={busy} onClick={syncInstruments}>به‌روزرسانی فهرست نمادها</button>
        <button disabled={busy} onClick={() => start('start-backfill')}>شروع دریافت اولیه تاریخچه</button>
        <button disabled={busy} onClick={() => start('start-incremental')}>به‌روزرسانی دستی قیمت‌ها</button>
        <button className="secondary" disabled={busy || !job || job.status !== 'RUNNING'} onClick={runNext}>اجرای مرحله بعد</button>
        <button className="secondary" disabled={busy || !job} onClick={refresh}>تازه‌سازی وضعیت</button>
      </div>
      {job && <section className="job-status">
        <div className="job-heading"><strong>وضعیت عملیات</strong><span>{job.status}</span></div>
        <div className="progress"><span style={{ width: `${job.progress}%` }} /></div>
        <div className="job-metrics">
          <span>پیشرفت: {job.progress.toLocaleString('fa-IR')}٪</span>
          <span>موفق: {job.completed.toLocaleString('fa-IR')} / {job.total.toLocaleString('fa-IR')}</span>
          <span>ناموفق: {job.failed.toLocaleString('fa-IR')}</span>
          <span>دریافت: {job.fetched.toLocaleString('fa-IR')}</span>
          <span>ثبت/پردازش: {job.inserted.toLocaleString('fa-IR')}</span>
        </div>
        {job.message && <p>{job.message}</p>}
      </section>}
      {message && <p className="sync-message">{message}</p>}
      <p className="hint">Worker زمان‌بندی‌شده توسط GitHub Actions عملیات فعال را در پس‌زمینه ادامه می‌دهد. برای اجرای دستی مرحله‌ها، این صفحه را باز نگه دار و «اجرای مرحله بعد» را بزن.</p>
    </div>
  );
}
