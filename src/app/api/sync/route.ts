import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPriceJobStatus, processPriceJobBatch, startPriceJob, syncInstruments } from '@/worker/sync';

export const maxDuration = 60;

const schema = z.object({
  action: z.enum(['instruments', 'start-backfill', 'start-incremental', 'tick']),
  jobId: z.string().optional(),
});

function authorized(req: Request) {
  const key = process.env.SYNC_ADMIN_KEY;
  return Boolean(key && req.headers.get('x-sync-key') === key);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, job: await getPriceJobStatus(jobId) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Request failed' }, { status: 404 });
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const body = schema.parse(await req.json());
    if (body.action === 'instruments') {
      const result = await syncInstruments();
      return NextResponse.json({ ok: true, result });
    }
    if (body.action === 'start-backfill' || body.action === 'start-incremental') {
      const mode = body.action === 'start-backfill' ? 'backfill' : 'incremental';
      const result = await startPriceJob(mode);
      return NextResponse.json({ ok: true, ...result });
    }
    if (!body.jobId) return NextResponse.json({ ok: false, error: 'jobId is required' }, { status: 400 });
    const job = await processPriceJobBatch(body.jobId, 1);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid request' }, { status: 500 });
  }
}
