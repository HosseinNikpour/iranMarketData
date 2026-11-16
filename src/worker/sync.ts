import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tsetmc } from '../tsetmc/client';

type Obj = Record<string, unknown>;
type SyncMode = 'backfill' | 'resume' | 'incremental';

const BATCH_SIZE = 250;
const DB_RETRIES = 4;

function log(message: string) {
  console.log(`[SYNC ${new Date().toISOString()}] ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rowsOf(payload: unknown): Obj[] {
  if (Array.isArray(payload)) return payload as Obj[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Obj;
    for (const key of ['closingPriceDaily', 'marketwatch', 'instrument', 'instruments', 'data', 'items']) {
      if (Array.isArray(obj[key])) return obj[key] as Obj[];
    }
  }
  return [];
}

function dateOf(value: unknown): Date | null {
  const s = String(value ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  const date = new Date(Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8))
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try { return BigInt(String(value)); } catch { return null; }
}

function marketWatchPath() {
  const params = new URLSearchParams({
    market: '0', industrialGroup: '', showTraded: 'false',
    withBestLimits: 'false', hEven: '0', RefID: '0',
  });
  for (let i = 0; i <= 8; i++) params.append(`paperTypes[${i}]`, String(i + 1));
  return `ClosingPrice/GetMarketWatch?${params.toString()}`;
}

export async function syncInstruments() {
  const run = await prisma.syncRun.create({ data: { kind: 'INSTRUMENTS', status: 'RUNNING' } });
  try {
    log('Fetching instruments from TSETMC...');
    const rows = rowsOf(await tsetmc.get<unknown>(marketWatchPath()));
    if (!rows.length) throw new Error('TSETMC marketwatch returned no instruments.');

    let skipped = 0;
    const instruments: Array<{ insCode: string; symbol: string; name: string | null }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const insCode = String(row.insCode ?? '').trim();
      const symbol = String(row.lva ?? '').trim();
      const name = String(row.lvc ?? '').trim();
      if (!insCode || !symbol || seen.has(insCode)) { skipped++; continue; }
      seen.add(insCode);
      instruments.push({ insCode, symbol, name: name || null });
    }

    let processed = 0;
    for (let i = 0; i < instruments.length; i += 500) {
      const result = await prisma.instrument.createMany({
        data: instruments.slice(i, i + 500),
        skipDuplicates: true,
      });
      processed += result.count;
      log(`Instrument records inserted: ${processed}`);
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'SUCCESS', fetched: rows.length, inserted: processed,
        message: skipped ? `${skipped} invalid/duplicate rows skipped` : null, finishedAt: new Date() },
    });
    return { fetched: rows.length, processed, skipped };
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', message: error instanceof Error ? error.message : String(error), finishedAt: new Date() },
    });
    throw error;
  }
}

async function createManyWithRetry(data: Array<{
  instrumentId: string; date: Date; open: bigint | null; high: bigint | null;
  low: bigint | null; close: bigint | null; last: bigint | null;
  volume: bigint | null; value: bigint | null; rawPayload: Prisma.InputJsonValue;
}>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DB_RETRIES; attempt++) {
    try {
      return await prisma.dailyPrice.createMany({ data, skipDuplicates: true });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`Database batch failed (attempt ${attempt}/${DB_RETRIES}): ${message}`);
      if (attempt < DB_RETRIES) await sleep(attempt * 2500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Database batch failed');
}

export async function syncPrices(options: {
  insCode?: string;
  mode?: SyncMode;
  limit?: number;
} = {}) {
  const mode = options.mode ?? 'backfill';
  const where: Prisma.InstrumentWhereInput = options.insCode
    ? { insCode: options.insCode, isActive: true }
    : { isActive: true };

  if (mode === 'resume' && !options.insCode) {
    where.priceSyncStatus = { in: ['PENDING', 'FAILED', 'RUNNING'] };
  }

  const instruments = await prisma.instrument.findMany({
    where,
    orderBy: { symbol: 'asc' },
    ...(options.limit && options.limit > 0 ? { take: options.limit } : {}),
  });

  if (options.insCode && instruments.length === 0) {
    throw new Error(`Active instrument not found: ${options.insCode}`);
  }

  const run = await prisma.syncRun.create({
    data: { kind: `PRICES_${mode.toUpperCase()}`, status: 'RUNNING' },
  });

  let fetched = 0;
  let inserted = 0;
  let failed = 0;
  let completed = 0;
  const errors: string[] = [];

  log(`Price sync started. mode=${mode}, instruments=${instruments.length}`);

  try {
    for (const instrument of instruments) {
      const startedAt = Date.now();
      await prisma.instrument.update({
        where: { id: instrument.id },
        data: { priceSyncStatus: 'RUNNING', priceSyncLastAttempt: new Date(), priceSyncError: null },
      });

      try {
        log(`Fetching ${instrument.symbol} (${instrument.insCode})`);
        const payload = await tsetmc.get<unknown>(
          `ClosingPrice/GetClosingPriceDailyList/${instrument.insCode}/0`
        );
        const rows = rowsOf(payload);
        if (!rows.length) throw new Error('TSETMC returned an empty history.');

        fetched += rows.length;
        const records = new Map<string, {
          instrumentId: string; date: Date; open: bigint | null; high: bigint | null;
          low: bigint | null; close: bigint | null; last: bigint | null;
          volume: bigint | null; value: bigint | null; rawPayload: Prisma.InputJsonValue;
        }>();

        for (const row of rows) {
          const date = dateOf(row.dEven);
          if (!date) continue;
          records.set(date.toISOString(), {
            instrumentId: instrument.id, date,
            open: toBigInt(row.priceFirst), high: toBigInt(row.priceMax),
            low: toBigInt(row.priceMin), close: toBigInt(row.pClosing),
            last: toBigInt(row.pDrCotVal), volume: toBigInt(row.qTotTran5J),
            value: toBigInt(row.qTotCap),
            rawPayload: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
          });
        }

        const allData = [...records.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
        if (!allData.length) throw new Error('No valid dated records in TSETMC response.');

        let data = allData;
        if (mode === 'incremental') {
          const latest = await prisma.dailyPrice.findFirst({
            where: { instrumentId: instrument.id },
            orderBy: { date: 'desc' },
            select: { date: true },
          });
          if (latest) {
            const latestTime = latest.date.getTime();
            data = allData.filter((record) => record.date.getTime() >= latestTime);
          }
        }

        let addedForInstrument = 0;
        for (let i = 0; i < data.length; i += BATCH_SIZE) {
          const batch = data.slice(i, i + BATCH_SIZE);
          const result = await createManyWithRetry(batch);
          addedForInstrument += result.count;
          inserted += result.count;
          log(`${instrument.symbol}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(data.length / BATCH_SIZE)}, inserted=${result.count}`);
        }

        // Refresh the newest date in case TSETMC revised today's closing values.
        const newest = allData[allData.length - 1];
        await prisma.dailyPrice.upsert({
          where: { instrumentId_date: { instrumentId: instrument.id, date: newest.date } },
          create: newest,
          update: {
            open: newest.open, high: newest.high, low: newest.low,
            close: newest.close, last: newest.last, volume: newest.volume,
            value: newest.value, rawPayload: newest.rawPayload,
          },
        });

        await prisma.instrument.update({
          where: { id: instrument.id },
          data: {
            priceSyncStatus: 'SUCCESS',
            priceSyncLastSuccess: new Date(),
            priceSyncError: null,
            priceSyncRecordCount: await prisma.dailyPrice.count({ where: { instrumentId: instrument.id } }),
          },
        });

        completed++;
        log(`Completed ${instrument.symbol}: fetched=${rows.length}, new=${addedForInstrument}, elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${instrument.symbol}: ${message}`);
        await prisma.instrument.update({
          where: { id: instrument.id },
          data: { priceSyncStatus: 'FAILED', priceSyncError: message.slice(0, 4000) },
        }).catch((updateError) => log(`Could not save failure status for ${instrument.symbol}: ${String(updateError)}`));
        log(`FAILED ${instrument.symbol}: ${message}`);
      }
    }

    const status = failed === 0 ? 'SUCCESS' : completed > 0 ? 'PARTIAL' : 'FAILED';
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status, fetched, inserted, message: errors.length ? errors.slice(0, 30).join('\n') : null, finishedAt: new Date() },
    });

    const result = { mode, instruments: instruments.length, completed, fetched, inserted, failed, errors: errors.slice(0, 30) };
    log(`Price sync finished: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', fetched, inserted, message: error instanceof Error ? error.message : String(error), finishedAt: new Date() },
    });
    throw error;
  }
}


/**
 * Durable, database-backed price jobs.
 * Each invocation processes a small number of instruments so it fits
 * within a serverless function execution window.
 */
export async function startPriceJob(mode: 'backfill' | 'incremental') {
  const active = await prisma.syncRun.findFirst({
    where: { kind: { in: ['PRICES_BACKFILL_JOB', 'PRICES_INCREMENTAL_JOB'] }, status: 'RUNNING' },
    orderBy: { startedAt: 'asc' },
  });
  if (active) return { jobId: active.id, existing: true };

  const where: Prisma.InstrumentWhereInput = mode === 'backfill'
    ? { isActive: true, priceSyncStatus: { not: 'SUCCESS' } }
    : { isActive: true };

  const total = await prisma.instrument.count({ where });
  const run = await prisma.syncRun.create({
    data: {
      kind: `PRICES_${mode.toUpperCase()}_JOB`,
      status: total ? 'RUNNING' : 'SUCCESS',
      total,
      completed: 0,
      failedCount: 0,
      finishedAt: total ? null : new Date(),
      message: total ? null : 'No instruments require synchronization.',
    },
  });
  return { jobId: run.id, existing: false, total };
}

export async function processPriceJobBatch(runId: string, batchSize = 1) {
  const run = await prisma.syncRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Sync job not found.');
  if (run.status !== 'RUNNING') return getPriceJobStatus(runId);

  const mode: SyncMode = run.kind.includes('INCREMENTAL') ? 'incremental' : 'backfill';
  const where: Prisma.InstrumentWhereInput = {
    isActive: true,
    ...(run.cursorId ? { id: { gt: run.cursorId } } : {}),
    ...(mode === 'backfill' ? { priceSyncStatus: { not: 'SUCCESS' } } : {}),
  };

  // Cursor is based on the primary key to make each batch deterministic.
  const instruments = await prisma.instrument.findMany({
    where,
    orderBy: { id: 'asc' },
    take: Math.max(1, Math.min(batchSize, 30)),
  });

  if (!instruments.length) {
    const finalStatus = run.failedCount > 0 ? 'PARTIAL' : 'SUCCESS';
    await prisma.syncRun.update({
      where: { id: runId },
      data: { status: finalStatus, finishedAt: new Date() },
    });
    return getPriceJobStatus(runId);
  }

  let fetched = run.fetched;
  let inserted = run.inserted;
  let completed = run.completed;
  let failedCount = run.failedCount;
  let cursorId = run.cursorId;

  for (const instrument of instruments) {
    cursorId = instrument.id;
    const startedAt = Date.now();
    try {
      await prisma.instrument.update({
        where: { id: instrument.id },
        data: { priceSyncStatus: 'RUNNING', priceSyncLastAttempt: new Date(), priceSyncError: null },
      });

      const payload = await tsetmc.get<unknown>(
        `ClosingPrice/GetClosingPriceDailyList/${instrument.insCode}/0`
      );
      const rows = rowsOf(payload);
      if (!rows.length) throw new Error('TSETMC returned an empty history.');

      const records = new Map<string, {
        instrumentId: string; date: Date; open: bigint | null; high: bigint | null;
        low: bigint | null; close: bigint | null; last: bigint | null;
        volume: bigint | null; value: bigint | null; rawPayload: Prisma.InputJsonValue;
      }>();

      for (const row of rows) {
        const date = dateOf(row.dEven);
        if (!date) continue;
        records.set(date.toISOString(), {
          instrumentId: instrument.id, date,
          open: toBigInt(row.priceFirst), high: toBigInt(row.priceMax),
          low: toBigInt(row.priceMin), close: toBigInt(row.pClosing),
          last: toBigInt(row.pDrCotVal), volume: toBigInt(row.qTotTran5J),
          value: toBigInt(row.qTotCap),
          rawPayload: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
        });
      }
      const allData = [...records.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
      if (!allData.length) throw new Error('No valid dated records in TSETMC response.');

      fetched += rows.length;
      let data = allData;
      let latestDate: Date | null = null;
      if (mode === 'incremental') {
        const latest = await prisma.dailyPrice.findFirst({
          where: { instrumentId: instrument.id },
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        latestDate = latest?.date ?? null;
        if (latestDate) {
          // Recheck a 3-calendar-day overlap to repair recent revised records.
          const overlap = new Date(latestDate.getTime() - 3 * 86400000);
          data = allData.filter((r) => r.date >= overlap);
        }
      }

      let added = 0;
      if (mode === 'backfill' || !latestDate) {
        for (let i = 0; i < data.length; i += BATCH_SIZE) {
          const result = await createManyWithRetry(data.slice(i, i + BATCH_SIZE));
          added += result.count;
        }
      } else {
        for (const record of data) {
          const result = await prisma.dailyPrice.upsert({
            where: { instrumentId_date: { instrumentId: instrument.id, date: record.date } },
            create: record,
            update: {
              open: record.open, high: record.high, low: record.low,
              close: record.close, last: record.last, volume: record.volume,
              value: record.value, rawPayload: record.rawPayload,
            },
          });
          // Count only newly-created rows by checking whether it existed before is
          // intentionally avoided; inserted here means rows handled in this run.
          void result;
          added++;
        }
      }

      inserted += added;
      await prisma.instrument.update({
        where: { id: instrument.id },
        data: {
          priceSyncStatus: 'SUCCESS',
          priceSyncLastSuccess: new Date(),
          priceSyncError: null,
          priceSyncRecordCount: await prisma.dailyPrice.count({ where: { instrumentId: instrument.id } }),
        },
      });
      completed++;
      log(`Job ${runId}: ${instrument.symbol} completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch (error) {
      failedCount++;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.instrument.update({
        where: { id: instrument.id },
        data: { priceSyncStatus: 'FAILED', priceSyncError: message.slice(0, 4000) },
      }).catch(() => undefined);
      log(`Job ${runId}: ${instrument.symbol} failed: ${message}`);
    }
  }

  await prisma.syncRun.update({
    where: { id: runId },
    data: { cursorId, fetched, inserted, completed, failedCount },
  });

  // For backfill, the query excludes successful instruments; for incremental,
  // cursorId moves forward until all active instruments have been visited.
  const nextWhere: Prisma.InstrumentWhereInput = {
    isActive: true,
    id: { gt: cursorId! },
    ...(mode === 'backfill' ? { priceSyncStatus: { not: 'SUCCESS' } } : {}),
  };
  const remaining = await prisma.instrument.count({ where: nextWhere });
  if (remaining === 0) {
    await prisma.syncRun.update({
      where: { id: runId },
      data: {
        status: failedCount > 0 ? 'PARTIAL' : 'SUCCESS',
        finishedAt: new Date(),
        message: failedCount ? `${failedCount} instrument(s) failed. Failed symbols can be retried with a new backfill job.` : null,
      },
    });
  }
  return getPriceJobStatus(runId);
}

export async function getPriceJobStatus(runId: string) {
  const run = await prisma.syncRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Sync job not found.');
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    total: run.total,
    completed: run.completed,
    failed: run.failedCount,
    fetched: run.fetched,
    inserted: run.inserted,
    progress: run.total > 0 ? Math.min(100, Math.round((run.completed + run.failedCount) / run.total * 100)) : 100,
    message: run.message,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}
