
const base = (
  process.env.TSETMC_BASE_URL || 'https://cdn.tsetmc.com/api'
).replace(/\/$/, '');

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TsetmcClient {
  private last = 0;

  async get<T>(path: string): Promise<T> {
    const delay = Number(
      process.env.TSETMC_REQUEST_DELAY_MS || 900
    );

    const wait = Math.max(
      0,
      delay - (Date.now() - this.last)
    );

    if (wait) await sleep(wait);

    let error: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `${base}/${path.replace(/^\//, '')}`;

        const response = await fetch(url, {
          headers: {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 IranMarketAnalyzer',
            referer: 'https://www.tsetmc.com/',
          },
          signal: AbortSignal.timeout(20000),
          cache: 'no-store',
        });

        this.last = Date.now();

        if (!response.ok) {
          throw new Error(
            `TSETMC HTTP ${response.status}: ${path}`
          );
        }

        const text = await response.text();

        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(
            `TSETMC returned invalid JSON for ${path}: ${text.slice(0, 1000)}`
          );
        }
      } catch (e) {
        error = e;

        if (attempt < 3) {
          await sleep(attempt * 1200);
        }
      }
    }

    throw error instanceof Error
      ? error
      : new Error('TSETMC request failed');
  }
}

export const tsetmc = new TsetmcClient();
