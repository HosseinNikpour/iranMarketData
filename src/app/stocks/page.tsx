
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { rankStocks } from '@/lib/analysis';

export const dynamic = 'force-dynamic';

export default async function Stocks() {
  let result: ReturnType<typeof rankStocks> = [];

  try {
    const [waves, instruments] = await Promise.all([
      prisma.wave.findMany({
        orderBy: { startDate: 'asc' },
      }),

      prisma.instrument.findMany({
        where: { isActive: true },
        include: {
          prices: {
            orderBy: { date: 'asc' },
          },
        },
      }),
    ]);

    // تبدیل نام فیلد بازده موج به نام مورد انتظار تابع رتبه‌بندی
    const rankingWaves = waves.map((wave) => ({
      startDate: wave.startDate,
      endDate: wave.endDate,
      indexReturnPct: wave.returnPct,
    }));

   const stockPrices = instruments.flatMap((instrument) =>
  instrument.prices
    .filter((price) => price.close !== null)
    .map((price) => ({
      insCode: instrument.insCode,
      symbol: instrument.symbol,
      date: price.date,
      close: price.close === null ? null : Number(price.close),
      adjustedClose:
        price.adjustedClose === null
          ? null
          : Number(price.adjustedClose),
    }))
);

    result = rankStocks(rankingWaves, stockPrices);
  } catch (error) {
    console.error('Stocks ranking error:', error);
  }

  return (
    <main className="subpage">
      <Link href="/">← بازگشت</Link>

      <h1>رتبه‌بندی سهام</h1>

      <p>
        مقایسه بازده هر نماد با شاخص در موج‌های ذخیره‌شده.
      </p>

      <div className="notice">
        قیمت تعدیل‌شده در اولویت است؛ در نبود آن قیمت خام
        استفاده می‌شود. فیلد adjustedClose فعلاً توسط
        همگام‌ساز پر نمی‌شود.
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>نماد</th>
              <th>تعداد موج</th>
              <th>نرخ برتری</th>
              <th>میانگین بازده</th>
              <th>برتری میانگین</th>
              <th>بدترین برتری</th>
            </tr>
          </thead>

          <tbody>
            {result.map((row, index) => (
              <tr key={index}>
                <td>{row.symbol}</td>
                <td>{row.total}</td>
                <td>
                  {(100 * row.wins / row.total).toFixed(1)}٪
                </td>
                <td>{row.avgReturn.toFixed(2)}٪</td>
                <td>{row.avgExcess.toFixed(2)}٪</td>
                <td>{row.worstExcess.toFixed(2)}٪</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!result.length && (
          <p>
            برای رتبه‌بندی، ابتدا موج‌ها را در جدول Wave
            ذخیره و قیمت نمادها را دریافت کنید.
          </p>
        )}
      </div>
    </main>
  );
}
