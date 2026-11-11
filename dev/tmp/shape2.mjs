// 临时测量脚本（第二阶段）：新浪快照/两家的榜/腾讯分时/新浪日K（用完即删）
const gbk = (b) => new TextDecoder('gbk').decode(b);
const utf = (b) => new TextDecoder('utf-8').decode(b);
const get = async (u, dec = utf, h = {}) => {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', ...h }, signal: AbortSignal.timeout(8000) });
  return dec(await r.arrayBuffer());
};
const sinaH = { referer: 'https://finance.sina.com.cn/' };

console.log('== 新浪快照');
for (let i = 0; i < 4; i++) {
  try {
    const s = await get('https://hq.sinajs.cn/list=sh600519,sz399006,sh510300,gb_aapl', gbk, sinaH);
    for (const line of s.split('\n').map((x) => x.trim()).filter((x) => x.includes('='))) {
      const body = line.split('=')[1].replace(/^"|"(;?)$/g, '').split(',');
      console.log(line.split('=')[0].replace('var hq_str_', ''), '字段数', body.length);
      if (line.includes('sh600519')) body.forEach((v, j) => console.log('   [' + j + ']', v.slice(0, 22)));
      if (line.includes('gb_aapl')) body.forEach((v, j) => console.log('  US[' + j + ']', v.slice(0, 22)));
    }
    break;
  } catch (e) { console.log('  第', i + 1, '次失败', e.cause?.code || e.message); await new Promise((r) => setTimeout(r, 1500)); }
}

console.log('\n== 腾讯 A股榜一条');
const tr = JSON.parse(await get('https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=turnover&direct=down&offset=0&count=2'));
console.log(JSON.stringify(tr.data?.rank_list?.[0]));
console.log('total', tr.data?.total, '| keys', Object.keys(tr.data ?? {}));

console.log('\n== 新浪 A股榜一条');
const sr = await get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=2&sort=amount&asc=0&node=hs_a', utf, sinaH);
console.log(sr.slice(0, 600));

console.log('\n== 腾讯分时结构');
const tm = JSON.parse(await get('https://ifzq.gtimg.cn/appstock/app/minute/query?code=sh600519'));
const node = tm.data?.sh600519 ?? {};
console.log('node keys:', Object.keys(node), '| data keys:', Object.keys(node.data ?? {}));
console.log('date', node.data?.date, '| preClose', node.data?.preClose ?? node.data?.preclose, '| 首行', node.data?.data?.[0], '| 行数', node.data?.data?.length);
console.log('qt[30]', node.qt?.sh600519?.[30], '| info', JSON.stringify(node.info ?? null).slice(0, 120));

console.log('\n== 腾讯美股分时');
const tu = JSON.parse(await get('https://ifzq.gtimg.cn/appstock/app/minute/query?code=usAAPL.OQ'));
const un = tu.data?.['usAAPL.OQ'] ?? {};
console.log('keys', Object.keys(un), '| date', un.data?.date, '| 首行', un.data?.data?.[0], '| 行数', un.data?.data?.length);

console.log('\n== 新浪日K');
console.log((await get('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=2', utf, sinaH)).slice(0, 320));
