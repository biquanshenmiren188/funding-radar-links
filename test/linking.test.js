const test = require("node:test");
const assert = require("node:assert/strict");
const { readCard, makeRadarUrl, normalizeSymbol } = require("../linking.js");
const { readBorrowCard } = require("../linking.js");

test('borrow shortcut uses native FS spot venue, never GC or FF/SF',()=>{
  for(const exchange of ['binance','bitget']) {
    const details=readBorrowCard(card('🟩RLC',['gold','green'],['unknown',exchange]));
    assert.equal(details.exchange,exchange);
    assert.equal(details.symbol,'RLC');
    assert.equal(readBorrowCard(card('RLC',['gold','green'],['binance','gc-'+exchange])),null);
    assert.equal(readBorrowCard(card('RLC',['gold','gold'],['binance',exchange])),null);
    assert.equal(readBorrowCard(card('RLC',['green','gold'],['binance',exchange])),null);
  }
  assert.equal(readBorrowCard(card('RLC',['gold','green'],['binance','gate'])),null);
});

function card(symbol, colors, exchanges = ["aster", "binance"]) {
  const nameElement = { textContent: symbol };
  const tags = colors.map((color, index) => ({
    textContent: exchanges[index],
    classList: { contains: name => name === `ant-tag-${color}` }
  }));
  const row = {
    textContent: `交易所: ${exchanges.join(" ")}`,
    querySelectorAll: selector => selector === ".ant-tag" ? tags : []
  };
  return {
    querySelector: selector => selector === ".ant-card-head .pair-name-link" ? nameElement : null,
    querySelectorAll: selector => selector === "p" ? [row] : []
  };
}

test("reads each leg in its displayed order", () => {
  for (const [colors, expected] of [
    [["gold", "gold"], "FF"],
    [["gold", "green"], "FS"],
    [["green", "gold"], "SF"]
  ]) {
    const details = readCard(card("Q", colors));
    assert.equal(details.mode, expected);
    assert.deepEqual(details.exchanges, ["aster", "binance"]);
  }
});

test("constructs the requested radar URL", () => {
  const url = makeRadarUrl(readCard(card("Q", ["gold", "gold"])));
  assert.equal(url, "https://47.79.37.237/radar/?tab=FF&mode=FF&q=Q&combo=FF.Q.aster.binance");
});

test("uses a configured Radar site while keeping the /radar/ path", () => {
  const url = makeRadarUrl(readCard(card("Q", ["gold", "green"])), "https://radar.example.com/other/path");
  assert.equal(url, "https://radar.example.com/radar/?tab=FS&mode=FS&q=Q&combo=FS.Q.aster.binance");
});

test("removes a decorative emoji and safely encodes symbols", () => {
  assert.equal(normalizeSymbol("🟪 SKHY-SKHYNIX"), "SKHY-SKHYNIX");
  const url = new URL(makeRadarUrl(readCard(card("龙虾", ["green", "gold"]))));
  assert.equal(url.searchParams.get("q"), "龙虾");
  assert.equal(url.searchParams.get("combo"), "SF.龙虾.aster.binance");
});

test("skips cards with unknown market types", () => {
  assert.equal(readCard(card("Q", ["blue", "gold"])), null);
});

test("ignores non-exchange badges after the two market tags", () => {
  const details = readCard(card("🟩SAGA", ["gold", "green", "blue"], ["gate", "binance", "全"]));
  assert.equal(details.symbol, "SAGA");
  assert.equal(details.mode, "FS");
  assert.deepEqual(details.exchanges, ["gate", "binance"]);
});

test("maps every supported GC venue and HL alias without reversing legs", () => {
  const aliases = {"gc-binance":"binance", "gc-bybit":"bybit", "gc-gate":"gate", "gc-okx":"okx", "gc-hl":"hyperliquid", hl:"hyperliquid"};
  for (const [left, expectedLeft] of Object.entries(aliases)) for (const [right, expectedRight] of Object.entries(aliases)) {
    for (const [colors, mode] of [[["gold","gold"],"FF"], [["green","gold"],"SF"], [["gold","green"],"FS"]]) {
      const details = readCard(card("MUBARAK", colors, [left,right]));
      assert.deepEqual(details.exchanges, [expectedLeft,expectedRight]);
      const url = new URL(makeRadarUrl(details, "https://radar.example.com"));
      assert.equal(url.searchParams.get("combo"), `${mode}.MUBARAK.${expectedLeft}.${expectedRight}`);
      assert.equal(url.searchParams.get("mode"), mode);
    }
  }
});

test("rejects unverified venues instead of generating a silently wrong radar link", () => {
  for (const venue of ["gc-aster", "gc-unknown", "unknown", "gc-gc-gate", "gc-hyperliquid"]) {
    assert.equal(readCard(card("Q", ["gold","gold"], [venue,"gate"])), null);
    assert.throws(() => makeRadarUrl({symbol:"Q",mode:"FF",exchanges:[venue,"gate"]}), /Unsupported/);
  }
});

test("normalizes direct caller aliases, casing and whitespace and preserves native identity", () => {
  const url = new URL(makeRadarUrl({symbol:"1000RATS",mode:"FF",exchanges:[" GC-BINANCE "," HL "]},"https://radar.example.com"));
  assert.equal(url.searchParams.get("combo"), "FF.1000RATS.binance.hyperliquid");
  assert.equal(url.searchParams.get("q"), "1000RATS");
});

const {readLimitCard}=require('../linking.js');
test('limit lookup is available for either HL perpetual leg including GC, once per card',()=>{
 for(const venue of ['hl','gc-hl','hyperliquid'])for(const side of [0,1]) {
   const venues=['binance','gate'];venues[side]=venue;
   const details=readLimitCard(card('W',['gold','gold'],venues));
   assert.equal(details.symbol,'W');
   assert.equal(details.hlTags.length,1);
 }
 assert.equal(readLimitCard(card('BTC',['gold','gold'],['hl','gc-hl'])).symbol,'BTC');
});
test('spot HL and unrelated cards have no public perpetual limit shortcut',()=>{
 assert.equal(readLimitCard(card('W',['gold','green'],['gate','hl'])),null);
 assert.equal(readLimitCard(card('W',['green','gold'],['gc-hl','binance'])),null);
 assert.equal(readLimitCard(card('W',['gold','gold'],['binance','gate'])),null);
 assert.equal(readLimitCard(card('',['gold','gold'],['hl','gate'])),null);
});
test('HL lookup does not depend on the other exchange being supported by radar',()=>{
 assert.equal(readLimitCard(card('W',['gold','gold'],['unknown','hl'])).symbol,'W');
});
test('HL query keeps exact coin names and rejects overlong identity',()=>{
 for(const symbol of ['1000RATS','xyz:BTC','BTC/USDC','龙虾','X&coin=W']) {
  assert.equal(readLimitCard(card(symbol,['gold','gold'],['gc-hl','gate'])).symbol,symbol);
 }
 assert.equal(readLimitCard(card('X'.repeat(61),['gold','gold'],['hl','gate'])),null);
});
