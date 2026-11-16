import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import SyncControls from '@/components/SyncControls';

export const dynamic = 'force-dynamic';

export default async function Data() {
  let instruments = 0;
  let prices = 0;
  let runs: any[] = [];
  try {
    [instruments, prices, runs] = await Promise.all([
      prisma.instrument.count(),
      prisma.dailyPrice.count(),
      prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
    ]);
  } catch {}
  return <main className="subpage">
    <Link href="/">← بازگشت</Link>
    <h1>مدیریت داده بازار</h1>
    <div className="stats">
      <div className="stat"><span>نمادها</span><b>{instruments.toLocaleString('fa-IR')}</b></div>
      <div className="stat"><span>قیمت‌ها</span><b>{prices.toLocaleString('fa-IR')}</b></div>
    </div>
    <div className="panel">
      <h2>همگام‌سازی TSETMC</h2>
      <SyncControls />
    </div>
    <div className="panel">
      <h2>سوابق عملیات</h2>
      {runs.map((r) => <p key={r.id}>
        {r.kind} · {r.status} · {r.completed ?? 0}/{r.total ?? 0} نماد ·
        {r.fetched.toLocaleString('fa-IR')} دریافت · {r.inserted.toLocaleString('fa-IR')} ثبت ·
        {new Date(r.startedAt).toLocaleString('fa-IR')} {r.message || ''}
      </p>)}
    </div>
    <div className="notice">
      زمان‌بندی خودکار روزانه با Vercel Cron تنظیم شده است. اجرای Worker در هر دقیقه به پلن Pro ورسل نیاز دارد.
      برای امنیت، مقدار SYNC_ADMIN_KEY و CRON_SECRET را در Environment Variables تنظیم کن.
    </div>
  </main>;
}
