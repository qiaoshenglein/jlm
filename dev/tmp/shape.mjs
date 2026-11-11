// 临时测量脚本：把各候选源的原始返回按字段打出来，供解析器定索引（用完即删）
const gbk = (b) => new TextDecoder('gbk').decode(b);
const utf = (b) => new TextDecoder('utf-8').decode(b);
const get = async (u, dec = utf, h = {}) => {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', ...h }, signal: AbortSignal.timeout(8000) });
  return dec(await r.arrayBuffer());
};
const sinaH = { referer: 'https://finance.sina.com.cn' };

const tx = await get('https://qt.gtimg.cn/q=usAAPL,sh600519', gbk);
for (const line of tx.split(';').filter(Boolean)) {
  const f = line.split('=')[1]?.replace(/^"|"$/g, '').split('~');
  console.log(line.split('=')[0].replace('v_', ''), '字段数', f.length);
  f.forEach((v, i) => console.log('   [' + i + ']', String(v).slice(0, 24)));
}
console.log('\n== 新浪快照（可能 403，重试三次）');
for (let i = 0; i < 3; i++) {
  try {
    const s = await get('https://hq.sinajs.cn/list=sh600519,gb_aapl', gbk, sinaH);
    console.log(s.slice(0, 400));
    s.split('\n').filter(Boolean)[0]?.split('=')[1].replace(/"|"$/g, '').split(',').forEach((v, j) => console.log('   [' + j + ']', v.slice(0, 22)));
    break;
  } catch (e) { console.log('  第', i + 1, '次失败', e.message); await new Promise((r) => setTimeout(r, 1200)); }
}
console.log('\n== 腾讯 A股榜字段');
const tr = JSON.parse(await get('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=turnover&direct=down&offset=0&count=2', utf));
console.log(JSON.stringify(tr.data?.rank_list?.[0], null, 1).slice(0, 900));
console.log('\n== 新浪 A股榜字段');
const sr = await get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=2&sort=amount&asc=0&node=hs_a', utf, sinaH);
console.log(sr.slice(0, 700));
console.log('\n== 腾讯分时 keys');
const tm = JSON.parse(await get('https://ifzq.gtimg.cn/appstock/app/minute/query?code=sh600519', utf));
const one = tm.data?.sh600519 ?? {};
console.log('keys:', Object.keys(one), '| data keys:', Object.keys(one.data ?? {}), '| 首行:', one.data?.data?.[0], '| 行数:', one.data?.data?.length);
console.log(JSON.stringify(one.data?.date ?? null), JSON.stringify(one.data?.preclose ?? null), JSON.stringify(one.qt?.sh600519?.[30] ?? null));
console.log('\n== 新浪日K字段');
const sk = await get('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=2', utf, sinaH);
console.log(sk.slice(0, 300));
