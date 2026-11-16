import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { processPriceJobBatch } from '@/worker/sync';

export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const active = await prisma.syncRun.findFirst({
      where: { kind: { in: ['PRICES_BACKFILL_JOB', 'PRICES_INCREMENTAL_JOB'] }, status: 'RUNNING' },
      orderBy: { startedAt: 'asc' },
    });
    if (!active) return NextResponse.json({ ok: true, message: 'No active price job.' });
    const batchSize = active.kind.includes('BACKFILL') ? 1 : 10;
    const job = await processPriceJobBatch(active.id, batchSize);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Worker failed' }, { status: 500 });
  }
}
