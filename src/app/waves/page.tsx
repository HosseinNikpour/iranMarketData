
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { detectBullWaves } from '@/lib/analysis';

export const dynamic = 'force-dynamic';

export default async function Waves() {
  let points: { date: Date; value: number }[] = [];

  try {
    const idx = await prisma.marketIndex.findUnique({
      where: {
        symbol: 'TEDPIX',
      },
      include: {
        prices: {
          orderBy: {
            date: 'asc',
          },
        },
      },
    });

    points =
      idx?.prices.map((price) => ({
        date: price.date,
        value: Number(price.value),
      })) || [];
  } catch (error) {
    console.error('Waves analysis error:', error);
  }

  const waves = detectBullWaves(points, 10, 10);

  return (
    <main className="subpage">
      <Link href="/">← بازگشت</Link>

      <h1>تحلیل موج‌های صعودی</h1>

      <p>
        تشخیص با برگشت ۱۰٪ از سقف و حداقل ۱۰ روز تقویمی.
      </p>

      <div className="notice">
        سقف موج تنها پس از وقوع برگشت تأیید می‌شود.
        در بک‌تست باید تاریخ تأیید pivot رعایت شود تا
        سوگیری نگاه به آینده ایجاد نشود.
      </div>

      <div className="panel">
        <h2>
          {waves.length.toLocaleString('fa-IR')} موج تشخیص داده شد
        </h2>

        {waves.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>کف</th>
                <th>سقف</th>
                <th>قیمت کف</th>
                <th>قیمت سقف</th>
                <th>بازده</th>
              </tr>
            </thead>

            <tbody>
              {waves.map((wave, index) => (
                <tr key={index}>
                  <td>
                    {wave.startDate.toLocaleDateString('fa-IR')}
                  </td>
                  <td>
                    {wave.endDate.toLocaleDateString('fa-IR')}
                  </td>
                  <td>
                    {wave.startValue.toLocaleString('fa-IR')}
                  </td>
                  <td>
                    {wave.endValue.toLocaleString('fa-IR')}
                  </td>
                  <td>{wave.returnPct.toFixed(2)}٪</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>
            ابتدا تاریخچه شاخص را در جدول‌های MarketIndex
            و IndexDailyPrice وارد کنید.
            اتصال endpoint شاخص هنوز نیازمند تأیید و mapping زنده است.
          </p>
        )}
      </div>
    </main>
  );
}
