
import { prisma } from '../lib/prisma';
import { syncInstruments, syncPrices } from './sync';

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }

    if (arg === `--${name}`) {
      return args[i + 1];
    }
  }

  return undefined;
}

function getLimit(): number | undefined {
  const raw = getArg('limit');

  if (!raw) return undefined;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --limit value: ${raw}`);
  }

  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  const limit = getLimit();
  const insCode = getArg('insCode');
  const allowAll = args.includes('--all');

  console.log('[CLI] Arguments:', args.join(' '));
  console.log('[CLI] Command:', command);
  console.log('[CLI] Limit:', limit ?? 'not specified');

  if (command === 'instruments') {
    console.log(await syncInstruments());
    return;
  }

  if (command === 'prices') {
    if (!limit && !insCode && !allowAll) {
      throw new Error(
        'For safety, specify --limit=10, --insCode=... or --all.'
      );
    }

    console.log(
      await syncPrices({
        mode: 'backfill',
        limit,
        insCode,
      })
    );
    return;
  }

  if (command === 'prices:resume') {
    console.log(
      await syncPrices({
        mode: 'resume',
        limit,
        insCode,
      })
    );
    return;
  }

  if (command === 'prices:incremental') {
    console.log(
      await syncPrices({
        mode: 'incremental',
        limit,
        insCode,
      })
    );
    return;
  }

  if (command === 'all') {
    if (!allowAll) {
      throw new Error('For full market sync, add --all explicitly.');
    }

    console.log('Instruments:', await syncInstruments());

    console.log(
      'Prices:',
      await syncPrices({ mode: 'backfill' })
    );
    return;
  }

  console.log(`
Commands:

  Test 10 instruments:
  npm run sync:prices -- --limit=10

  Sync one instrument:
  npm run sync:prices -- --insCode=17617474823279712

  Full market history:
  npm run sync:prices -- --all

  Resume:
  npm run sync:prices:resume

  Incremental:
  npm run sync:prices:incremental
`);
}

main()
  .catch((error) => {
    console.error('[CLI ERROR]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
