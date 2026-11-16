import { NextResponse } from 'next/server';
import { startPriceJob } from '@/worker/sync';

export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const job = await startPriceJob('incremental');
    return NextResponse.json({ ok: true, ...job });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Cron failed' }, { status: 500 });
  }
}
