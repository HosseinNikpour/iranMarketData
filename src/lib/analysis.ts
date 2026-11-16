export type PricePoint = {date: Date; value: number};
export type BullWave = {startDate:Date; endDate:Date; startValue:number; endValue:number; returnPct:number; durationDays:number};
// A pivot is only known after the reversal threshold is crossed; do not backdate knowledge in backtests.
export function detectBullWaves(points:PricePoint[], reversalPct=10, minDays=10):BullWave[] {
 const p=[...points].filter(x=>x.value>0&&Number.isFinite(x.value)).sort((a,b)=>+a.date-+b.date);
 const out:BullWave[]=[]; if(p.length<3)return out;
 let low=p[0], high=p[0], mode:'rise'|'fall'='rise';
 for(let i=1;i<p.length;i++) { const x=p[i];
  if(mode==='rise') { if(x.value<low.value){low=x;high=x;} if(x.value>high.value)high=x;
   if(high.value>low.value&&(high.value-x.value)/high.value*100>=reversalPct){const days=Math.round((+high.date-+low.date)/86400000);if(days>=minDays)out.push({startDate:low.date,endDate:high.date,startValue:low.value,endValue:high.value,returnPct:(high.value/low.value-1)*100,durationDays:days});mode='fall';low=x;}
  } else {if(x.value<low.value)low=x;if((x.value/low.value-1)*100>=reversalPct){mode='rise';high=x;}}
 }
 return out;
}
export type StockRow={insCode:string;symbol:string;date:Date;close:number|null;adjustedClose:number|null};
export function rankStocks(waves:{startDate:Date;endDate:Date;indexReturnPct:number}[], rows:StockRow[]) {
 const grouped=new Map<string,StockRow[]>(); for(const r of rows){const a=grouped.get(r.insCode)||[];a.push(r);grouped.set(r.insCode,a);}
 return [...grouped.values()].map(series=>{series.sort((a,b)=>+a.date-+b.date);const excess:number[]=[],rets:number[]=[];
  for(const w of waves){const a=series.filter(x=>+x.date<=+w.startDate).at(-1),b=series.find(x=>+x.date>=+w.endDate);const av=a?.adjustedClose??a?.close,bv=b?.adjustedClose??b?.close;if(av&&bv&&av>0){const r=(bv/av-1)*100;rets.push(r);excess.push(r-w.indexReturnPct);}}
  const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  return {symbol:series[0].symbol,total:excess.length,wins:excess.filter(x=>x>0).length,avgReturn:avg(rets),avgExcess:avg(excess),worstExcess:excess.length?Math.min(...excess):0};
 }).filter(x=>x.total).sort((a,b)=>b.avgExcess-a.avgExcess);
}
