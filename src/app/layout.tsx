import type {Metadata} from 'next';import './globals.css';
export const metadata:Metadata={title:'Iran Market Analyzer',description:'تحلیل موج‌های بازار بورس ایران'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="fa" dir="rtl"><body>{children}</body></html>;}
