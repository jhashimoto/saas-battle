import { useState, useEffect, useRef } from "react";
import { useRoom, GAME_VERSION, TUTORIAL_KEY, clearRoomStorage } from "./useRoom.js";
import { lineProfile } from "./liff.js";

// ============================================================
// DESIGN PHILOSOPHY
// 毎Q「予算をどう配分するか」を決める → 何かを増やすと何かが足りなくなる
// パラメータは毎Q自然劣化 → 維持するだけでもコストがかかる
// 市場フェーズ（黎明期→急成長→成熟）でルールが変わる
// ============================================================

const MARKETS = {
  food:   { id:"food",   name:"飲食 モバイルオーダー", icon:"🍜", color:"#FF6B35",
            arpu:80,  totalStores:800, varCostPerStore:0.5, cogsPerStore:14, entryDiff:1,
            priceSensitivity:0.60,
            desc:"参入しやすく競合が激しい。シェアを早く取れるかが勝負。" },
  retail: { id:"retail", name:"小売店 会員証",        icon:"🏪", color:"#06B6D4",
            arpu:140, totalStores:400, varCostPerStore:0.8, cogsPerStore:25, entryDiff:3,
            priceSensitivity:0.50,
            desc:"導入ハードルが高い。大手獲得で一気に優位に立てる。" },
  beauty: { id:"beauty", name:"美容室 予約サービス",  icon:"✂️", color:"#A855F7",
            arpu:200, totalStores:300, varCostPerStore:1.2, cogsPerStore:35, entryDiff:2,
            priceSensitivity:0.75,
            desc:"競合が少なくARPUが高い。品質で差をつけるか価格で攻めるか。" },
};

// 市場フェーズ：1〜4Q=黎明期、5〜8Q=急成長、9〜12Q=成熟
function getPhase(q) {
  if (q <= 4)  return { id:"dawn",   name:"黎明期", icon:"🌅", color:"#E3B341",
    desc:"市場が形成中。先行者優位を取れるかが鍵。",
    penetrationBase: 0.15, growthBonus: 1.5, stealMultiplier: 1.0 };
  if (q <= 8)  return { id:"growth", name:"急成長", icon:"🚀", color:"#3FB950",
    desc:"市場が急拡大。投資を積極化しないとシェアを失う。",
    penetrationBase: 0.55, growthBonus: 2.0, stealMultiplier: 2.0 };
  return       { id:"mature", name:"成熟期", icon:"🏁", color:"#D2A8FF",
    desc:"未獲得市場が縮小。競合からの奪取が主戦場になる。",
    penetrationBase: 0.85, growthBonus: 0.5, stealMultiplier: 4.0 };
}

// 市場浸透率（フェーズ連動）
function marketPenetration(q) {
  return 1 / (1 + Math.exp(-0.5 * (q - 6)));
}

const PLAYER_TYPES = {
  vendor: {
    id:"vendor", name:"既存SaaSベンダー", icon:"🏢",
    desc:"営業網と資金力が強み。ただし組織が重く固定費が高い。",
    bs:  { cash:2000, softwareAsset:0, otherAsset:500, debt:0, capital:2500, retainedEarnings:0, loanSchedule:[] },
    ops: { solutionQuality:40, salesPower:60, brandAwareness:55, supportQuality:50, stores:0, setPrice:0, priceMultiplier:1.0, pendingInvestment:{} },
    investRatio: 0.10, baseOpex: 200, investEfficiency: 1.0,
  },
  startup: {
    id:"startup", name:"スタートアップ", icon:"🚀",
    desc:"少ない予算でも投資効率1.8倍。集中投資で特定パラメータを一気に伸ばせる。",
    bs:  { cash:400, softwareAsset:0, otherAsset:50, debt:0, capital:450, retainedEarnings:0, loanSchedule:[] },
    ops: { solutionQuality:55, salesPower:20, brandAwareness:20, supportQuality:35, stores:0, setPrice:0, priceMultiplier:1.0, pendingInvestment:{} },
    investRatio: 0.12, baseOpex: 40, investEfficiency: 1.8,
  },
};

function calcInvestCapacity(bs, playerType, lastNetIncome) {
  const pt = PLAYER_TYPES[playerType];
  if (!pt) return 0;
  const safetyBuffer = pt.baseOpex * 2;
  const freeCash = Math.max(0, bs.cash - safetyBuffer);
  const fromCash = Math.floor(freeCash * pt.investRatio);
  const fromFCF  = lastNetIncome > 0 ? Math.floor(lastNetIncome * 0.3) : 0;
  return fromCash + fromFCF;
}

// ============================================================
// ④ プレイ履歴：localStorageに過去のプレイ結果を保存し、振り返れるようにする
// ============================================================
const PLAY_HISTORY_KEY = "saas_battle_play_history_v1";
const PLAY_HISTORY_MAX = 20; // 直近20件まで保持

function loadPlayHistory() {
  try {
    const raw = localStorage.getItem(PLAY_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function savePlayRecord(record) {
  try {
    const list = loadPlayHistory();
    list.unshift(record); // 新しい順
    const trimmed = list.slice(0, PLAY_HISTORY_MAX);
    localStorage.setItem(PLAY_HISTORY_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch { return []; }
}

const NPC_PROFILES = [
  { id:"npc1", name:"グローバルウェア", type:"vendor",  icon:"🏢", color:"#EF4444", strategy:"sales_heavy" },
  { id:"npc2", name:"ネクストビット",   type:"startup", icon:"⚡", color:"#10B981", strategy:"dev_heavy"   },
];

// ============================================================
// 予算配分モデル
// basePer100: 100万投資あたりの最大効果（現在値=0の時）
// 現在値が上がるほど効果が逓減（逓減カーブ: 1 - currentVal/150）
// → 値が高いほど同じ投資でも伸びにくくなる。維持も難しくなる。
// ============================================================
const BUDGET_ITEMS = [
  { id:"sales",    name:"営業強化",       icon:"👥", color:"#06B6D4",
    param:"salesPower",      basePer100:0.8, decay:0.8, capitalize:false,
    desc:"salesPower上昇（逓減あり）。未投資で毎Q-0.8。" },
  { id:"dev",      name:"プロダクト開発", icon:"⚙️", color:"#A855F7",
    param:"solutionQuality", basePer100:0.8, decay:0.6, capitalize:true,
    desc:"solutionQuality上昇（逓減あり）。未投資で毎Q-0.6。資産計上。" },
  { id:"marketing",name:"マーケ",         icon:"📢", color:"#E3B341",
    param:"brandAwareness",  basePer100:1.0, decay:1.0, capitalize:false, immediate:true,
    desc:"brandAwareness上昇（逓減あり）。即時反映。未投資で毎Q-1.0。" },
  { id:"cs",       name:"CS・サポート",   icon:"🎧", color:"#FFA657",
    param:"supportQuality",  basePer100:0.9, decay:0.8, capitalize:false,
    desc:"supportQuality上昇（逓減あり）。未投資で毎Q-0.8。" },
];

// ============================================================
// ★ 機能投資のミスマッチリスク：devへの投資は「顧客価値の方向性」を選ぶ
// 市場の顧客ニーズは見えないまま緩やかに変動し、選択と一致すればボーナス、外れれば減衰
// ============================================================
const DEV_FOCUS_TYPES = {
  efficiency: { id:"efficiency", name:"業務効率化",   icon:"⏱️", desc:"時間・手間を減らす機能。既存顧客の継続利用に効く。" },
  uiux:       { id:"uiux",       name:"UI/UX向上",   icon:"✨", desc:"使い心地・見た目の良さ。新規顧客の指名買いに効く。" },
  reliability:{ id:"reliability",name:"信頼性機能",   icon:"🛡️", desc:"セキュリティ・安定性・サポート体制。高単価顧客の維持に効く。" },
};
const DEV_FOCUS_KEYS = Object.keys(DEV_FOCUS_TYPES);
const DEV_MATCH_BONUS = 1.3;   // 市場ニーズと一致した場合の効果倍率
const DEV_MISMATCH_PENALTY = 0.8; // 不一致だった場合の効果倍率

// 市場の顧客ニーズを更新する（Qごとに緩やかに変動：70%維持・30%でランダムシフト）
function evolveMarketNeed(currentNeed) {
  if (!currentNeed) return DEV_FOCUS_KEYS[Math.floor(Math.random() * DEV_FOCUS_KEYS.length)];
  if (Math.random() < 0.3) {
    const others = DEV_FOCUS_KEYS.filter(k => k !== currentNeed);
    return others[Math.floor(Math.random() * others.length)];
  }
  return currentNeed;
}

// パラメータ上限を150に引き上げ（カンストしにくくし、高値追求に意味を持たせる）
const PARAM_MAX = 150;

// 逓減カーブ付き投資効果（上限150基準）
function calcParamGain(currentVal, basePer100, invested, efficiency) {
  const diminish = Math.max(0, 1 - currentVal / (PARAM_MAX * 1.5));
  return Math.floor(basePer100 * diminish * invested / 100 * efficiency);
}

// 特別アクション（予算配分とは別に1Qに1枚選択可能。コストは予算から引く）
const SPECIAL_ACTIONS = {
  chain_deal:   { id:"chain_deal",  icon:"🏬", name:"大手チェーン契約",  cost:500,
    desc:"即時+25店。一気にシェアを取りに行く大型営業。1回限り。", storeBonus:25, cat:"sales", oneTime:true },
  line_collab:  { id:"line_collab", icon:"🔗", name:"LINE公式連携強化",  cost:400,
    desc:"solutionQuality+30。競合との決定的な差別化に。資産計上。",
    effects:{solutionQuality:30}, capitalize:true, cat:"dev" },
  pr_push:      { id:"pr_push",     icon:"📰", name:"メディアPR",        cost:300,
    desc:"brandAwareness+40。大型PR投資で一時的な知名度急上昇。", effects:{brandAwareness:40}, cat:"marketing" },
  price_campaign:{ id:"price_campaign", icon:"🎁", name:"導入キャンペーン", cost:200,
    desc:"setPrice-10%。一時値下げで新規獲得を加速。", priceDiscount:0.10, cat:"price" },
  fund_seed:    { id:"fund_seed",    icon:"🌱", name:"シード調達",      cost:0,
    desc:"黎明期限定。資本金+500万。1回限り。ARRの約3ヶ月分。", cashGain:500, capitalGain:500, startupOnly:true, oneTime:true, cat:"funding", phase:"dawn" },
  fund_series_a:{ id:"fund_series_a",icon:"💰", name:"シリーズA調達",  cost:0,
    desc:"急成長期限定。資本金+3000万。1回限り。ARRの約6ヶ月分。", cashGain:3000, capitalGain:3000, startupOnly:true, oneTime:true, cat:"funding", phase:"growth" },
  fund_series_b:{ id:"fund_series_b",icon:"🚀", name:"シリーズB調達",  cost:0,
    desc:"成熟期限定。資本金+8000万。1回限り。ARRの約12ヶ月分。", cashGain:8000, capitalGain:8000, startupOnly:true, oneTime:true, cat:"funding", phase:"mature" },
  debt_repay:   { id:"debt_repay",   icon:"💸", name:"借入一括返済",    cost:0,
    desc:"借入を全額返済。利息負担から解放。", fullRepay:true, cat:"funding" },
};

// ============================================================
// RANDOM EVENTS（20種）
// type: "auto" = 自動適用, "choice" = プレイヤー選択
// ============================================================
const RANDOM_EVENTS = [
  // --- 市場拡大 ---
  { id:"chain_adoption",   icon:"🏗️", name:"大手チェーンがLINE導入を決定", prob:0.06, cat:"market",
    desc:"業界の追い風。市場総店舗数が一時的に+150店拡大。",
    type:"auto", marketBoost:150 },
  { id:"mall_opening",     icon:"🏬", name:"大型モール開業ラッシュ",        prob:0.05, cat:"market",
    desc:"小売・飲食の潜在顧客が急増。市場+100店。",
    type:"auto", marketBoost:100 },
  { id:"dx_subsidy",       icon:"🏛️", name:"デジタル化補助金が可決",        prob:0.05, cat:"market",
    desc:"政府補助で導入障壁が低下。全社の新規獲得+30%ボーナス（1Q）。",
    type:"auto", acquisitionBonus:0.3 },

  // --- 競合ショック ---
  { id:"rival_bankrupt",   icon:"💀", name:"競合が資金枯渇",                prob:0.06, cat:"rival",
    desc:"競合1社の店舗が40%流出。シェア奪取のチャンス。",
    type:"auto", npcDamage:{ stores:0.4 } },
  { id:"rival_ma",         icon:"🤝", name:"競合が大手にM&A",               prob:0.05, cat:"rival",
    desc:"競合1社が大手資本を獲得。全パラメータ+15の強敵に。",
    type:"auto", npcBoostTarget:{ allParams:15 } },
  { id:"rival_scandal",    icon:"💥", name:"競合がスキャンダル",             prob:0.07, cat:"rival",
    desc:"競合1社のブランド-40。店舗の一部が流出してくる可能性。",
    type:"auto", npcDamage:{ brandAwareness:40 } },

  // --- 自社チャンス ---
  { id:"viral_mention",    icon:"🔥", name:"著名人がSNSで紹介",             prob:0.06, cat:"chance",
    desc:"一時的にブランド認知が急上昇。+40（次Qで半減）。",
    type:"auto", opsBoost:{ brandAwareness:40 } },
  { id:"engineer_join",    icon:"👨‍💻", name:"優秀エンジニア獲得",            prob:0.06, cat:"chance",
    desc:"即戦力採用成功。solutionQuality+20。",
    type:"auto", opsBoost:{ solutionQuality:20 } },
  { id:"line_staff_join",  icon:"🌟", name:"元LINE社員が転職入社",           prob:0.05, cat:"chance",
    desc:"社内知見が一気に強化。営業力+15、品質+10。",
    type:"auto", opsBoost:{ salesPower:15, solutionQuality:10 } },

  // --- 自社リスク ---
  { id:"key_resign",       icon:"😱", name:"キーパーソンが離職",             prob:0.07, cat:"risk",
    desc:"中核人材が突然退職。ランダムなパラメータが-20。",
    type:"auto", opsRisk:{ randomParam:-20 } },
  { id:"security_breach",  icon:"🔓", name:"セキュリティ事故",               prob:0.05, cat:"risk",
    desc:"情報漏洩発覚。店舗-15%、CS品質-15、ブランド-20。",
    type:"auto", opsRisk:{ storeRatio:-0.15, supportQuality:-15, brandAwareness:-20 } },
  { id:"server_down",      icon:"💻", name:"サーバー大規模障害",             prob:0.06, cat:"risk",
    desc:"サービス停止。今Q売上-30%、解約率が一時悪化。",
    type:"auto", revenueShock:-0.30 },

  // --- LINEプラットフォーム ---
  { id:"line_new_feature", icon:"📱", name:"LINE新機能リリース",             prob:0.07, cat:"platform",
    desc:"品質が高い社ほど恩恵大。solutionQuality上位社に+15ボーナス。",
    type:"auto", lineFeatureBonus:true },
  { id:"line_spec_change", icon:"🔧", name:"LINE仕様変更（厳格化）",         prob:0.07, cat:"platform",
    desc:"全社に開発対応コストが発生。品質が低いほど打撃大。",
    type:"auto", bsEffect:(bs,ops)=>({...bs, cash:bs.cash-Math.max(30,Math.floor((100-ops.solutionQuality)*0.8))}) },
  { id:"line_partner",     icon:"🏆", name:"LINEパートナー認定制度開始",     prob:0.04, cat:"platform",
    desc:"品質スコア最高社が認定取得。競合奪取率+50%（1Q）。",
    type:"auto", partnerBonus:true },

  // --- マクロ環境 ---
  { id:"recession",        icon:"📉", name:"景気後退",                       prob:0.05, cat:"macro",
    desc:"消費低迷。全社の売上-20%、2Q継続。",
    type:"auto", revenueShock:-0.20, duration:2 },
  { id:"dx_boom",          icon:"🚀", name:"DXブーム",                       prob:0.05, cat:"macro",
    desc:"社会全体のデジタル化加速。全社の投資上限+200万/Q（2Q）。",
    type:"auto", investBonus:200, duration:2 },

  // --- 選択型 ---
  { id:"acquisition_offer",icon:"💰", name:"大手からの買収オファー",         prob:0.03, cat:"choice",
    desc:"大手IT企業から買収提案。資金力を得るか、独立を貫くか。",
    type:"choice",
    choices:[
      { label:"条件付きで受け入れる（資本提携）", icon:"🤝",
        desc:"資本金+3000万、ブランド+20。ただし投資家対応で固定費+50万/Q永続。",
        capitalGain:3000, cashGain:3000, opsBoost:{ brandAwareness:20 }, permanentOpex:50 },
      { label:"断って独立継続", icon:"💪",
        desc:"「独立宣言」で顧客・採用の支持が高まる。ブランド+30、品質+10。",
        opsBoost:{ brandAwareness:30, solutionQuality:10 } },
    ]},
  { id:"partnership_offer",icon:"🤝", name:"大手流通との業務提携オファー",  prob:0.05, cat:"choice",
    desc:"大手流通チェーンから提携打診。即効性はあるがコストも大きい。",
    type:"choice",
    choices:[
      { label:"提携する",  icon:"🏬",
        desc:"即時+50店を獲得。ただし毎Q運営コスト+100万増加。",
        storeBonus:50, permanentOpex:100 },
      { label:"断る",      icon:"🚫",
        desc:"独自路線を維持。変化なし。",
        effect:"none" },
    ]},
  { id:"talent_war",       icon:"⚔️", name:"エンジニア引き抜き合戦",        prob:0.05, cat:"choice",
    desc:"競合が自社エンジニアを引き抜こうとしている。どう対処する？",
    type:"choice",
    choices:[
      { label:"給与大幅引き上げ", icon:"💸",
        desc:"現預金-200万で人材確保。品質・CS維持。",
        bsCost:200 },
      { label:"引き抜きを許容",   icon:"😔",
        desc:"コストゼロだが品質-15、CS-10の痛手。",
        opsRisk:{ solutionQuality:-15, supportQuality:-10 } },
    ]},
];

const SW_DEP_RATE   = 0.10;
const INTEREST_RATE = 0.05;
const MAX_QUARTERS  = 12;

// ============================================================
// ACCOUNTING
// ============================================================
function totalAssets(bs)      { return bs.cash + bs.softwareAsset + bs.otherAsset; }
function totalLiabilities(bs) { return bs.debt; }
function equity(bs)           { return bs.capital + bs.retainedEarnings; }
function roe(bs) {
  const eq = equity(bs);
  return eq > 0 ? (bs.retainedEarnings / eq * 100).toFixed(1) : "—";
}
function debtRatio(bs) {
  const ta = totalAssets(bs);
  return ta > 0 ? (totalLiabilities(bs) / ta * 100).toFixed(1) : "0.0";
}
// D/Eレシオ（負債/純資産）。Stage3の借入上限判定に使う
function deRatio(bs) {
  const eq = equity(bs);
  return eq > 0 ? bs.debt / eq : (bs.debt > 0 ? Infinity : 0);
}
// 借入可能な最大額：D/Eレシオが200%を超えない範囲
// debt + x <= 2 * equity → x <= 2*equity - debt
function maxBorrowable(bs) {
  const eq = equity(bs);
  if (eq <= 0) return 0; // 純資産がマイナス/ゼロなら新規借入不可
  return Math.max(0, Math.floor(2 * eq - bs.debt));
}

// ============================================================
// GAME ENGINE
// ============================================================

function competitiveScore(ops, baseArpu) {
  const bc = Math.log2(1 + ops.brandAwareness) / Math.log2(101);
  // 価格スコア：指数0.5カーブ。値上げ・値下げどちらも極端になるほど連続的に効果が強まる
  // （旧実装はMath.max(0,...)で+50%超の値上げから効果が完全に飽和してしまうバグがあったため撤廃）
  const priceScore = (baseArpu && ops.setPrice)
    ? (() => {
        const ratio = (ops.setPrice - baseArpu) / baseArpu;
        const curved = Math.sign(ratio) * Math.pow(Math.abs(ratio), 0.5);
        return 50 - curved * 40; // 下限・上限なしで連続的に変化。±100%値上げ/値下げ付近で±40pt相当
      })()
    : 50;
  return ops.salesPower * 0.30 + ops.solutionQuality * 0.25
       + bc * 25 + priceScore * 0.20 + ops.supportQuality * 0.10;
}

function calcChurn(ops, baseArpu) {
  const base = 0.12;
  // ★ C案：値上げするほど自然解約が増える（高単価戦略の代償）
  // 値上げ+100%で+30%の解約率上乗せ。値下げはペナルティなし（現状維持）
  // ★ 上限は0.85（85%）まで拡大。0.45だと+125%超の値上げでchurnが頭打ちになり、
  //   その先はrevenue増加だけが効いて「極端な値上げほど得」という逆転現象が生じていたため修正。
  const priceRatio = (baseArpu && ops.setPrice) ? ops.setPrice / baseArpu : 1.0;
  const priceEffect = Math.max(0, priceRatio - 1) * 0.30;
  return Math.max(0.005, Math.min(0.85,
    base
    - (ops.supportQuality - 50) * 0.0015
    - (ops.solutionQuality - 50) * 0.0006
    + priceEffect
  ));
}

// ★ 値上げ時、価格に敏感な一部の顧客には旧価格のまま引き留め交渉が発生する、という想定。
// 値上げ率が大きいほど交渉に応じる顧客の割合が増え（最大65%）、実質的な単価の伸びが鈍る。
// 値下げ（倍率<=1）には交渉は発生しない（全顧客に新価格がそのまま適用される）。
function calcNegotiatedRatio(priceMultiplier) {
  if (priceMultiplier <= 1) return 0;
  const hikeRatio = priceMultiplier - 1;
  return Math.min(0.65, hikeRatio * 0.35);
}

function calcRevenue(ops, market) {
  // ARPUはpriceMultiplier（価格設定）で変動。solutionQualityはスコア経由のみ
  const priceMultiplier = ops.priceMultiplier || 1.0;
  const negotiatedRatio = calcNegotiatedRatio(priceMultiplier);
  // 交渉に応じた顧客には旧価格(1.0倍)、残りの顧客には新価格(priceMultiplier)を適用した加重平均
  const effectiveMultiplier = negotiatedRatio * 1.0 + (1 - negotiatedRatio) * priceMultiplier;
  return Math.floor(ops.stores * market.arpu * effectiveMultiplier);
}

// 価格設定からpriceMultiplierを計算
function calcPriceMultiplier(setPrice, baseArpu) {
  if (!setPrice || setPrice <= 0) return 1.0;
  return setPrice / baseArpu;
}

// ============================================================
// ★ NPC価格戦略：年次のみ再判定（Q4→Q5、Q8→Q9のconfirmPriceから呼ばれる）
// シェア劣勢による値下げ反応を、品質優位による強気設定より優先する
// （品質が高くても、シェアを大きく失っている状況ではまず防衛を優先する、という想定）
// ============================================================
const NPC_PRICE_MULTIPLIER_RANGE = {
  standard:         [1.00, 1.00],
  price_aggressive: [0.70, 0.80],
  price_premium:    [1.20, 1.30],
};

function decideNpcPriceStrategy(npc, playerStores, baseArpu) {
  const shareRatio = playerStores > 0 ? (npc.ops.stores || 0) / playerStores : 1;
  const isShareLow = shareRatio <= 0.5;
  const isHighQuality = (npc.ops.solutionQuality || 0) >= 100;

  let strategy = "standard";
  if (isShareLow && Math.random() < 0.7) {
    strategy = "price_aggressive";
  } else if (isHighQuality && Math.random() < 0.6) {
    strategy = "price_premium";
  }

  const [lo, hi] = NPC_PRICE_MULTIPLIER_RANGE[strategy];
  const priceMultiplier = lo + Math.random() * (hi - lo);
  const setPrice = Math.max(1, Math.round(baseArpu * priceMultiplier));
  return { strategy, priceMultiplier, setPrice };
}

// ★ 原価（COGS）は店舗数ベースの固定単価。価格（ARPU設定）には依存しない。
// サーバー費用・ライセンス費用など「1顧客に提供するコストの実額」のため、価格を変えても変わらない。
function calcCogs(ops, market) {
  return Math.floor((ops.stores || 0) * (market.cogsPerStore || market.arpu * 0.25));
}

function calcVarCost(ops, market) {
  return Math.floor(ops.stores * market.varCostPerStore);
}

// ★ 営業力強化＝人員増強と解釈。salesPowerが50を超えると段階的に固定費が増える。
// 0〜50: 追加費用なし（既存人員で対応可能）
// 50〜100: (salesPower-50)×0.8万/Q（営業人員を増やしている）
// 100〜150: さらに(salesPower-100)×1.5万/Q追加（マネジメント層も必要になり増加ペースが上がる）
function calcSalesOpexAddon(salesPower) {
  const sp = Math.max(0, salesPower || 0);
  let addon = 0;
  if (sp > 50) addon += Math.min(sp, 100) - 50 > 0 ? (Math.min(sp, 100) - 50) * 0.8 : 0;
  if (sp > 100) addon += (Math.min(sp, 150) - 100) * 1.5;
  return Math.floor(addon);
}

// 予算配分をopsに反映（逓減カーブ付き投資効果 or 自然劣化）
// ============================================================
// Stage3: 借入の能動化
// ============================================================
const LOAN_TERM_QUARTERS = 4; // 4Q均等返済（1年）

// 借入を実行：bsに新しいローンを追加し、debtとcashを増やす
function borrowMoney(bs, amount) {
  if (amount <= 0) return bs;
  const quarterlyPrincipal = Math.ceil(amount / LOAN_TERM_QUARTERS);
  const newLoan = {
    principal: amount,
    remainingQuarters: LOAN_TERM_QUARTERS,
    quarterlyPrincipal,
  };
  return {
    ...bs,
    cash: bs.cash + amount,
    debt: bs.debt + amount,
    loanSchedule: [...(bs.loanSchedule || []), newLoan],
  };
}

// 毎Q処理：ローンスケジュールから今Qの返済額（元本+利息）を計算する。
// bsそのものは変更しない（cash/debtの実際の変動はprocessQuarter側で一括処理する）
// 戻り値: { newSchedule: 更新後のローン一覧, principalPaid: 元本返済額, interestPaid: 利息額 }
function calcLoanRepayment(bs) {
  const schedule = bs.loanSchedule || [];
  if (schedule.length === 0) return { newSchedule: [], principalPaid: 0, interestPaid: 0 };

  let principalPaid = 0;
  let interestPaid = 0;
  const newSchedule = [];

  schedule.forEach(loan => {
    if (loan.remainingQuarters <= 0) return; // 完済済みは除去
    const remainingPrincipal = loan.quarterlyPrincipal * loan.remainingQuarters;
    const interest = Math.floor(Math.min(remainingPrincipal, loan.principal) * INTEREST_RATE);
    const thisPrincipalPayment = Math.min(loan.quarterlyPrincipal, remainingPrincipal);
    principalPaid += thisPrincipalPayment;
    interestPaid += interest;
    const remaining = loan.remainingQuarters - 1;
    if (remaining > 0) {
      newSchedule.push({ ...loan, remainingQuarters: remaining });
    }
  });

  return { newSchedule, principalPaid, interestPaid };
}

// 今Q配分した投資は次Qにならないとパラメータへ反映されない。
// pendingInvestment に積んでおき、次Q開始時にcommitする。
// ============================================================

// 前Qに積んだpendingInvestmentをパラメータへ反映する（今Q開始時に実行）
function commitPendingInvestment(ops, investEfficiency = 1.0, currentMarketNeed = null) {
  const pending = ops.pendingInvestment || {};
  let newOps = { ...ops };
  BUDGET_ITEMS.forEach(item => {
    if (item.immediate) return; // ★ 即時反映項目は既にqueuePendingInvestmentで処理済みなのでスキップ
    const invested = pending[item.id] || 0;
    if (invested > 0) {
      let gain = calcParamGain(newOps[item.param], item.basePer100, invested, investEfficiency);
      // ★ devのみ：投資時に選んだdevFocusが、反映時点の市場ニーズ（全社共通）と一致するかでボーナス/ペナルティ
      if (item.id === "dev") {
        const chosenFocus = pending.devFocus;
        if (chosenFocus && currentMarketNeed) {
          gain = Math.round(gain * (chosenFocus === currentMarketNeed ? DEV_MATCH_BONUS : DEV_MISMATCH_PENALTY));
        }
        newOps.lastDevFocusResult = chosenFocus
          ? { focus: chosenFocus, matched: chosenFocus === currentMarketNeed, marketNeed: currentMarketNeed, gain }
          : null;
      }
      newOps[item.param] = Math.min(PARAM_MAX, newOps[item.param] + gain);
    } else {
      newOps[item.param] = Math.max(0, newOps[item.param] - item.decay);
    }
  });
  newOps.pendingInvestment = {}; // 反映済みなのでクリア
  return newOps;
}

// 今Q配分した額をpendingInvestmentとして積む（パラメータには反映しない）
// ★ immediate:trueの項目（マーケティング）は即座にパラメータへ反映し、pendingには積まない
function queuePendingInvestment(ops, allocation, investEfficiency = 1.0) {
  let newOps = { ...ops };
  const delayedAlloc = {};
  BUDGET_ITEMS.forEach(item => {
    const invested = allocation[item.id] || 0;
    if (item.immediate) {
      // 即時反映：今Qの結果にそのまま使う
      if (invested > 0) {
        const gain = calcParamGain(newOps[item.param], item.basePer100, invested, investEfficiency);
        newOps[item.param] = Math.min(PARAM_MAX, newOps[item.param] + gain);
      } else {
        newOps[item.param] = Math.max(0, newOps[item.param] - item.decay);
      }
    } else {
      delayedAlloc[item.id] = invested;
    }
  });
  // ★ devFocus（顧客価値の方向性選択）をpendingに保存。次Q反映時に市場ニーズと比較する
  if (allocation.devFocus) delayedAlloc.devFocus = allocation.devFocus;
  newOps.pendingInvestment = delayedAlloc;
  return newOps;
}

// 旧関数：即時反映版（NPC・互換性のために残す）
function applyBudgetAllocation(ops, allocation, investEfficiency = 1.0) {
  let newOps = { ...ops };
  BUDGET_ITEMS.forEach(item => {
    const invested = allocation[item.id] || 0;
    if (invested > 0) {
      const gain = calcParamGain(newOps[item.param], item.basePer100, invested, investEfficiency);
      newOps[item.param] = Math.min(PARAM_MAX, newOps[item.param] + gain);
    } else {
      newOps[item.param] = Math.max(0, newOps[item.param] - item.decay);
    }
  });
  return newOps;
}

// 特別アクション適用
function applySpecialAction(bs, ops, actionId, usedActions, playerType) {
  const action = SPECIAL_ACTIONS[actionId];
  if (!action) return { bs, ops, sgaAdd: 0, capitalizeAmt: 0 };
  // ★ 防御的チェック：startupOnlyアクションがUIのフィルタを迂回して呼ばれた場合に備える
  if (action.startupOnly && playerType && playerType !== "startup") {
    return { bs, ops, sgaAdd: 0, capitalizeAmt: 0 };
  }
  let newBs = { ...bs }, newOps = { ...ops };
  let sgaAdd = 0, capitalizeAmt = 0;

  if (action.cost > 0) {
    if (action.capitalize) { newBs.cash -= action.cost; capitalizeAmt = action.cost; newBs.softwareAsset += action.cost; }
    else                   { newBs.cash -= action.cost; sgaAdd = action.cost; }
  }
  if (action.cashGain)    newBs.cash    += action.cashGain;
  if (action.capitalGain) newBs.capital += action.capitalGain;
  // ★ Stage3統合: debtGainはloanScheduleにも正しく登録する（cashは上のcashGainで既に加算済みなのでcashは増やさない）
  if (action.debtGain) {
    const quarterlyPrincipal = Math.ceil(action.debtGain / LOAN_TERM_QUARTERS);
    newBs.debt += action.debtGain;
    newBs.loanSchedule = [...(newBs.loanSchedule || []),
      { principal: action.debtGain, remainingQuarters: LOAN_TERM_QUARTERS, quarterlyPrincipal }];
  }
  // ★ Stage3統合: fullRepayはloanScheduleも完全クリアする
  if (action.fullRepay)   { newBs.cash -= newBs.debt; newBs.debt = 0; newBs.loanSchedule = []; }
  if (action.effects)      Object.entries(action.effects).forEach(([k,v]) => { newOps[k] = Math.min(100, newOps[k] + v); });
  if (action.storeBonus)   newOps.stores += action.storeBonus;
  if (action.priceDiscount && newOps.setPrice > 0) {
    // 一時値下げ：setPrice × (1 - discount)
    newOps = {...newOps,
      setPrice: Math.max(1, Math.floor(newOps.setPrice * (1 - action.priceDiscount))),
      priceMultiplier: Math.max(0.1, newOps.priceMultiplier * (1 - action.priceDiscount))
    };
  }
  return { bs: newBs, ops: newOps, sgaAdd, capitalizeAmt };
}

// 競争解決
function resolveMarket(allPlayers, market, quarter, extraUnclaimed = 0, truceMap = {}) {
  const phase = getPhase(quarter);
  const penetration = marketPenetration(quarter);
  const totalAvail = Math.floor(market.totalStores * penetration) + extraUnclaimed;
  const currentTotal = allPlayers.reduce((s, p) => s + p.ops.stores, 0);
  const unclaimed = Math.max(0, totalAvail - currentTotal);

  const baseArpu = market?.arpu || 80;
  const scores = allPlayers.map(p => competitiveScore(p.ops, baseArpu));
  const totalScore = scores.reduce((s, x) => s + x, 0);

  // ★ truceMap: { playerId: [相手id, ...] } 不戦条約が成立しているペアの集合
  const isTruce = (idA, idB) => (truceMap[idA] || []).includes(idB);

  // ★ Stage5: 結果への不確実性。乱数係数（中心1.0、範囲は項目ごとに変える）
  // 同じ配分・同じスコアでも毎Q結果が多少ブレる「賭け」の感覚を出す
  const rand = (spread) => 1 + (Math.random() - 0.5) * spread;

  return allPlayers.map((player, i) => {
    const myScore = scores[i];
    const myShare = totalScore > 0 ? myScore / totalScore : 1 / allPlayers.length;

    // 新規獲得：±15%のブレ（市場の動きは完全に予測できない）
    // ★ C案：低価格戦略のメリット強化。標準価格より安いほど新規獲得が加速する
    const myPriceRatio = (market.arpu && player.ops.setPrice) ? player.ops.setPrice / market.arpu : 1.0;
    const priceFavorBonus = 1 + Math.max(0, (1 - myPriceRatio)) * 1.6; // 半額で+80%ボーナス（原価固定化により低価格戦略の構造的不利を補正）
    const rawNewFromUnclaimed = Math.floor(unclaimed * myShare * 0.15 * phase.growthBonus * priceFavorBonus * rand(0.30));
    const newFromUnclaimed = unclaimed > 0 ? Math.max(1, rawNewFromUnclaimed) : 0;

    // 競合からの奪取（スコア差 + 3つの対抗関係ボーナス）：±10%のブレ
    let stolenFromRivals = 0;
    const stolenBreakdown = {}; // ★ 相手ID別の奪取量（戦況シーン表示用）
    allPlayers.forEach((rival, j) => {
      if (i === j || rival.ops.stores === 0) return;
      if (isTruce(player.id, rival.id)) return; // ★ 不戦条約成立中は奪取しない
      const diff = myScore - scores[j];
      if (diff > 0) {
        let rate = Math.min(0.20, (diff / Math.max(scores[j], 1)) * 0.25 * phase.stealMultiplier);

        // ★ 対抗関係①：自分の営業力 vs 相手のブランド力
        // 営業力が高く、相手のブランドが低いほど効く（無名の相手の顧客は営業トークで動く）
        const salesVsBrand = (player.ops.salesPower / 150) * (1 - rival.ops.brandAwareness / 150) * 0.12;
        rate += Math.max(0, salesVsBrand);

        // ★ 対抗関係②：自分の価格優位 vs 相手の品質
        // 安さで攻めても、相手の品質が圧倒的だと刺さりにくい（減衰させる）
        const myPrice = player.ops.setPrice || market.arpu;
        const rivalPrice = rival.ops.setPrice || market.arpu;
        if (myPrice < rivalPrice) {
          const priceDiffRatio = (rivalPrice - myPrice) / rivalPrice;
          const qualityResistance = Math.max(0.3, 1 - rival.ops.solutionQuality / 150); // 品質が高いほど0.3に近づき効果減衰
          rate += priceDiffRatio * (market.priceSensitivity || 0.6) * 1.0 * qualityResistance;
        }

        rate = Math.max(0, Math.min(0.40, rate));
        const amount = Math.floor(rival.ops.stores * rate * rand(0.20));
        stolenFromRivals += amount;
        stolenBreakdown[rival.id] = amount;
      }
    });

    // 競合に奪われる（スコア差 + 対抗関係ペナルティ - CSによる防御）：±10%のブレ
    let lostToRivals = 0;
    const lostBreakdown = {}; // ★ 相手ID別の流出量（戦況シーン表示用）
    allPlayers.forEach((rival, j) => {
      // ★ 相手の店舗が0の場合、その相手への流出は計上しない（奪取側と対称な仕様に統一）
      if (i === j || player.ops.stores === 0 || rival.ops.stores === 0) return;
      if (isTruce(player.id, rival.id)) return; // ★ 不戦条約成立中は流出しない
      const diff = scores[j] - myScore;
      if (diff > 0) {
        let rate = Math.min(0.20, (diff / Math.max(myScore, 1)) * 0.25 * phase.stealMultiplier);

        // 相手から見た対抗関係①：相手の営業力 vs 自分のブランド力
        const rivalSalesVsMyBrand = (rival.ops.salesPower / 150) * (1 - player.ops.brandAwareness / 150) * 0.12;
        rate += Math.max(0, rivalSalesVsMyBrand);

        // 相手から見た対抗関係②：相手の価格優位 vs 自分の品質
        const myPrice = player.ops.setPrice || market.arpu;
        const rivalPrice = rival.ops.setPrice || market.arpu;
        if (myPrice > rivalPrice) {
          const priceDiffRatio = (myPrice - rivalPrice) / myPrice;
          const qualityResistance = Math.max(0.3, 1 - player.ops.solutionQuality / 150);
          rate += priceDiffRatio * (market.priceSensitivity || 0.6) * 0.4 * qualityResistance;
        }

        // ★ 対抗関係③：自分のCS vs 相手の営業力（守備）
        // CSが高いほど、相手の営業攻勢からの流出を防ぐ（流出率を減衰させる）
        const csDefense = (player.ops.supportQuality / 150) * (rival.ops.salesPower / 150) * 0.5;
        rate = Math.max(0, rate - csDefense);

        rate = Math.min(0.30, rate);
        const amount = Math.floor(player.ops.stores * rate * rand(0.20));
        lostToRivals += amount;
        lostBreakdown[rival.id] = amount;
      }
    });

    // 自然解約：±10%のブレ
    const churnRate = calcChurn(player.ops, market.arpu);
    const naturalChurn = Math.floor(player.ops.stores * churnRate * rand(0.20));

    const gained = newFromUnclaimed + stolenFromRivals;
    const lost   = naturalChurn + lostToRivals;
    const final  = Math.max(0, player.ops.stores + gained - lost);

    return { id: player.id, newFromUnclaimed, stolenFromRivals, naturalChurn, lostToRivals,
             gained, lost, finalStores: final, churnRate, stolenBreakdown, lostBreakdown };
  });
}

// 1Qの全処理
function processQuarter(playerBs, playerOps, playerAlloc, playerSpecial,
                        npcs, market, quarter, usedSpecials, playerType, marketNeed, truceProposals = []) {
  const phase = getPhase(quarter);
  const pt = PLAYER_TYPES[playerType];
  const investEfficiency = pt?.investEfficiency || 1.0;
  const baseOpex = pt?.baseOpex || 100;
  // ★ 市場の顧客ニーズ（全社共通、見えない）。次Qに向けて1回だけ更新し、全員が同じ値を参照する
  const currentMarketNeed = marketNeed || DEV_FOCUS_KEYS[0];
  const nextMarketNeed = evolveMarketNeed(currentMarketNeed);

  // ★ ③不戦条約：プレイヤーがtruceProposalsで提案したNPCに対し、NPCがランダムに応諾するか判定
  // 受諾率：自分のスコアが相手より劣っているほど受けやすい（劣勢側が和を結びたがる、という自然な動機）
  const truceResults = {}; // { npcId: true/false }
  truceProposals.forEach(npcId => {
    const npc = npcs.find(n => n.id === npcId);
    if (!npc) return;
    const npcScore = competitiveScore(npc.ops, market.arpu);
    const myScore = competitiveScore(playerOps, market.arpu);
    const npcDisadvantage = Math.max(0, myScore - npcScore) / Math.max(myScore, npcScore, 1);
    const acceptChance = Math.min(0.85, 0.35 + npcDisadvantage * 0.6); // 劣勢なほど受けやすい、最大85%
    truceResults[npcId] = Math.random() < acceptChance;
  });
  // ★ 合意成立したペアのみtruceMapに登録（双方向）
  const truceMap = {};
  Object.entries(truceResults).forEach(([npcId, accepted]) => {
    if (!accepted) return;
    truceMap.player = [...(truceMap.player||[]), npcId];
    truceMap[npcId] = [...(truceMap[npcId]||[]), "player"];
  });

  // --- Player: Stage1 時間差反映 ---
  // ①前Qに積んだpendingInvestmentを今Qのパラメータへcommit（市場ニーズとの一致判定込み）
  let pOps = commitPendingInvestment(playerOps, investEfficiency, currentMarketNeed);
  // ②今Q配分した額は来Qまでパラメータに反映されない。pendingとして積むだけ
  pOps = queuePendingInvestment(pOps, playerAlloc, investEfficiency);

  // --- Player: 特別アクション（即時効果）---
  let pBs = { ...playerBs };
  let sgaAdd = 0, capitalizeAmt = 0;
  if (playerSpecial && (!SPECIAL_ACTIONS[playerSpecial]?.oneTime || !usedSpecials.includes(playerSpecial))) {
    const r = applySpecialAction(pBs, pOps, playerSpecial, usedSpecials, playerType);
    pBs = r.bs; pOps = r.ops; sgaAdd = r.sgaAdd; capitalizeAmt = r.capitalizeAmt;
  }

  // --- NPC: 予算配分（BS連動、同じく時間差反映）---
  const npcProcessed = npcs.map(n => {
    const nPt = PLAYER_TYPES[n.type];
    const nSafetyBuffer = (nPt?.baseOpex || 100) * 2;
    const nFreeCash = Math.max(0, n.bs.cash - nSafetyBuffer);
    const nBudget = Math.floor(nFreeCash * (nPt?.investRatio || 0.6));
    const nEff = nPt?.investEfficiency || 1.0;
    let alloc = {};
    if (n.strategy === "sales_heavy") {
      alloc = { sales: nBudget*0.5, dev: nBudget*0.2, marketing: nBudget*0.2, price: 0, cs: nBudget*0.1 };
    } else {
      alloc = { sales: nBudget*0.1, dev: nBudget*0.5, marketing: nBudget*0.1, price: nBudget*0.15, cs: nBudget*0.15 };
    }
    // ★ NPCもdevFocusをランダムに選ぶ（プレイヤーと同じ不確実性を持つ）
    if (alloc.dev > 0) alloc.devFocus = DEV_FOCUS_KEYS[Math.floor(Math.random() * DEV_FOCUS_KEYS.length)];
    // ①前Qのpendingをcommit ②今Qの配分をpendingとして積む
    let nOps = commitPendingInvestment(n.ops, nEff, currentMarketNeed);
    nOps = queuePendingInvestment(nOps, alloc, nEff);
    const nUsedSpecials = n.usedSpecials || [];
    const candidateSpecial = n.strategy === "sales_heavy" ? "chain_deal" : "line_collab";
    const candidateAction = SPECIAL_ACTIONS[candidateSpecial];
    // ★ oneTimeアクションは既に使用済みなら抽選対象から外す（プレイヤーと同じ制約）
    const alreadyUsed = candidateAction?.oneTime && nUsedSpecials.includes(candidateSpecial);
    const nSpecial = (!alreadyUsed && Math.random() < 0.40) ? candidateSpecial : null;
    let nBs = {...n.bs};
    let nSgaAdd = 0; // ★ 特別アクションの費用分。PL計算に反映するため保持
    if (nSpecial) {
      const r = applySpecialAction(nBs, nOps, nSpecial, nUsedSpecials, n.type);
      nBs = r.bs; nOps = r.ops; nSgaAdd = r.sgaAdd || 0;
      // r.capitalizeAmtはapplySpecialAction内でnBs.softwareAssetに既に加算済みなのでここでは何もしない
    }
    const newNUsedSpecials = (nSpecial && SPECIAL_ACTIONS[nSpecial]?.oneTime)
      ? [...nUsedSpecials, nSpecial]
      : nUsedSpecials;
    return { ...n, ops: nOps, bs: nBs, usedSpecial: nSpecial, specialSgaAdd: nSgaAdd, usedSpecials: newNUsedSpecials };
  });

  // --- 競争解決 ---
  const allForCompet = [
    { id:"player", ops: pOps },
    ...npcProcessed.map(n => ({ id: n.id, ops: n.ops })),
  ];
  const competResults = resolveMarket(allForCompet, market, quarter, 0, truceMap);
  const pResult = competResults.find(r => r.id === "player");

  // --- Player PL確定 ---
  const finalPOps = { ...pOps, stores: pResult.finalStores };

  // SW償却（既存資産分のみ）
  const dep = Math.floor(pBs.softwareAsset * SW_DEP_RATE);
  pBs.softwareAsset -= dep;

  // ★ Stage3: ローンスケジュールに基づく返済額を計算（bsはまだ変更しない）
  const loanCalc = calcLoanRepayment(pBs);
  const interest = loanCalc.interestPaid;       // PLに計上される費用
  const principalPaid = loanCalc.principalPaid; // PLを通らないBSのみの資金移動
  pBs.loanSchedule = loanCalc.newSchedule;
  pBs.debt = Math.max(0, pBs.debt - principalPaid);

  // 予算投資額の分類（費用 or 資産計上）
  let allocSga = 0, allocCapitalize = 0;
  BUDGET_ITEMS.forEach(item => {
    const amt = playerAlloc[item.id] || 0;
    if (amt > 0) {
      if (item.capitalize) allocCapitalize += amt;
      else allocSga += amt;
    }
  });

  // ★ 予算はPL費用処理（現預金から直接引かず、純利益を通じてBSに反映）
  // 資産計上分だけBSのsoftwareAssetに加算
  pBs.softwareAsset += allocCapitalize;

  // ★ 営業力強化＝人員増強と解釈。salesPowerが一定以上だと固定費が段階的に増える
  const salesOpexAddon = calcSalesOpexAddon(finalPOps.salesPower);
  const totalBaseOpex = baseOpex + salesOpexAddon;

  const revenue  = calcRevenue(finalPOps, market);
  const cogs     = calcCogs(finalPOps, market);
  const varCost  = calcVarCost(finalPOps, market);
  const totalSga = allocSga + sgaAdd + totalBaseOpex + varCost;
  const grossProfit     = revenue - cogs;
  const operatingProfit = grossProfit - totalSga - dep;
  const netIncome       = operatingProfit - interest;

  // ★ BS整合：
  // sgaAdd（特別アクションのコスト）はapplySpecialActionの段階で既にpBs.cashから引かれている。
  // ここで再度引くと二重減算になるため、cash計算からは除外する（retainedEarningsにはnetIncome経由で引き続き計上）。
  // cash変動   = rev - cogs - varCost - opex(addon込み) - allocSga - allocCapitalize - interest - principalPaid
  // retainedΔ = rev - cogs - varCost - opex(addon込み) - allocSga - sgaAdd - dep - interest  (= netIncome)
  // debtΔ      = -principalPaid
  // swAssetΔ  = allocCapitalize - dep
  // totalAssetsΔ = cashΔ + swΔ = (netIncome + sgaAdd - dep) + (allocCapitalize - dep) ... 整理すると以下で一致：
  // 負債純資産側Δ = retainedΔ + debtΔ = netIncome - principalPaid ✓ 一致（sgaAddはcash側で引かない分、両辺で相殺）
  pBs.cash += revenue - cogs - varCost - totalBaseOpex - allocSga - allocCapitalize - interest - principalPaid;
  pBs.retainedEarnings += netIncome; // netIncome = rev-cogs-varCost-opex-allocSga-sgaAdd-dep-interest

  const pl = {
    revenue, cogs, grossProfit, varCost,
    allocSga, allocCapitalize, sgaAdd, opex: totalBaseOpex, baseOpexCore: baseOpex, salesOpexAddon, totalSga,
    depAmt: dep, interestExpense: interest, principalPaid,
    operatingProfit, netIncome,
    competResult: pResult,
    phase: phase.name,
    playerAlloc, playerSpecial,
    investEfficiency,
    market: { arpu: market.arpu, varCostPerStore: market.varCostPerStore, cogsPerStore: market.cogsPerStore }, // ★ PL詳細表示用
    priceMultiplier: finalPOps.priceMultiplier,
    setPrice: finalPOps.setPrice,
    truceResults, // ★ ③不戦条約の合意/拒否結果
  };

  // --- NPC PL/BS確定（プレイヤーと同じロジックで計算）---
  const newNpcs = npcProcessed.map((n) => {
    const nr = competResults.find(r => r.id === n.id);
    const nFinalOps = { ...n.ops, stores: nr.finalStores };
    const nPt = PLAYER_TYPES[n.type];
    const nBaseOpex = nPt?.baseOpex || 100;
    let nBs = { ...n.bs };

    // SW償却
    const nDep = Math.floor(nBs.softwareAsset * SW_DEP_RATE);
    nBs.softwareAsset -= nDep;

    // NPC投資額（BS連動で算出した分を費用/資産計上）
    const nSafetyBuffer = nBaseOpex * 2;
    const nFreeCash = Math.max(0, nBs.cash - nSafetyBuffer);
    const nInvestTotal = Math.floor(nFreeCash * (nPt?.investRatio || 0.1));
    // 戦略に応じてdev分を資産計上、それ以外は費用
    const nDevRatio = n.strategy === "dev_heavy" ? 0.5 : 0.2;
    const nAllocCap = Math.floor(nInvestTotal * nDevRatio);
    const nAllocSga = nInvestTotal - nAllocCap;
    nBs.softwareAsset += nAllocCap;

    // ★ 特別アクションの費用（applySpecialActionで既にnBs.cashから引かれている分）をPLにも計上
    const nSgaAdd = n.specialSgaAdd || 0;

    // NPC: 借入アクションは取らない設計（Stage3の対象外）。debt=0のままなのでnIntは常に0
    const nInt = Math.floor(nBs.debt * INTEREST_RATE);
    const nRev = calcRevenue(nFinalOps, market);
    const nCogs = calcCogs(nFinalOps, market);
    const nVarC = calcVarCost(nFinalOps, market);

    // ★ 営業力強化＝人員増強と解釈。NPCにも同様に適用（プレイヤーとの公平性のため）
    const nSalesOpexAddon = calcSalesOpexAddon(nFinalOps.salesPower);
    const nTotalBaseOpex = nBaseOpex + nSalesOpexAddon;

    // ★ プレイヤーと同じBS整合ロジック（nSgaAddを費用として明示的に計上）
    // 注意：applySpecialActionで既にnBs.cashからaction.costが引かれているため、
    // ここでcashを再度引いてしまうと二重減算になる。
    // そのためcash計算からはnSgaAdd分を除外し、retainedEarningsにはnSgaAddを反映させる。
    const nNetIncome = nRev - nCogs - nVarC - nTotalBaseOpex - nAllocSga - nSgaAdd - nDep - nInt;
    nBs.cash += nRev - nCogs - nVarC - nTotalBaseOpex - nAllocSga - nAllocCap - nInt;
    nBs.retainedEarnings += nNetIncome;

    return { ...n, ops: nFinalOps, bs: nBs, lastSpecial: n.usedSpecial };
  });

  const newUsedSpecials = playerSpecial && SPECIAL_ACTIONS[playerSpecial]?.oneTime
    ? [...usedSpecials, playerSpecial] : usedSpecials;

  return { pBs, finalPOps, pl, newNpcs, newUsedSpecials, nextMarketNeed };
}

// NPC予算（opsから逆算）
// ============================================================
// 競争ナラティブ生成
// ============================================================
function generateCompetitiveNarrative(competResult, npcs, prevNpcOps, phase) {
  const messages = [];
  const cr = competResult;

  // 奪取・奪われメッセージ
  if (cr.stolenFromRivals > 0) {
    const victims = npcs.filter((n, i) => {
      const myScore = cr.myScore || 0;
      return myScore > (cr.rivalScores?.[i] || 0);
    });
    messages.push({
      type: "steal",
      icon: "⚔️",
      color: "#00C8D4",
      text: `競合から ${cr.stolenFromRivals}店を奪取。競争力の差が市場に表れ始めている。`,
    });
  }
  if (cr.lostToRivals > 0) {
    const severity = cr.lostToRivals >= 20 ? "深刻" : cr.lostToRivals >= 10 ? "警戒" : "注意";
    const icon = cr.lostToRivals >= 20 ? "🚨" : cr.lostToRivals >= 10 ? "⚠️" : "📉";
    messages.push({
      type: "lost",
      icon,
      color: cr.lostToRivals >= 10 ? "#F85149" : "#E3B341",
      text: `競合に ${cr.lostToRivals}店を奪われた。【${severity}】対策を考えないと流出が続くかもしれない。`,
    });
  }

  // NPC戦略変化の通知（★ 内部パラメータは非公開。店舗数の伸びという観測可能な情報のみ使う）
  npcs.forEach(n => {
    if (!prevNpcOps) return;
    const prev = prevNpcOps[n.id];
    if (!prev || !prev.stores) return;
    const storeDiff = (n.ops.stores||0) - (prev.stores||0);
    const growthRate = storeDiff / Math.max(1, prev.stores);
    if (growthRate >= 0.20) {
      messages.push({
        type: "npc_growth",
        icon: "📈",
        color: n.color,
        text: `${n.name}が前Qから店舗数を大きく伸ばした(${storeDiff>0?"+":""}${storeDiff}店)。何を強化したのかは不明だが、警戒が必要かもしれない。`,
      });
    } else if (growthRate <= -0.15) {
      messages.push({
        type: "npc_decline",
        icon: "📉",
        color: n.color,
        text: `${n.name}は前Qから店舗数が減少している(${storeDiff}店)。苦戦している様子が見える。`,
      });
    }
  });

  // フェーズ移行メッセージ
  if (phase.id === "growth" && cr.quarter === 5) {
    messages.push({
      type: "phase",
      icon: "🚀",
      color: "#3FB950",
      text: "市場が急成長フェーズに突入。投資を加速しないとシェアを失う。",
    });
  }
  if (phase.id === "mature" && cr.quarter === 9) {
    messages.push({
      type: "phase",
      icon: "🏁",
      color: "#D2A8FF",
      text: "市場が成熟期へ。未開拓は残り僅か。これからは競合との直接対決が主戦場だ。",
    });
  }

  return messages;
}

// マーケットシェア円グラフ（SVG）- NaN%バグ修正版
// ============================================================
// 数字カウントアップ表示（0→targetへアニメーション）
// ============================================================
function CountUpNumber({ target, duration=800, prefix="", suffix="", color, svgMode=false }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime = null;
    let raf;
    function step(ts) {
      if (!startTime) startTime = ts;
      const progress = Math.min(1, (ts - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.floor(eased * target));
      if (progress < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  if (svgMode) return <>{prefix}{display}{suffix}</>;
  return <span style={{color}}>{prefix}{display}{suffix}</span>;
}

// ============================================================
// 戦況バトルカード：Q結果を視覚的に演出
// ============================================================
// ============================================================
// CHARACTER SPRITES：プレイヤー・NPCのドット絵キャラクター
// mood: "normal" | "happy" | "worried"
// ============================================================
function CharacterSprite({ type, mood = "normal", scale = 1 }) {
  if (type === "player") {
    if (mood === "happy") return (
      <g transform={`scale(${scale})`}>
        <path d="M-20,-12 L-28,28 L-8,26 L-12,-8 Z" fill="#0E7A8A" transform="rotate(8 -15 8)"/>
        <rect x="-15" y="30" width="11" height="20" fill="#1B2733" transform="rotate(-6 -10 40)"/>
        <rect x="4" y="30" width="11" height="20" fill="#1B2733" transform="rotate(10 9 40)"/>
        <path d="M-15,-14 L-32,-32 L-26,-38 L-9,-20 Z" fill="#00C8D4"/>
        <path d="M15,-14 L32,-32 L26,-38 L9,-20 Z" fill="#00C8D4"/>
        <rect x="22" y="-66" width="6" height="34" fill="#E9EEF3" transform="rotate(8 25 -49)"/>
        <path d="M22,-66 L25,-72 L28,-66 Z" fill="#E9EEF3" transform="rotate(8 25 -49)"/>
        <path d="M-26,-44 Q-32,-32 -26,-20 Q-20,-32 -26,-44 Z" fill="#00C8D4" transform="rotate(-15 -26 -32)"/>
        <path d="M-22,-8 L-24,28 L24,28 L22,-8 Q0,-16 -22,-8 Z" fill="#00C8D4"/>
        <path d="M-13,-16 Q0,-9 13,-16 L14,-8 Q0,-2 -14,-8 Z" fill="#F2A23C"/>
        <circle cx="0" cy="-32" r="20" fill="#F4D1A8"/>
        <path d="M-21,-34 Q-24,-54 0,-56 Q24,-54 21,-34 Q14,-44 6,-40 Q0,-46 -6,-40 Q-14,-44 -21,-34 Z" fill="#8B5A2B"/>
        <path d="M-22,-42 Q0,-58 22,-42 Q22,-46 0,-50 Q-22,-46 -22,-42 Z" fill="#0E7A8A"/>
        <circle cx="0" cy="-52" r="4" fill="#FFD166"/>
        <path d="M-12,-30 Q-8,-26 -4,-30" stroke="#0D1117" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M4,-30 Q8,-26 12,-30" stroke="#0D1117" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M-7,-20 Q0,-12 7,-20" stroke="#C0805A" strokeWidth="2" fill="#B8492F" strokeLinecap="round"/>
      </g>
    );
    if (mood === "worried") return (
      <g transform={`scale(${scale})`}>
        <path d="M-18,-12 L-23,28 L-7,25 L-11,-8 Z" fill="#0E7A8A"/>
        <rect x="-13" y="24" width="11" height="18" fill="#2B3845"/>
        <rect x="2" y="24" width="11" height="18" fill="#2B3845"/>
        <path d="M-30,-10 Q-38,4 -30,20 Q-22,4 -30,-10 Z" fill="#C9D1D9" transform="rotate(-6 -30 5)"/>
        <path d="M-30,-7 Q-36,4 -30,16 Q-25,4 -30,-7 Z" fill="#00C8D4" transform="rotate(-6 -30 5)"/>
        <rect x="-26" y="-2" width="9" height="18" rx="3" fill="#00C8D4" transform="rotate(10 -22 7)"/>
        <rect x="15" y="-4" width="9" height="18" rx="3" fill="#00C8D4" transform="rotate(-14 20 5)"/>
        <rect x="22" y="14" width="4" height="22" fill="#E9EEF3" transform="rotate(-14 24 25)"/>
        <path d="M-17,-14 Q0,-20 17,-14 L15,22 Q0,28 -15,22 Z" fill="#00C8D4"/>
        <path d="M-13,-16 Q0,-10 13,-16 L13,-10 Q0,-4 -13,-10 Z" fill="#F2A23C"/>
        <circle cx="0" cy="-30" r="20" fill="#F4D1A8" transform="rotate(-4 0 -30)"/>
        <path d="M-21,-32 Q-24,-52 0,-54 Q24,-52 21,-32 Q14,-42 6,-38 Q0,-44 -6,-38 Q-14,-42 -21,-32 Z" fill="#8B5A2B"/>
        <path d="M-22,-40 Q0,-56 22,-40 Q22,-44 0,-48 Q-22,-44 -22,-40 Z" fill="#0E7A8A"/>
        <circle cx="0" cy="-50" r="4" fill="#FFD166"/>
        <ellipse cx="-8" cy="-29" rx="3" ry="4" fill="#0D1117"/>
        <ellipse cx="8" cy="-29" rx="3" ry="4" fill="#0D1117"/>
        <path d="M-4,-19 Q0,-22 4,-19" stroke="#C0805A" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
        <path d="M16,-36 Q19,-31 16,-27 Q13,-31 16,-36 Z" fill="#7DD3E0"/>
      </g>
    );
    return (
      <g transform={`scale(${scale})`}>
        <path d="M-20,-12 L-26,30 L-8,26 L-12,-8 Z" fill="#0E7A8A"/>
        <rect x="-13" y="24" width="11" height="18" fill="#2B3845"/>
        <rect x="2" y="24" width="11" height="18" fill="#2B3845"/>
        <path d="M-38,-10 Q-44,2 -38,16 Q-32,2 -38,-10 Z" fill="#C9D1D9"/>
        <path d="M-38,-8 Q-42,2 -38,13 Q-34,2 -38,-8 Z" fill="#00C8D4"/>
        <rect x="-30" y="-8" width="9" height="18" rx="3" fill="#00C8D4"/>
        <rect x="17" y="-10" width="9" height="20" rx="3" fill="#00C8D4"/>
        <rect x="20" y="8" width="6" height="5" fill="#3D2B1F"/>
        <rect x="21" y="-30" width="4" height="40" fill="#E9EEF3"/>
        <path d="M21,-30 L23,-36 L25,-30 Z" fill="#E9EEF3"/>
        <path d="M-17,-14 Q0,-20 17,-14 L15,22 Q0,28 -15,22 Z" fill="#00C8D4"/>
        <path d="M-13,-16 Q0,-10 13,-16 L13,-10 Q0,-4 -13,-10 Z" fill="#F2A23C"/>
        <circle cx="0" cy="-32" r="20" fill="#F4D1A8"/>
        <path d="M-21,-34 Q-24,-54 0,-56 Q24,-54 21,-34 Q14,-44 6,-40 Q0,-46 -6,-40 Q-14,-44 -21,-34 Z" fill="#8B5A2B"/>
        <path d="M-22,-42 Q0,-58 22,-42 Q22,-46 0,-50 Q-22,-46 -22,-42 Z" fill="#0E7A8A"/>
        <circle cx="0" cy="-52" r="4" fill="#FFD166"/>
        <circle cx="-8" cy="-30" r="3.2" fill="#0D1117"/>
        <circle cx="8" cy="-30" r="3.2" fill="#0D1117"/>
        <path d="M-3,-20 Q0,-18 3,-20" stroke="#C0805A" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      </g>
    );
  }
  if (type === "npc1") {
    if (mood === "happy") return (
      <g transform={`scale(${scale})`}>
        <path d="M-28,-14 L-38,36 L-6,32 L-10,-10 Z" fill="#7A1F1F"/>
        <path d="M-18,-18 L-44,-36 L-36,-46 L-12,-26 Z" fill="#A12E2E"/>
        <path d="M-50,-50 Q-60,-36 -50,-20 Q-40,-36 -50,-50 Z" fill="#5C5C5C" transform="rotate(-15 -50 -36)"/>
        <path d="M18,-18 L42,-40 L34,-48 L10,-26 Z" fill="#A12E2E"/>
        <rect x="30" y="-78" width="7" height="40" fill="#C9D1D9" transform="rotate(8 34 -58)"/>
        <path d="M-24,-18 Q0,-26 24,-18 L21,24 Q0,30 -21,24 Z" fill="#E24B4A"/>
        <circle cx="0" cy="-36" r="22" fill="#F0C8A0"/>
        <path d="M-25,-46 Q0,-60 25,-46 Q25,-50 0,-54 Q-25,-50 -25,-46 Z" fill="#5C5C5C"/>
        <circle cx="0" cy="-56" r="3.5" fill="#E24B4A"/>
        <path d="M-15,-37 Q-10,-33 -5,-37" stroke="#3D2B1F" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M5,-37 Q10,-33 15,-37" stroke="#3D2B1F" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
        <path d="M-7,-25 Q0,-19 8,-26" stroke="#7A4530" strokeWidth="2.4" fill="none" strokeLinecap="round"/>
      </g>
    );
    if (mood === "worried") return (
      <g transform={`scale(${scale})`}>
        <path d="M-26,-14 L-32,34 L-6,30 L-9,-9 Z" fill="#7A1F1F"/>
        <path d="M-40,-12 Q-50,4 -40,22 Q-30,4 -40,-12 Z" fill="#5C5C5C" transform="rotate(-8 -40 5)"/>
        <path d="M-40,-8 Q-46,4 -40,18 Q-34,4 -40,-8 Z" fill="#E24B4A" transform="rotate(-8 -40 5)"/>
        <rect x="27" y="14" width="7" height="38" fill="#C9D1D9" transform="rotate(-10 30 33)"/>
        <path d="M-22,-16 Q0,-24 22,-16 L20,24 Q0,30 -20,24 Z" fill="#E24B4A"/>
        <circle cx="0" cy="-34" r="22" fill="#F0C8A0" transform="rotate(-3 0 -34)"/>
        <path d="M-25,-44 Q0,-58 25,-44 Q25,-48 0,-52 Q-25,-48 -25,-44 Z" fill="#5C5C5C"/>
        <path d="M-15,-42 L-5,-37" stroke="#3D2B1F" strokeWidth="2.6" strokeLinecap="round"/>
        <path d="M15,-42 L5,-37" stroke="#3D2B1F" strokeWidth="2.6" strokeLinecap="round"/>
        <circle cx="-8" cy="-32" r="3.2" fill="#0D1117"/>
        <circle cx="8" cy="-32" r="3.2" fill="#0D1117"/>
        <path d="M-7,-21 Q0,-25 7,-21" stroke="#7A4530" strokeWidth="2" fill="none" strokeLinecap="round"/>
        <path d="M-22,-26 Q-19,-20 -22,-15" fill="#7DD3E0"/>
      </g>
    );
    return (
      <g transform={`scale(${scale})`}>
        <path d="M-28,-14 L-36,40 L-6,34 L-10,-10 Z" fill="#7A1F1F"/>
        <path d="M-46,-14 Q-56,4 -46,24 Q-36,4 -46,-14 Z" fill="#5C5C5C"/>
        <path d="M-46,-10 Q-52,4 -46,20 Q-40,4 -46,-10 Z" fill="#E24B4A"/>
        <rect x="-40" y="-10" width="11" height="22" rx="3" fill="#A12E2E"/>
        <rect x="22" y="-12" width="11" height="24" rx="3" fill="#A12E2E"/>
        <rect x="25" y="-44" width="7" height="50" fill="#C9D1D9"/>
        <path d="M-24,-18 Q0,-26 24,-18 L21,28 Q0,36 -21,28 Z" fill="#E24B4A"/>
        <circle cx="0" cy="-38" r="22" fill="#F0C8A0"/>
        <path d="M-25,-48 Q0,-62 25,-48 Q25,-52 0,-56 Q-25,-52 -25,-48 Z" fill="#5C5C5C"/>
        <circle cx="0" cy="-58" r="3.5" fill="#E24B4A"/>
        <path d="M-15,-40 L-6,-38" stroke="#3D2B1F" strokeWidth="2.4" strokeLinecap="round"/>
        <path d="M15,-40 L6,-38" stroke="#3D2B1F" strokeWidth="2.4" strokeLinecap="round"/>
        <circle cx="-9" cy="-34" r="3" fill="#0D1117"/>
        <circle cx="9" cy="-34" r="3" fill="#0D1117"/>
        <rect x="-6" y="-23" width="12" height="2.5" fill="#7A4530"/>
      </g>
    );
  }
  // npc2
  if (mood === "happy") return (
    <g transform={`scale(${scale})`}>
      <path d="M-14,-10 L-22,20 L-5,17 L-7,-6 Z" fill="#1D7A4A" transform="rotate(10 -14 8)"/>
      <path d="M-10,-12 L-24,-26 L-18,-32 L-6,-18 Z" fill="#1D7A4A"/>
      <path d="M-32,-38 Q-37,-30 -32,-22 Q-27,-30 -32,-38 Z" fill="#3FB950" transform="rotate(-20 -32 -30)"/>
      <path d="M10,-12 L24,-28 L18,-34 L6,-18 Z" fill="#1D7A4A"/>
      <rect x="16" y="-54" width="3" height="26" fill="#E9EEF3" transform="rotate(10 17 -41)"/>
      <path d="M-13,-14 Q0,-19 13,-14 L12,16 Q0,21 -11,16 Z" fill="#3FB950"/>
      <circle cx="0" cy="-28" r="16" fill="#F4D1A8"/>
      <path d="M-17,-30 Q-19,-44 0,-47 Q19,-44 17,-30 Q12,-37 5,-34 Q0,-39 -5,-34 Q-12,-37 -17,-30 Z" fill="#2B5C3D"/>
      <path d="M-18,-34 Q0,-42 18,-34" stroke="#1D7A4A" strokeWidth="3" fill="none" strokeLinecap="round"/>
      <path d="M-11,-26 Q-7,-22 -3,-26" stroke="#0D1117" strokeWidth="2.2" fill="none" strokeLinecap="round"/>
      <circle cx="7" cy="-25" r="3.4" fill="#0D1117"/>
      <path d="M-5,-16 Q0,-11 6,-17" stroke="#C0805A" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
    </g>
  );
  if (mood === "worried") return (
    <g transform={`scale(${scale})`}>
      <path d="M-13,-10 L-17,20 L-5,17 L-6,-6 Z" fill="#1D7A4A"/>
      <path d="M-22,-6 Q-27,2 -22,10 Q-17,2 -22,-6 Z" fill="#C9D1D9" transform="rotate(-10 -22 2)"/>
      <path d="M-22,-4 Q-25,2 -22,8 Q-19,2 -22,-4 Z" fill="#3FB950" transform="rotate(-10 -22 2)"/>
      <rect x="17" y="10" width="3" height="22" fill="#E9EEF3" transform="rotate(-16 18 21)"/>
      <path d="M-13,-10 Q0,-15 13,-10 L11,18 Q0,22 -11,18 Z" fill="#3FB950"/>
      <circle cx="0" cy="-24" r="16" fill="#F4D1A8" transform="rotate(-5 0 -24)"/>
      <path d="M-17,-26 Q-19,-40 0,-43 Q19,-40 17,-26 Q12,-33 5,-30 Q0,-35 -5,-30 Q-12,-33 -17,-26 Z" fill="#2B5C3D"/>
      <path d="M-18,-30 Q0,-38 18,-30" stroke="#1D7A4A" strokeWidth="3" fill="none" strokeLinecap="round"/>
      <circle cx="-7" cy="-21" r="3.8" fill="#0D1117"/>
      <circle cx="7" cy="-21" r="3.8" fill="#0D1117"/>
      <path d="M-11,-29 L-4,-26" stroke="#1D4D2F" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M11,-29 L4,-26" stroke="#1D4D2F" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M-3,-12 Q0,-15 3,-12" stroke="#C0805A" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
      <path d="M12,-26 Q15,-21 12,-17" fill="#7DD3E0"/>
    </g>
  );
  return (
    <g transform={`scale(${scale})`}>
      <path d="M-14,-10 L-19,22 L-5,19 L-7,-6 Z" fill="#1D7A4A"/>
      <path d="M-26,-8 Q-31,2 -26,12 Q-21,2 -26,-8 Z" fill="#C9D1D9"/>
      <path d="M-26,-6 Q-29,2 -26,10 Q-23,2 -26,-6 Z" fill="#3FB950"/>
      <rect x="-23" y="-6" width="7" height="14" rx="2" fill="#1D7A4A"/>
      <rect x="16" y="-7" width="7" height="14" rx="2" fill="#1D7A4A"/>
      <rect x="19" y="-26" width="3" height="28" fill="#E9EEF3"/>
      <path d="M-15,-12 Q0,-17 15,-12 L13,18 Q0,23 -13,18 Z" fill="#3FB950"/>
      <circle cx="0" cy="-26" r="16" fill="#F4D1A8"/>
      <path d="M-18,-32 Q0,-40 18,-32" stroke="#1D7A4A" strokeWidth="3" fill="none" strokeLinecap="round"/>
      <circle cx="-7" cy="-23" r="3.4" fill="#0D1117"/>
      <circle cx="7" cy="-23" r="3.4" fill="#0D1117"/>
      <path d="M-4,-14 Q0,-11 5,-15" stroke="#C0805A" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
    </g>
  );
}

// ============================================================
// BATTLE BOARD SCENE：陣取り合戦・専用フルスクリーンシーン
// 1本の横長バーを[NPC1陣地][あなた陣地][NPC2陣地][未開拓]の順に分割し、
// 各陣営の境界（陣地の最前線）にキャラクターを立たせる。
// 陣地が伸び縮みするとキャラの立ち位置も連動して動くため、
// 「押し込んでいる/押し込まれている」が直感的に伝わる。
// ============================================================
function BattleBoardScene({ npcs, prevPlayerStores, finalPlayerStores, competResult, market, quarter, onContinue }) {
  const cr = competResult || {};
  const BAND_COLORS = { player:"#00C8D4", npc1:"#E24B4A", npc2:"#3FB950", none:"#30363D" };

  const totalAvail = Math.max(1, Math.floor(market.totalStores * marketPenetration(quarter)));
  const npc1 = npcs[0], npc2 = npcs[1];
  const npc1Stores = Math.floor(npc1?.ops.stores) || 0;
  const npc2Stores = Math.floor(npc2?.ops.stores) || 0;

  const prevNpc1Stores = Math.max(0, npc1Stores - (cr.stolenBreakdown?.[npc1?.id]||0) + (cr.lostBreakdown?.[npc1?.id]||0));
  const prevNpc2Stores = Math.max(0, npc2Stores - (cr.stolenBreakdown?.[npc2?.id]||0) + (cr.lostBreakdown?.[npc2?.id]||0));

  // 各陣営の幅(%)を計算：[NPC1][あなた][NPC2][未開拓]の順で並べる
  function calcWidths(playerS, npc1S, npc2S) {
    const sum = playerS + npc1S + npc2S;
    const claimed = Math.min(100, (sum/totalAvail)*100);
    if (sum === 0) return { npc1:0, player:0, npc2:0, none:100 };
    const npc1Pct = claimed * (npc1S/sum);
    const playerPct = claimed * (playerS/sum);
    const npc2Pct = claimed * (npc2S/sum);
    const nonePct = Math.max(0, 100 - npc1Pct - playerPct - npc2Pct);
    return { npc1:npc1Pct, player:playerPct, npc2:npc2Pct, none:nonePct };
  }

  const prevW = calcWidths(prevPlayerStores, prevNpc1Stores, prevNpc2Stores);
  const finalW = calcWidths(finalPlayerStores, npc1Stores, npc2Stores);

  const events = [
    cr.stolenBreakdown?.[npc1?.id] > 0 && { from:"npc1", to:"player", amount:cr.stolenBreakdown[npc1.id], label:`${npc1?.name}から奪取` },
    cr.stolenBreakdown?.[npc2?.id] > 0 && { from:"npc2", to:"player", amount:cr.stolenBreakdown[npc2.id], label:`${npc2?.name}から奪取` },
    cr.lostBreakdown?.[npc1?.id] > 0 && { from:"player", to:"npc1", amount:cr.lostBreakdown[npc1.id], label:`${npc1?.name}へ流出` },
    cr.lostBreakdown?.[npc2?.id] > 0 && { from:"player", to:"npc2", amount:cr.lostBreakdown[npc2.id], label:`${npc2?.name}へ流出` },
    (cr.newFromUnclaimed||0) > 0 && { from:"none", to:"player", amount:cr.newFromUnclaimed, label:"新規開拓" },
  ].filter(Boolean);

  const [eventIdx, setEventIdx] = useState(-1);
  const [showFinal, setShowFinal] = useState(false);

  useEffect(() => {
    setEventIdx(-1);
    setShowFinal(false);
    if (events.length === 0) {
      const t = setTimeout(() => setShowFinal(true), 600);
      return () => clearTimeout(t);
    }
    let i = 0;
    const timer = setInterval(() => {
      setEventIdx(i);
      i++;
      if (i > events.length) {
        clearInterval(timer);
        setShowFinal(true);
      }
    }, 1100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarter]);

  const w = showFinal ? finalW : prevW;

  const moodFor = (prev, fin) => fin > prev ? "happy" : fin < prev ? "worried" : "normal";
  const playerMood = showFinal ? moodFor(prevPlayerStores, finalPlayerStores) : "normal";
  const npc1Mood = showFinal ? moodFor(prevNpc1Stores, npc1Stores) : "normal";
  const npc2Mood = showFinal ? moodFor(prevNpc2Stores, npc2Stores) : "normal";

  const currentEvent = eventIdx >= 0 && eventIdx < events.length ? events[eventIdx] : null;

  // 各陣営の「境界位置」（バー上の%）：左から[NPC1][あなた][NPC2][未開拓]の順
  const npc1End = w.npc1;
  const playerEnd = w.npc1 + w.player;
  const npc2End = w.npc1 + w.player + w.npc2;

  const barHeight = 56;

  return (
    <div style={bgBase}>
      <div style={{maxWidth:520, margin:"0 auto", padding:"32px 20px", minHeight:"100vh", display:"flex", flexDirection:"column"}}>
        <div style={{textAlign:"center", marginBottom:24}}>
          <div style={{fontSize:11, letterSpacing:4, color:C.purple, marginBottom:6}}>BATTLEFIELD</div>
          <h2 style={{fontSize:20, fontWeight:900, color:C.text, margin:0}}>⚔️ 市場争奪戦</h2>
          <p style={{fontSize:10, color:C.muted, marginTop:4}}>陣地の境界に立つキャラが、押し合いの最前線を示す</p>
        </div>

        {/* 陣取りバー本体 */}
        <div style={{position:"relative", width:"100%", height:barHeight, marginTop:60, marginBottom:50}}>
          {/* バー：NPC1 → あなた → NPC2 → 未開拓 の順に並ぶ */}
          <div style={{position:"absolute", left:0, top:0, width:"100%", height:barHeight, borderRadius:10, overflow:"hidden", display:"flex", border:`1px solid ${C.border}`}}>
            <div style={{width:`${w.npc1}%`, background:BAND_COLORS.npc1, transition:"width 0.8s cubic-bezier(0.22,1,0.36,1)", height:"100%"}}/>
            <div style={{width:`${w.player}%`, background:BAND_COLORS.player, transition:"width 0.8s cubic-bezier(0.22,1,0.36,1)", height:"100%"}}/>
            <div style={{width:`${w.npc2}%`, background:BAND_COLORS.npc2, transition:"width 0.8s cubic-bezier(0.22,1,0.36,1)", height:"100%"}}/>
            <div style={{width:`${w.none}%`, background:BAND_COLORS.none, transition:"width 0.8s cubic-bezier(0.22,1,0.36,1)", height:"100%"}}/>
          </div>

          {/* NPC1キャラ：NPC1陣地の右端（あなたとの境界）に立つ */}
          <div style={{
            position:"absolute", top:-58, left:`${npc1End}%`, transform:"translateX(-50%)",
            transition:"left 0.8s cubic-bezier(0.22,1,0.36,1)", textAlign:"center", zIndex:3,
          }}>
            <svg width="50" height="58" viewBox="-40 -68 80 88"><CharacterSprite type="npc1" mood={npc1Mood} scale={0.68}/></svg>
            <div style={{fontSize:9, color:BAND_COLORS.npc1, fontWeight:700, whiteSpace:"nowrap"}}>{npc1?.name||"競合1"}</div>
          </div>

          {/* あなたキャラ：あなた陣地の右端（NPC2との境界）に立つ */}
          <div style={{
            position:"absolute", top:-72, left:`${playerEnd}%`, transform:"translateX(-50%)",
            transition:"left 0.8s cubic-bezier(0.22,1,0.36,1)", textAlign:"center", zIndex:4,
          }}>
            <svg width="62" height="72" viewBox="-45 -75 90 95"><CharacterSprite type="player" mood={playerMood} scale={0.88}/></svg>
            <div style={{fontSize:10, color:BAND_COLORS.player, fontWeight:700, whiteSpace:"nowrap"}}>あなた</div>
          </div>

          {/* NPC2キャラ：NPC2陣地の右端（未開拓との境界）に立つ */}
          <div style={{
            position:"absolute", top:-58, left:`${npc2End}%`, transform:"translateX(-50%)",
            transition:"left 0.8s cubic-bezier(0.22,1,0.36,1)", textAlign:"center", zIndex:3,
          }}>
            <svg width="46" height="54" viewBox="-30 -55 60 75"><CharacterSprite type="npc2" mood={npc2Mood} scale={0.62}/></svg>
            <div style={{fontSize:9, color:BAND_COLORS.npc2, fontWeight:700, whiteSpace:"nowrap"}}>{npc2?.name||"競合2"}</div>
          </div>

          {/* 各陣地の店舗数ラベル（バーの下） */}
          {showFinal && (
            <div style={{position:"absolute", top:barHeight+8, left:0, width:"100%", display:"flex", fontSize:10}}>
              <div style={{width:`${w.npc1}%`, textAlign:"center", color:BAND_COLORS.npc1, fontWeight:700}}>
                {w.npc1>5 && `${npc1Stores}店`}
              </div>
              <div style={{width:`${w.player}%`, textAlign:"center", color:BAND_COLORS.player, fontWeight:700}}>
                {w.player>5 && `${finalPlayerStores}店`}
              </div>
              <div style={{width:`${w.npc2}%`, textAlign:"center", color:BAND_COLORS.npc2, fontWeight:700}}>
                {w.npc2>5 && `${npc2Stores}店`}
              </div>
            </div>
          )}
        </div>

        {/* 各陣営の店舗数サマリー（バーが狭すぎてラベルが入らない場合の保険も兼ねる） */}
        {showFinal && (
          <div className="sb-popin" style={{display:"flex", justifyContent:"space-around", marginTop:20, marginBottom:10}}>
            {[
              {name:npc1?.name||"競合1", prev:prevNpc1Stores, fin:npc1Stores, color:BAND_COLORS.npc1},
              {name:"あなた", prev:prevPlayerStores, fin:finalPlayerStores, color:BAND_COLORS.player},
              {name:npc2?.name||"競合2", prev:prevNpc2Stores, fin:npc2Stores, color:BAND_COLORS.npc2},
            ].map(r => {
              const diff = r.fin - r.prev;
              return (
                <div key={r.name} style={{textAlign:"center"}}>
                  <div style={{fontSize:10, color:r.color, fontWeight:700, marginBottom:4}}>{r.name}</div>
                  <div style={{fontSize:18, fontWeight:900, color:C.text, fontFamily:"'Courier New',monospace"}}>{r.fin}店</div>
                  <div style={{fontSize:11, fontWeight:700, color: diff>=0?C.green:C.red}}>{diff>=0?"+":""}{diff}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* 奪取イベントの矢印＋テキスト */}
        {currentEvent && (
          <div className="sb-popin" style={{
            marginTop:14, background:"#0D1117", border:`2px solid ${currentEvent.to==="player"?C.green:C.red}`,
            borderRadius:10, padding:"12px 16px", textAlign:"center",
          }}>
            <div style={{fontSize:20}}>{currentEvent.to==="player" ? "⚔️" : "📤"}</div>
            <div style={{fontSize:12, fontWeight:700, color: currentEvent.to==="player"?C.green:C.red}}>
              {currentEvent.label}
            </div>
            <div style={{fontSize:16, fontWeight:900, color:C.text, fontFamily:"'Courier New',monospace"}}>
              {currentEvent.to==="player" ? "+" : "-"}{currentEvent.amount}店
            </div>
          </div>
        )}

        {/* 進行状況ドット */}
        {!showFinal && (
          <div style={{display:"flex", justifyContent:"center", gap:6, marginTop:14}}>
            {events.length === 0
              ? <div style={{fontSize:11, color:C.muted}}>大きな変動なし...</div>
              : events.map((_, i) => (
                  <div key={i} style={{
                    width:7, height:7, borderRadius:"50%",
                    background: i <= eventIdx ? C.cyan : C.border,
                    transition:"background 0.3s",
                  }}/>
                ))
            }
          </div>
        )}

        {showFinal && (
          <button onClick={onContinue} style={{
            marginTop:20, width:"100%", padding:14, borderRadius:10, border:"none",
            background:`linear-gradient(135deg,#006080,${C.cyan})`, color:"#fff",
            fontSize:14, fontWeight:700, cursor:"pointer", letterSpacing:2,
          }}>
            決算を確認する →
          </button>
        )}

        {!showFinal && (
          <div style={{textAlign:"center", marginTop:16}}>
            <button onClick={() => setShowFinal(true)} style={{
              background:"none", border:"none", color:C.muted, fontSize:11,
              cursor:"pointer", opacity:0.6, textDecoration:"underline",
            }}>
              スキップ
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BattleResultCard({ competResult, prevStores, finalStores }) {
  const cr = competResult || {};
  const newU = cr.newFromUnclaimed || 0;
  const stolen = cr.stolenFromRivals || 0;
  const churn = cr.naturalChurn || 0;
  const lost = cr.lostToRivals || 0;
  const netChange = finalStores - prevStores;
  const isPositive = netChange >= 0;

  const events = [
    newU > 0 && { icon:"🌱", label:"新規開拓", value:newU, color:C.green, sign:"+" },
    stolen > 0 && { icon:"⚔️", label:"競合から奪取", value:stolen, color:C.cyan, sign:"+" },
    churn > 0 && { icon:"💔", label:"自然解約", value:churn, color:C.orange, sign:"-" },
    lost > 0 && { icon:"📤", label:"競合に流出", value:lost, color:C.red, sign:"-" },
  ].filter(Boolean);

  return (
    <Panel style={{marginBottom:14, overflow:"hidden", position:"relative"}}>
      <Label style={{display:"block",marginBottom:12}}>⚔️ 今期の戦況</Label>

      <div className="sb-popin" style={{
        textAlign:"center", padding:"16px 0", marginBottom:14,
        background: isPositive ? `${C.green}10` : `${C.red}10`,
        border: `1px solid ${isPositive ? C.green : C.red}33`,
        borderRadius:12,
      }}>
        <div style={{fontSize:11, color:C.muted, marginBottom:4}}>店舗数の変化</div>
        <div style={{fontSize:36, fontWeight:900, fontFamily:"'Courier New',monospace"}}>
          <CountUpNumber
            target={Math.abs(netChange)}
            prefix={isPositive ? "+" : "-"}
            suffix="店"
            color={isPositive ? C.green : C.red}
            duration={900}
          />
        </div>
        <div style={{fontSize:12, color:C.muted, marginTop:4}}>
          {prevStores}店 → <CountUpNumber target={finalStores} duration={900} color={C.text}/>店
        </div>
      </div>

      <div style={{display:"grid", gap:8}}>
        {events.map((ev, i) => (
          <div key={ev.label} style={{
            display:"flex", alignItems:"center", gap:10,
            opacity:0,
            animation:`slideInRight 0.4s ease-out ${i*0.12}s forwards`,
          }}>
            <span style={{fontSize:18, flexShrink:0}}>{ev.icon}</span>
            <span style={{fontSize:12, color:C.muted, width:88, flexShrink:0}}>{ev.label}</span>
            <div style={{flex:1, height:8, background:C.border, borderRadius:4, overflow:"hidden", position:"relative"}}>
              <div className="sb-bar-fill" style={{
                height:"100%",
                width:`${Math.min(100, ev.value*4)}%`,
                background: ev.color,
                borderRadius:4,
              }}/>
            </div>
            <span style={{fontSize:13, fontWeight:800, color:ev.color, width:42, textAlign:"right", flexShrink:0, fontFamily:"'Courier New',monospace"}}>
              {ev.sign}{ev.value}
            </span>
          </div>
        ))}
        {events.length === 0 && (
          <div style={{textAlign:"center", fontSize:12, color:C.muted, padding:"8px 0"}}>
            大きな変動はありませんでした
          </div>
        )}
      </div>
    </Panel>
  );
}

function MarketShareChart({ players, market, quarter }) {
  const totalAvail = Math.floor(market.totalStores * marketPenetration(quarter));
  // ★ storesを必ず整数に正規化してNaN伝播を防ぐ
  const safePlayers = players.map(p => ({...p, stores: Math.floor(Number(p.stores) || 0)}));
  const totalStores = safePlayers.reduce((s, p) => s + p.stores, 0);
  const unclaimed = Math.max(0, totalAvail - totalStores);
  const total = totalStores + unclaimed;
  if (total === 0) return null;
  const segments = [
    ...safePlayers.map(p => ({ label: p.name, stores: p.stores, color: p.color, isPlayer: p.isPlayer })),
    { label: "未獲得", stores: unclaimed, color: "#30363D", isPlayer: false },
  ].filter(s => s.stores > 0);
  const cx = 80, cy = 80, r = 65;
  let currentAngle = -Math.PI / 2;
  const paths = segments.map(seg => {
    const frac = total > 0 ? seg.stores / total : 0; // ★ ゼロ除算ガード
    const angle = frac * 2 * Math.PI;
    const x1 = cx + r * Math.cos(currentAngle);
    const y1 = cy + r * Math.sin(currentAngle);
    currentAngle += angle;
    const x2 = cx + r * Math.cos(currentAngle);
    const y2 = cy + r * Math.sin(currentAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    return { path: `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`, ...seg, frac };
  });
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <svg width={160} height={160} style={{ flexShrink: 0 }}>
        {paths.map((seg, i) => (
          <path key={`${quarter}-${i}`} className="sb-pie-seg" d={seg.path} fill={seg.color}
            stroke={seg.isPlayer ? "#fff" : "transparent"} strokeWidth={seg.isPlayer ? 2 : 0}
            opacity={seg.label === "未獲得" ? 0.3 : 0.9} />
        ))}
        <circle cx={cx} cy={cy} r={28} fill="#161B22" />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#F0F6FC" fontSize={11} fontWeight={700}>
          <CountUpNumber target={totalStores} duration={700} svgMode suffix="店"/>
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fill="#8B949E" fontSize={9}>獲得済</text>
      </svg>
      <div style={{ flex: 1, display: "grid", gap: 6 }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: seg.color, flexShrink: 0, opacity: seg.label === "未獲得" ? 0.4 : 1 }} />
            <span style={{ fontSize: 11, color: seg.isPlayer ? "#F0F6FC" : "#8B949E", fontWeight: seg.isPlayer ? 700 : 400, flex: 1 }}>
              {seg.isPlayer ? "▶ " : ""}{seg.label}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: seg.color, fontFamily: "'Courier New',monospace" }}>
              {seg.stores}店 ({isNaN(seg.frac) ? "0.0" : (seg.frac * 100).toFixed(1)}%)
            </span>
          </div>
        ))}
        <div style={{ marginTop: 4, fontSize: 10, color: "#8B949E" }}>市場総数 {totalAvail}店中</div>
      </div>
    </div>
  );
}
const C = {
  bg:"#0D1117", panel:"#161B22", border:"#30363D",
  cyan:"#00C8D4", green:"#3FB950", red:"#F85149",
  yellow:"#E3B341", purple:"#D2A8FF", orange:"#FFA657",
  text:"#F0F6FC", muted:"#8B949E",
};

const Label = ({children,style={}}) => (
  <span style={{fontSize:10,letterSpacing:3,textTransform:"uppercase",color:C.muted,...style}}>{children}</span>
);
const Num = ({v,unit="",plus=false,style={}}) => {
  const val = typeof v==="number" ? v.toLocaleString() : v;
  const color = plus ? (v>=0?C.green:C.red) : C.text;
  return <span style={{fontFamily:"'Courier New',monospace",fontWeight:800,color,...style}}>
    {plus&&v>0?"+":" "}{val}<span style={{fontSize:"0.65em",color:C.muted,marginLeft:2}}>{unit}</span>
  </span>;
};
const Bar = ({value,color,max=100,showVal=false}) => (
  <div style={{position:"relative"}}>
    <div style={{background:C.border,borderRadius:3,height:6,overflow:"hidden"}}>
      <div style={{width:`${Math.min(100,Math.max(0,value)/max*100)}%`,height:"100%",
        background:`linear-gradient(90deg,${color}88,${color})`,borderRadius:3,transition:"width 0.4s",
        boxShadow:`0 0 6px ${color}66`}}/>
    </div>
    {showVal && <span style={{position:"absolute",right:0,top:-16,fontSize:10,color,fontWeight:700}}>{value}</span>}
  </div>
);
const Panel = ({children,style={}}) => (
  <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:16,...style}}>{children}</div>
);
const PhaseTag = ({phase}) => (
  <span style={{fontSize:10,padding:"2px 10px",borderRadius:20,background:`${phase.color}22`,
    color:phase.color,fontWeight:700,letterSpacing:1}}>{phase.icon} {phase.name}</span>
);

// ============================================================
// BUDGET ALLOCATOR — スライダーUI + 前回値保持
// ============================================================
function BudgetAllocator({ availableBudget, allocation, onChange, bs, playerType, ops }) {
  const total = BUDGET_ITEMS.reduce((s,item)=>s+(allocation[item.id]||0),0);
  const remaining = availableBudget - total;
  const pt = PLAYER_TYPES[playerType];
  const safetyBuffer = pt ? pt.baseOpex * 2 : 0;
  const freeCash = bs ? Math.max(0, bs.cash - safetyBuffer) : 0;
  const fromCash = Math.floor(freeCash * (pt?.investRatio || 0.1));
  const eff = pt?.investEfficiency || 1.0;

  const setItem = (id, rawVal) => {
    const stepped = Math.round(rawVal / 10) * 10;
    const val = Math.max(0, Math.min(availableBudget, stepped));
    const otherTotal = total - (allocation[id] || 0);
    const clamped = Math.min(val, availableBudget - otherTotal);
    const next = { ...allocation, [id]: clamped };
    if (id === "dev" && clamped === 0) delete next.devFocus; // devを0にしたら方向性選択もクリア
    onChange(next);
  };

  return (
    <div>
      <div style={{marginBottom:12,padding:"10px 14px",background:C.bg,borderRadius:8,border:`1px solid ${C.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <Label>今Q配分可能額</Label>
          <span style={{fontSize:15,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{availableBudget}万</span>
        </div>
        <div style={{fontSize:10,color:C.muted}}>
          現預金¥{bs?.cash||0}万 × {Math.round((pt?.investRatio||0.1)*100)}%（安全バッファ¥{safetyBuffer}万控除後）＝¥{fromCash}万 ＋ FCF寄与
        </div>
        <div style={{marginTop:6,display:"flex",justifyContent:"space-between"}}>
          <Label>配分済み</Label>
          <span style={{fontSize:12,fontWeight:800,fontFamily:"'Courier New',monospace",
            color:remaining<0?C.red:remaining===0?C.green:C.yellow}}>
            ¥{total}万 / ¥{availableBudget}万（残 ¥{remaining}万）
          </span>
        </div>
        <div style={{marginTop:6,background:C.border,borderRadius:3,height:4,overflow:"hidden"}}>
          <div style={{width:`${Math.min(100,total/Math.max(availableBudget,1)*100)}%`,height:"100%",
            background:remaining<0?C.red:C.cyan,borderRadius:3,transition:"width 0.2s"}}/>
        </div>
      </div>
      <div style={{marginBottom:10,padding:"8px 12px",background:`${C.purple}10`,border:`1px solid ${C.purple}33`,borderRadius:8,display:"flex",gap:8,alignItems:"center"}}>
        <span style={{fontSize:14}}>⏳</span>
        <span style={{fontSize:10,color:C.muted}}>営業・開発・CSは<b style={{color:C.purple}}>来Qから</b>反映。<b style={{color:C.yellow}}>マーケは今Qから即時反映</b>されます</span>
      </div>
      <div style={{display:"grid",gap:8}}>
        {BUDGET_ITEMS.map(item => {
          const val = allocation[item.id] || 0;
          // ★ 現在のパラメータ値を使って正確な逓減計算
          const currentParamVal = ops?.[item.param] || 0;
          const gain = val > 0
            ? calcParamGain(currentParamVal, item.basePer100, val, eff)
            : -item.decay;
          // パラメータ名の日本語マッピング
          const paramLabels = {
            salesPower:"営業力", solutionQuality:"品質",
            brandAwareness:"ブランド", supportQuality:"CS"
          };
          return (
            <div key={item.id} style={{background:C.bg,borderRadius:10,padding:"10px 14px",
              border:`1px solid ${val>0?item.color+"55":C.border}`,transition:"border-color 0.2s"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <span style={{fontSize:18}}>{item.icon}</span>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:13,fontWeight:700,color:val>0?item.color:C.text}}>{item.name}</span>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      {item.capitalize && <span style={{fontSize:9,color:C.purple,letterSpacing:1}}>資産計上</span>}
                      <span style={{fontSize:14,fontWeight:900,color:val>0?item.color:C.muted,fontFamily:"'Courier New',monospace"}}>
                        ¥{val}万
                      </span>
                    </div>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2}}>
                    <span style={{fontSize:10,color:C.muted}}>{item.desc}</span>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                      <span style={{fontSize:11,fontWeight:700,color:gain>0?C.green:C.red}}>
                        {item.immediate ? "今Q" : "来Q"} {paramLabels[item.param]||item.param} {gain>0?"+":""}{Number(gain).toFixed(1)}
                      </span>
                      {item.capitalize && <span style={{fontSize:9,color:C.purple}}>資産計上（PL影響なし）</span>}
                    </div>
                  </div>
                </div>
              </div>
              <input
                type="range" min={0} max={availableBudget} step={10} value={val}
                onChange={e => setItem(item.id, Number(e.target.value))}
                onTouchStart={e => e.stopPropagation()}
                onTouchMove={e => e.stopPropagation()}
                style={{
                  width:"100%", height:28, cursor:"pointer", accentColor: item.color,
                  background:`linear-gradient(to right, ${item.color} ${val/Math.max(availableBudget,1)*100}%, #30363D ${val/Math.max(availableBudget,1)*100}%)`,
                  borderRadius:2, outline:"none", border:"none",
                  WebkitAppearance:"none", appearance:"none",
                  touchAction:"pan-x",
                }}
              />
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,marginTop:2}}>
                <span>0</span><span>{availableBudget}</span>
              </div>
              {/* ★ devに配分があるとき：顧客価値の方向性を選ぶ（市場ニーズは非公開、当たり外れがある） */}
              {item.id === "dev" && val > 0 && (
                <div style={{marginTop:10, paddingTop:10, borderTop:`1px dashed ${C.border}`}}>
                  <div style={{fontSize:10, color:C.muted, marginBottom:6}}>
                    🎯 どの顧客価値を伸ばす？（市場の反応は来Q判明）
                  </div>
                  <div style={{display:"flex", gap:6}}>
                    {Object.values(DEV_FOCUS_TYPES).map(f => (
                      <button key={f.id}
                        onClick={() => onChange({ ...allocation, devFocus: f.id })}
                        style={{
                          flex:1, padding:"8px 4px", borderRadius:8,
                          border:`1.5px solid ${allocation.devFocus===f.id ? C.purple : C.border}`,
                          background: allocation.devFocus===f.id ? `${C.purple}18` : C.bg,
                          cursor:"pointer", textAlign:"center",
                        }}>
                        <div style={{fontSize:16}}>{f.icon}</div>
                        <div style={{fontSize:9, fontWeight:700, color: allocation.devFocus===f.id ? C.purple : C.muted, marginTop:2}}>
                          {f.name}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// SPECIAL ACTION SELECTOR
// ============================================================
function SpecialActionSelector({ selected, onSelect, usedSpecials, playerType, availableCash, currentPhaseId, bs }) {
  const debtRatioOk = (action) => {
    if (!action.debtGain) return true;
    const newDebt = (bs?.debt || 0) + action.debtGain;
    const cap = (bs?.capital || 1) + (bs?.retainedEarnings || 0);
    return cap > 0 ? newDebt / cap <= 2.0 : false; // 200%上限
  };

  const actions = Object.values(SPECIAL_ACTIONS).filter(a => {
    if (a.startupOnly && playerType !== "startup") return false;
    // フェーズ制限：actionにphaseが指定されている場合、現在フェーズと一致するか前フェーズは解放済みを確認
    if (a.phase) {
      const phaseOrder = { dawn:1, growth:2, mature:3 };
      const actionPhaseNum = phaseOrder[a.phase] || 0;
      const currentPhaseNum = phaseOrder[currentPhaseId] || 0;
      if (actionPhaseNum !== currentPhaseNum) return false;
    }
    return true;
  });
  return (
    <div>
      <Label style={{display:"block",marginBottom:12}}>特別アクション（任意・1枚）</Label>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {actions.map(a => {
          const isUsed  = a.oneTime && usedSpecials.includes(a.id);
          const isSel   = selected === a.id;
          const cantAfford = (a.cost > 0 && availableCash < a.cost) || !debtRatioOk(a);
          const catColor = {sales:C.cyan,dev:C.purple,marketing:C.yellow,price:C.green,funding:C.orange}[a.cat]||C.muted;
          return (
            <div key={a.id} onClick={()=>!isUsed&&!cantAfford&&onSelect(isSel?null:a.id)}
              style={{background:isSel?`${catColor}18`:C.bg,border:`1px solid ${isSel?catColor:isUsed||cantAfford?"#0a1520":C.border}`,
                borderRadius:10,padding:"10px 12px",cursor:isUsed||cantAfford?"not-allowed":"pointer",
                opacity:isUsed||cantAfford?0.4:1,transition:"all 0.18s",
                transform:isSel?"translateY(-1px)":"none"}}>
              <div style={{display:"flex",gap:8,marginBottom:4}}>
                <span style={{fontSize:18}}>{a.icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:isSel?catColor:C.text}}>{a.name}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2,lineHeight:1.4}}>{a.desc}</div>
                </div>
              </div>
              <div style={{textAlign:"right",fontSize:11,fontWeight:800,color:a.cost===0?C.green:C.yellow}}>
                {a.cost===0?"無料":`¥${a.cost}万`}
              </div>
            </div>
          );
        })}
      </div>
      {selected && (
        <div style={{marginTop:10,padding:"8px 14px",background:`${C.cyan}11`,border:`1px solid ${C.cyan}44`,borderRadius:8,fontSize:12,color:C.cyan}}>
          ✓ 選択中: {SPECIAL_ACTIONS[selected]?.name}
        </div>
      )}
    </div>
  );
}

// ============================================================
// BS TABLE
// ============================================================
// ============================================================
// BS BUILD ANIMATION：バランスシートが組まれていく過程を可視化
// ============================================================
function BSBuildAnimation({ bs, quarter }) {
  const [step, setStep] = useState(0);
  const ta = totalAssets(bs), tl = totalLiabilities(bs), eq = equity(bs);

  const assetRows = [
    { label:"現預金", value: bs.cash },
    { label:"ソフトウェア資産", value: bs.softwareAsset },
    { label:"その他資産", value: bs.otherAsset },
  ];
  const liabEqRows = [
    { label:"借入金", value: bs.debt, dim: bs.debt === 0 },
    { label:"資本金", value: bs.capital },
    { label:"利益剰余金", value: bs.retainedEarnings, warn: bs.retainedEarnings < 0 },
  ];
  // ★ ステップ設計：資産3行→負債3行→合計2つ→チェック演出 の計9ステップ
  //   左右を時間差で出すことで「資産が先に組まれ、それを支える負債純資産が後から積まれる」という見せ方にする
  const ASSET_STEPS = assetRows.length;                    // 1〜3
  const LIABEQ_STEPS = ASSET_STEPS + liabEqRows.length;     // 4〜6
  const TOTALS_STEP = LIABEQ_STEPS + 1;                     // 7
  const CHECK_STEP = TOTALS_STEP + 1;                       // 8
  const totalSteps = CHECK_STEP;

  useEffect(() => {
    setStep(0);
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      setStep(current);
      if (current >= totalSteps) clearInterval(timer);
    }, 380);
    return () => clearInterval(timer);
  }, [bs.cash, bs.softwareAsset, bs.retainedEarnings, quarter, totalSteps]);

  const visibleAssets = assetRows.slice(0, Math.min(step, ASSET_STEPS));
  const visibleLiabEq = liabEqRows.slice(0, Math.max(0, Math.min(step - ASSET_STEPS, liabEqRows.length)));
  const showTotals = step >= TOTALS_STEP;
  const showCheck = step >= CHECK_STEP;
  const isDone = step >= totalSteps;

  const rowStyle = (i, list) => ({
    display:"flex", justifyContent:"space-between", padding:"4px 0",
    borderBottom:`1px solid ${C.border}`,
    opacity: i === list.length - 1 ? 0 : 1,
    animation: i === list.length - 1 ? "slideInRight 0.3s ease-out forwards" : "none",
  });

  return (
    <Panel style={{marginBottom:14}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10}}>
        <Label>⚖️ バランスシートを確認</Label>
        {!isDone && (
          <button onClick={() => setStep(totalSteps)} style={{
            background:"none", border:"none", color:C.muted, fontSize:10,
            cursor:"pointer", opacity:0.6, textDecoration:"underline",
          }}>
            スキップ
          </button>
        )}
      </div>

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
        {/* 資産の部 */}
        <div style={{background:C.bg, borderRadius:8, padding:12, border:`1px solid ${C.border}`}}>
          <Label style={{display:"block", marginBottom:8}}>資産の部</Label>
          {visibleAssets.map((r, i) => (
            <div key={r.label} style={rowStyle(i, visibleAssets)}>
              <span style={{fontSize:11, color:C.muted}}>{r.label}</span>
              <span style={{fontSize:11, fontFamily:"'Courier New',monospace", fontWeight:700, color:C.text}}>
                ¥{r.value.toLocaleString()}万
              </span>
            </div>
          ))}
          {showTotals && (
            <div style={{
              display:"flex", justifyContent:"space-between", padding:"8px 0 0", marginTop:4,
              borderTop:`2px solid ${C.cyan}55`, opacity:0,
              animation:"slideInRight 0.35s ease-out forwards",
            }}>
              <span style={{fontSize:12, fontWeight:800, color:C.cyan}}>資産合計</span>
              <span style={{fontSize:14, fontWeight:900, color:C.cyan, fontFamily:"'Courier New',monospace"}}>
                ¥{ta.toLocaleString()}万
              </span>
            </div>
          )}
        </div>

        {/* 負債・純資産の部 */}
        <div style={{background:C.bg, borderRadius:8, padding:12, border:`1px solid ${C.border}`}}>
          <Label style={{display:"block", marginBottom:8}}>負債・純資産の部</Label>
          {visibleLiabEq.map((r, i) => (
            <div key={r.label} style={rowStyle(i, visibleLiabEq)}>
              <span style={{fontSize:11, color:C.muted}}>{r.label}</span>
              <span style={{
                fontSize:11, fontFamily:"'Courier New',monospace", fontWeight:700,
                color: r.warn ? C.red : r.dim ? C.muted : C.text,
              }}>
                ¥{r.value.toLocaleString()}万
              </span>
            </div>
          ))}
          {showTotals && (
            <div style={{
              display:"flex", justifyContent:"space-between", padding:"8px 0 0", marginTop:4,
              borderTop:`2px solid ${C.cyan}55`, opacity:0,
              animation:"slideInRight 0.35s ease-out forwards",
            }}>
              <span style={{fontSize:12, fontWeight:800, color:C.cyan}}>負債純資産合計</span>
              <span style={{fontSize:14, fontWeight:900, color:C.cyan, fontFamily:"'Courier New',monospace"}}>
                ¥{(tl+eq).toLocaleString()}万
              </span>
            </div>
          )}
        </div>
      </div>

      {/* バランスチェック演出：実際の整合性を検証して表示 */}
      {showCheck && (() => {
        const isBalanced = Math.abs(ta - (tl + eq)) < 1; // 四捨五入誤差を許容
        return (
          <div className="sb-popin" style={{
            marginTop:14, textAlign:"center", padding:"10px 0",
            background: isBalanced ? `${C.green}10` : `${C.red}10`,
            border: `1px solid ${isBalanced ? C.green : C.red}33`, borderRadius:10,
          }}>
            <span style={{fontSize:14, fontWeight:900, color: isBalanced ? C.green : C.red}}>
              {isBalanced
                ? "✅ Balanced — 資産合計と負債純資産合計が一致"
                : `⚠️ 不一致を検出（差額¥${(Math.round(ta-(tl+eq)) || 0).toLocaleString()}万）`}
            </span>
          </div>
        );
      })()}

      {!isDone && (
        <div style={{display:"flex", justifyContent:"center", marginTop:10}}>
          <div style={{display:"flex", gap:4}}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width:5, height:5, borderRadius:"50%", background:C.cyan,
                animation:`pulseGlow 0.9s ease-in-out ${i*0.15}s infinite`,
              }}/>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function BSTable({bs}) {
  const ta=totalAssets(bs), tl=totalLiabilities(bs), eq=equity(bs);
  const Row=({label,val,bold,color})=>(
    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${C.border}`,fontWeight:bold?800:400}}>
      <span style={{fontSize:11,color:bold?C.text:C.muted}}>{label}</span>
      <Num v={val} unit="万" style={{fontSize:11,color:color||(bold?C.cyan:val<0?C.red:C.text)}}/>
    </div>
  );
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <Panel style={{padding:12}}>
        <Label style={{display:"block",marginBottom:8}}>資産の部</Label>
        <Row label="現預金" val={bs.cash}/>
        <Row label="ソフトウェア資産" val={bs.softwareAsset}/>
        <Row label="その他資産" val={bs.otherAsset}/>
        <Row label="【資産合計】" val={ta} bold color={C.cyan}/>
      </Panel>
      <Panel style={{padding:12}}>
        <Label style={{display:"block",marginBottom:8}}>負債・純資産の部</Label>
        <Row label="借入金" val={bs.debt} color={bs.debt>0?C.yellow:C.muted}/>
        <Row label="【負債合計】" val={tl} bold/>
        <Row label="資本金" val={bs.capital}/>
        <Row label="利益剰余金" val={bs.retainedEarnings} color={bs.retainedEarnings>=0?C.green:C.red}/>
        <Row label="【純資産合計】" val={eq} bold color={eq>=0?C.green:C.red}/>
        <Row label="【負債純資産合計】" val={tl+eq} bold color={C.cyan}/>
      </Panel>
      <Panel style={{gridColumn:"span 2",padding:"10px 16px"}}>
        <div style={{display:"flex",gap:20,justifyContent:"center",flexWrap:"wrap"}}>
          {[["🏦 総資産",`¥${ta.toLocaleString()}万`,C.cyan,true],
            ["💚 自己資本比率",`${ta>0?(eq/ta*100).toFixed(1):0}%`,C.green],
            ["⚖️ D/Eレシオ",`${eq>0?(bs.debt/eq).toFixed(2):"∞"}x`,C.yellow],
            ["📈 ROE",`${roe(bs)}%`,C.purple]
          ].map(([l,v,c,h])=>(
            <div key={l} style={{textAlign:"center"}}>
              <div style={{fontSize:h?16:14,fontWeight:900,color:c,fontFamily:"'Courier New',monospace"}}>{v}</div>
              <Label>{l}</Label>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ============================================================
// PL TABLE
// ============================================================
// ============================================================
// PL BUILD ANIMATION：決算が組まれていく過程を可視化
// ============================================================
function PLBuildAnimation({ pl, quarter, onComplete }) {
  const [step, setStep] = useState(0);

  // 投資項目の内訳（資産計上分=devを除く費用化された項目）
  const allocDetail = BUDGET_ITEMS
    .filter(item => !item.capitalize && (pl.playerAlloc?.[item.id] || 0) > 0)
    .map(item => ({ name: item.name, icon: item.icon, amount: pl.playerAlloc[item.id] }));

  const stores = pl.competResult?.finalStores || 0;
  const arpu = pl.market?.arpu;
  const priceMultiplier = pl.priceMultiplier || 1.0;
  // ★ 値上げ時、価格に敏感な一部の顧客には旧価格のまま引き留め交渉が発生する想定。
  // negotiatedRatio = 交渉に応じた（旧価格のままになった）顧客の割合
  const negotiatedRatio = priceMultiplier <= 1 ? 0 : Math.min(0.65, (priceMultiplier - 1) * 0.35);
  const effectiveMultiplier = negotiatedRatio * 1.0 + (1 - negotiatedRatio) * priceMultiplier;
  const effectiveUnitPrice = arpu ? Math.round(arpu * effectiveMultiplier * 10) / 10 : null;
  const setPrice = pl.setPrice ?? (arpu ? Math.round(arpu * priceMultiplier) : null);
  const isDiminished = priceMultiplier > 1;
  const negotiatedStores = Math.round(stores * negotiatedRatio);

  // 表示する行（小計を都度計算）。detail: 補足説明（小さい文字で内訳を出す）
  const rows = [
    { label:"売上高", value: pl.revenue, kind:"plus",
      detail: (stores && effectiveUnitPrice)
        ? (isDiminished
            ? `${stores}店中、${negotiatedStores}店が価格交渉枠（旧価格のまま）→ 実質単価¥${effectiveUnitPrice}万（設定価格¥${setPrice}万）`
            : `${stores}店 × ¥${effectiveUnitPrice}万` + (setPrice !== arpu ? `（設定価格¥${setPrice}万）` : ""))
        : null },
    { label:"売上原価", value: -pl.cogs, kind:"minus",
      detail: (stores && pl.market?.cogsPerStore) ? `${stores}店 × ¥${pl.market.cogsPerStore}万/店` : null },
    { label:"売上総利益", value: null, kind:"subtotal" },
    ...allocDetail.map(d => ({
      label: `　${d.icon} ${d.name}投資`, value: -d.amount, kind:"minus", indent:true,
    })),
    { label:"特別アクション費", value: -(pl.sgaAdd||0), kind:"minus", skip: !pl.sgaAdd },
    { label:"顧客あたり運用コスト", value: -pl.varCost, kind:"minus",
      detail: (stores && pl.market?.varCostPerStore) ? `${stores}店 × ¥${pl.market.varCostPerStore}万/店` : null },
    { label:"固定運営費", value: -pl.opex, kind:"minus",
      detail: pl.salesOpexAddon > 0
        ? `基本¥${pl.baseOpexCore}万 + 営業人員増強¥${pl.salesOpexAddon}万`
        : "事業者タイプ固有の固定費" },
    { label:"開発費（償却）", value: -pl.depAmt, kind:"minus", skip: !pl.depAmt, detail:"ソフトウェア資産の10%/Q" },
    { label:"営業利益", value: null, kind:"subtotal" },
    { label:"支払利息", value: -(pl.interestExpense||0), kind:"minus", skip: !pl.interestExpense, detail:"借入残高×5%/Q" },
    { label:"当期純利益", value: pl.netIncome, kind:"final" },
  ].filter(r => !r.skip);

  let running = 0;
  const computedRows = rows.map(r => {
    if (r.kind === "subtotal" || r.kind === "final") {
      return { ...r, display: running };
    }
    running += r.value;
    return { ...r, display: r.value };
  });
  if (computedRows.length > 0) {
    computedRows[computedRows.length-1].display = pl.netIncome;
  }
  const totalSteps = computedRows.length;

  // ★ pl自体（netIncomeの値）が変わるたびに必ずリセットする。
  //   quarterだけに依存すると同一Q内での再表示時にアニメーションが動かない
  useEffect(() => {
    setStep(0);
    if (totalSteps === 0) { if (onComplete) onComplete(); return; }
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      setStep(current);
      if (current >= totalSteps) {
        clearInterval(timer);
        if (onComplete) onComplete();
      }
    }, 420);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pl.netIncome, pl.revenue, quarter, totalSteps]);

  const visibleRows = computedRows.slice(0, step);
  const isDone = step >= totalSteps;

  // ★ 行が1つもない場合のガード（データ欠損時に真っ白にならないように）
  if (totalSteps === 0) {
    return (
      <Panel style={{marginBottom:14}}>
        <Label style={{display:"block",marginBottom:10}}>📋 決算</Label>
        <div style={{fontSize:12, color:C.muted}}>データを準備中...</div>
      </Panel>
    );
  }

  return (
    <Panel style={{marginBottom:14}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10}}>
        <Label>📋 決算が組まれていく...</Label>
        {!isDone && (
          <button onClick={() => { setStep(computedRows.length); if (onComplete) onComplete(); }} style={{
            background:"none", border:"none", color:C.muted, fontSize:10,
            cursor:"pointer", opacity:0.6, textDecoration:"underline",
          }}>
            スキップ
          </button>
        )}
      </div>
      <div style={{display:"grid", gap:0}}>
        {visibleRows.map((r, i) => {
          const isLast = i === visibleRows.length - 1;
          const isSubtotal = r.kind === "subtotal" || r.kind === "final";
          return (
            <div key={r.label} style={{
              padding: isSubtotal ? "8px 0" : "5px 0",
              borderTop: isSubtotal ? `1px solid ${C.border}` : "none",
              borderBottom: isSubtotal ? `1px solid ${C.border}` : `1px dashed ${C.border}55`,
              opacity: isLast ? 0 : 1,
              animation: isLast ? "slideInRight 0.35s ease-out forwards" : "none",
            }}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                <span style={{
                  fontSize: isSubtotal ? 12 : 11,
                  fontWeight: isSubtotal ? 800 : (r.indent ? 400 : 400),
                  color: isSubtotal ? C.text : (r.indent ? C.muted : C.muted),
                  opacity: r.indent ? 0.85 : 1,
                }}>{r.label}</span>
                <span style={{
                  fontSize: isSubtotal ? 15 : 12,
                  fontWeight: isSubtotal ? 900 : 700,
                  fontFamily:"'Courier New',monospace",
                  color: r.kind === "final"
                    ? (r.display >= 0 ? C.green : C.red)
                    : (r.kind === "minus" ? C.orange : isSubtotal ? C.text : C.green),
                }}>
                  {r.display >= 0 && r.kind !== "minus" ? "+" : ""}
                  {(Math.round(r.display) || 0).toLocaleString()}万
                </span>
              </div>
              {r.detail && (
                <div style={{fontSize:9, color:C.muted, opacity:0.7, marginTop:2, textAlign:"right"}}>
                  {r.detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!isDone && (
        <div style={{display:"flex", justifyContent:"center", marginTop:10}}>
          <div style={{display:"flex", gap:4}}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width:5, height:5, borderRadius:"50%", background:C.cyan,
                animation:`pulseGlow 0.9s ease-in-out ${i*0.15}s infinite`,
              }}/>
            ))}
          </div>
        </div>
      )}
      {isDone && (
        <div style={{marginTop:10,display:"flex",gap:16,fontSize:10,color:C.muted,flexWrap:"wrap",opacity:0,animation:"slideInRight 0.3s ease-out 0.1s forwards"}}>
          <span>新規+{pl.competResult?.gained||0}店</span>
          <span>解約/競合流出-{pl.competResult?.lost||0}店</span>
          <span>うち競合奪取+{pl.competResult?.stolenFromRivals||0}店</span>
          <span>解約率{((pl.competResult?.churnRate||0)*100).toFixed(1)}%</span>
        </div>
      )}
    </Panel>
  );
}

function PLTable({pl}) {
  const rows=[
    ["売上高",          pl.revenue,                    false,C.green],
    ["売上原価",        -pl.cogs,                      false,C.red],
    ["売上総利益",       pl.grossProfit,                true],
    ["予算投資費用",    -pl.allocSga,                  false,C.muted],
    ["特別アクション費",-pl.sgaAdd,                    false,pl.sgaAdd>0?C.orange:C.muted],
    ["顧客あたり運用コスト",      -pl.varCost,                   false,C.orange],
    ["固定運営費",      -pl.opex,                      false,C.red],
    ["開発費（償却）",  -pl.depAmt,                    false,C.purple],
    ["営業利益",         pl.operatingProfit,            true,pl.operatingProfit>=0?C.green:C.red],
    ["支払利息",        -pl.interestExpense,            false,C.red],
    ["当期純利益",       pl.netIncome,                  true,pl.netIncome>=0?C.green:C.red],
  ];
  return (
    <Panel>
      <Label style={{display:"block",marginBottom:10}}>損益計算書（当四半期）</Label>
      {rows.map(([l,v,bold,c])=>{
        if(Math.abs(v)===0&&!bold) return null;
        return (
          <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",
            borderBottom:`1px solid ${C.border}`,fontWeight:bold?800:400}}>
            <span style={{fontSize:11,color:bold?C.text:C.muted}}>{l}</span>
            <Num v={v} plus={!bold} unit="万" style={{fontSize:11,color:c||(bold?C.text:C.muted)}}/>
          </div>
        );
      })}
      <div style={{marginTop:8,display:"flex",gap:16,fontSize:10,color:C.muted,flexWrap:"wrap"}}>
        <span>新規+{pl.competResult?.gained||0}店</span>
        <span>解約/競合流出-{pl.competResult?.lost||0}店</span>
        <span>うち競合奪取+{pl.competResult?.stolenFromRivals||0}店</span>
        <span>解約率{((pl.competResult?.churnRate||0)*100).toFixed(1)}%</span>
      </div>
    </Panel>
  );
}


// ============================================================
// ONLINE LOBBY
// ============================================================
function OnlineLobby({ onSolo, onTutorial, onHistory, room }) {
  const { roomCode, roomData, playerId, isHost, error, loading, allReady,
          createRoom, joinRoom, startGame, players } = room;

  const [mode, setMode]         = useState(null); // "create" | "join"
  const [playerName, setName]   = useState(() => lineProfile?.displayName || "");
  const [joinCode, setJoinCode] = useState("");
  const [marketSel, setMarket]  = useState("food");
  const [typeSel, setType]      = useState("startup");

  // ゲーム開始：ホストが全員の初期stateを書き込む
  const handleStart = async () => {
    if (!isHost) return;
    const initialStates = {};
    Object.entries(roomData.players).forEach(([pid, p]) => {
      const pt = PLAYER_TYPES[p.playerType];
      initialStates[pid] = {
        bs: {...pt.bs},
        ops: {...pt.ops},
        usedSpecials: [],
        allocation: {sales:0,dev:0,marketing:0,price:0,cs:0},
        specialAction: null,
        lastNetIncome: 0,
        permanentOpexExtra: 0,
      };
    });
    await startGame(initialStates);
  };

  // ゲーム開始後はAppがroomDataを監視して遷移
  useEffect(() => {
    if (roomData?.status === "playing") {
      onSolo({
        mode: "online",
        roomCode, playerId, isHost,
        marketId: roomData.marketId,
        playerType: roomData.players[playerId]?.playerType,
        gameState: roomData.gameState,
        allPlayers: roomData.players,
        quarter: roomData.quarter || 1,
        roomRef: { roomCode, playerId, isHost },
      });
    }
  }, [roomData?.status]);

  if (!mode) return (
    <div style={bgBase}>
      <div style={{maxWidth:500,margin:"0 auto",padding:"60px 24px",textAlign:"center"}}>
        <Label style={{display:"block",marginBottom:12,fontSize:11}}>LINE Mini App</Label>
        <h1 style={{fontSize:32,fontWeight:900,margin:"0 0 8px",background:`linear-gradient(135deg,${C.text},${C.cyan})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          SaaS Market Battle
        </h1>
        <p style={{color:C.muted,fontSize:13,marginBottom:40}}>予算配分と競争戦略で総資産最大化を目指す</p>
        <div style={{display:"grid",gap:12,marginBottom:16}}>
          <button onClick={()=>setMode("create")} style={{background:`linear-gradient(135deg,#006080,${C.cyan})`,color:"#fff",border:"none",borderRadius:12,padding:"16px 0",fontSize:15,fontWeight:700,cursor:"pointer"}}>
            🏠 ルームを作る
          </button>
          <button onClick={()=>setMode("join")} style={{background:C.panel,color:C.text,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 0",fontSize:15,fontWeight:700,cursor:"pointer"}}>
            🚪 ルームに参加する
          </button>
          <button onClick={onSolo} style={{background:C.bg,color:C.muted,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 0",fontSize:14,cursor:"pointer"}}>
            👤 ソロプレイ（NPC対戦）
          </button>
          <button onClick={onTutorial} style={{background:"none",color:C.muted,border:"none",padding:"8px 0",fontSize:12,cursor:"pointer"}}>
            📖 チュートリアルを見る
          </button>
          <button onClick={onHistory} style={{background:"none",color:C.muted,border:"none",padding:"4px 0",fontSize:12,cursor:"pointer"}}>
            📊 プレイ履歴を見る
          </button>
        </div>
      </div>
    </div>
  );

  if (mode === "create" && !roomCode) return (
    <div style={bgBase}>
      <div style={{maxWidth:500,margin:"0 auto",padding:"60px 24px"}}>
        <button onClick={()=>setMode(null)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,marginBottom:24}}>← 戻る</button>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:24}}>ルームを作る</h2>
        <div style={{display:"grid",gap:14}}>
          <div>
            <Label style={{display:"block",marginBottom:6}}>あなたの名前</Label>
            <input value={playerName} onChange={e=>setName(e.target.value)} placeholder="例：田中"
              style={{width:"100%",background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:14,outline:"none"}}/>
          </div>
          <div>
            <Label style={{display:"block",marginBottom:8}}>市場を選択</Label>
            {Object.values(MARKETS).map(m=>(
              <div key={m.id} onClick={()=>setMarket(m.id)} style={{
                background:marketSel===m.id?`${m.color}15`:C.panel,border:`1px solid ${marketSel===m.id?m.color:C.border}`,
                borderRadius:10,padding:"10px 14px",cursor:"pointer",marginBottom:8,display:"flex",gap:12,alignItems:"center"}}>
                <span style={{fontSize:24}}>{m.icon}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:marketSel===m.id?m.color:C.text}}>{m.name}</div>
                  <div style={{fontSize:11,color:C.muted}}>{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div>
            <Label style={{display:"block",marginBottom:8}}>事業者タイプ</Label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {Object.values(PLAYER_TYPES).map(pt=>(
                <div key={pt.id} onClick={()=>setType(pt.id)} style={{
                  background:typeSel===pt.id?"#001C2E":C.panel,border:`1px solid ${typeSel===pt.id?C.cyan:C.border}`,
                  borderRadius:10,padding:"12px 14px",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:28}}>{pt.icon}</div>
                  <div style={{fontSize:12,fontWeight:700,color:typeSel===pt.id?C.cyan:C.text,marginTop:4}}>{pt.name}</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>{pt.desc}</div>
                </div>
              ))}
            </div>
          </div>
          {error && <div style={{color:C.red,fontSize:12}}>{error}</div>}
          <button onClick={()=>playerName&&createRoom(playerName,marketSel,typeSel)} disabled={!playerName||loading}
            style={{background:playerName?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,color:playerName?"#fff":C.muted,border:"none",borderRadius:10,padding:"14px 0",fontSize:15,fontWeight:700,cursor:playerName?"pointer":"not-allowed"}}>
            {loading?"作成中...":"ルームを作成"}
          </button>
        </div>
      </div>
    </div>
  );

  if (mode === "join" && !roomCode) return (
    <div style={bgBase}>
      <div style={{maxWidth:500,margin:"0 auto",padding:"60px 24px"}}>
        <button onClick={()=>setMode(null)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,marginBottom:24}}>← 戻る</button>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:24}}>ルームに参加する</h2>
        <div style={{display:"grid",gap:14}}>
          <div>
            <Label style={{display:"block",marginBottom:6}}>あなたの名前</Label>
            <input value={playerName} onChange={e=>setName(e.target.value)} placeholder="例：田中"
              style={{width:"100%",background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:14,outline:"none"}}/>
          </div>
          <div>
            <Label style={{display:"block",marginBottom:6}}>ルームコード（4文字）</Label>
            <input value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} placeholder="例：AB3K"
              style={{width:"100%",background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:20,fontWeight:900,letterSpacing:8,textAlign:"center",outline:"none"}}
              maxLength={4}/>
          </div>
          <div>
            <Label style={{display:"block",marginBottom:8}}>事業者タイプ</Label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {Object.values(PLAYER_TYPES).map(pt=>(
                <div key={pt.id} onClick={()=>setType(pt.id)} style={{
                  background:typeSel===pt.id?"#001C2E":C.panel,border:`1px solid ${typeSel===pt.id?C.cyan:C.border}`,
                  borderRadius:10,padding:"12px 14px",cursor:"pointer",textAlign:"center"}}>
                  <div style={{fontSize:28}}>{pt.icon}</div>
                  <div style={{fontSize:12,fontWeight:700,color:typeSel===pt.id?C.cyan:C.text,marginTop:4}}>{pt.name}</div>
                </div>
              ))}
            </div>
          </div>
          {error && <div style={{color:C.red,fontSize:12}}>{error}</div>}
          <button onClick={()=>playerName&&joinCode.length===4&&joinRoom(joinCode,playerName,typeSel)}
            disabled={!playerName||joinCode.length!==4||loading}
            style={{background:playerName&&joinCode.length===4?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,color:playerName&&joinCode.length===4?"#fff":C.muted,border:"none",borderRadius:10,padding:"14px 0",fontSize:15,fontWeight:700,cursor:"pointer"}}>
            {loading?"参加中...":"参加する"}
          </button>
        </div>
      </div>
    </div>
  );

  // 待合室
  if (roomCode) return (
    <div style={bgBase}>
      <div style={{maxWidth:500,margin:"0 auto",padding:"60px 24px",textAlign:"center"}}>
        <Label style={{display:"block",marginBottom:8}}>待合室</Label>
        <div style={{fontSize:48,fontWeight:900,letterSpacing:16,color:C.cyan,fontFamily:"'Courier New',monospace",marginBottom:4}}>
          {roomCode}
        </div>
        <p style={{color:C.muted,fontSize:12,marginBottom:32}}>このコードを仲間に共有してください</p>
        <Panel style={{marginBottom:20,textAlign:"left"}}>
          <Label style={{display:"block",marginBottom:12}}>参加プレイヤー（{players.length}/3）</Label>
          {players.map(p=>(
            <div key={p.id} style={{display:"flex",gap:12,alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:20}}>{PLAYER_TYPES[p.playerType]?.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:700,color:p.id===playerId?C.cyan:C.text}}>
                  {p.name} {p.id===playerId?"（あなた）":""} {p.isHost?"👑":""}
                </div>
                <div style={{fontSize:11,color:C.muted}}>{PLAYER_TYPES[p.playerType]?.name}</div>
              </div>
              <div style={{fontSize:11,color:C.green}}>✓ 参加済み</div>
            </div>
          ))}
          {players.length < 2 && (
            <div style={{fontSize:12,color:C.muted,marginTop:10,textAlign:"center"}}>
              あと{2-players.length}人以上の参加を待っています...
            </div>
          )}
        </Panel>
        <Panel style={{marginBottom:20,padding:"10px 16px"}}>
          <div style={{fontSize:12,color:C.muted}}>市場: <span style={{color:C.text,fontWeight:700}}>{MARKETS[roomData?.marketId]?.name}</span></div>
        </Panel>
        {isHost && players.length >= 2 && (
          <button onClick={handleStart}
            style={{width:"100%",background:`linear-gradient(135deg,#006080,${C.cyan})`,color:"#fff",border:"none",borderRadius:10,padding:"16px 0",fontSize:16,fontWeight:700,cursor:"pointer",letterSpacing:2}}>
            ゲームスタート 🚀
          </button>
        )}
        {!isHost && (
          <div style={{color:C.muted,fontSize:13}}>ホストがゲームを開始するのを待っています...</div>
        )}
        {error && <div style={{color:C.red,fontSize:12,marginTop:10}}>{error}</div>}
      </div>
    </div>
  );

  return null;
}

// ============================================================
// TUTORIAL SCREEN（5スライド）
// ============================================================
// ============================================================
// PLAY HISTORY SCREEN：過去のプレイを振り返る
// ============================================================
function PlayHistoryScreen({ onBack }) {
  const [records] = useState(() => loadPlayHistory());

  if (records.length === 0) {
    return (
      <div style={bgBase}>
        <div style={{maxWidth:500,margin:"0 auto",padding:"60px 24px",textAlign:"center"}}>
          <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,marginBottom:24}}>← 戻る</button>
          <div style={{fontSize:40,marginBottom:12}}>📊</div>
          <h2 style={{fontSize:18,fontWeight:800,color:C.text,marginBottom:8}}>まだプレイ履歴がありません</h2>
          <p style={{fontSize:12,color:C.muted}}>ゲームを1回プレイすると、ここに結果が記録されます。</p>
        </div>
      </div>
    );
  }

  // 傾向分析：直近プレイの投資配分平均から「偏り」を見つける
  const ALLOC_LABELS = { sales:"営業", dev:"開発", marketing:"マーケ", cs:"CS" };
  const avgAlloc = { sales:0, dev:0, marketing:0, cs:0 };
  records.forEach(r => Object.keys(avgAlloc).forEach(k => { avgAlloc[k] += (r.allocRatios?.[k]||0); }));
  Object.keys(avgAlloc).forEach(k => avgAlloc[k] = Math.round(avgAlloc[k] / records.length));
  const dominant = Object.entries(avgAlloc).sort((a,b)=>b[1]-a[1])[0];

  const avgRank = records.reduce((s,r)=>s+r.rank, 0) / records.length;
  const winCount = records.filter(r => r.rank === 1).length;
  const totalDevAttempts = records.reduce((s,r)=>s+(r.devFocusAttempts||0), 0);
  const totalDevMatches = records.reduce((s,r)=>s+(r.devFocusMatches||0), 0);
  const devMatchRate = totalDevAttempts > 0 ? Math.round(totalDevMatches/totalDevAttempts*100) : null;

  const maxNetWorth = Math.max(...records.map(r=>r.netWorth), 1);

  return (
    <div style={bgBase}>
      <div style={{maxWidth:560,margin:"0 auto",padding:"40px 20px 60px"}}>
        <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,marginBottom:20}}>← 戻る</button>
        <div style={{textAlign:"center", marginBottom:24}}>
          <div style={{fontSize:11, letterSpacing:4, color:C.purple, marginBottom:6}}>PLAY HISTORY</div>
          <h2 style={{fontSize:22, fontWeight:900, color:C.text, margin:0}}>📊 プレイ履歴</h2>
          <p style={{fontSize:11, color:C.muted, marginTop:4}}>直近{records.length}回のプレイを振り返る</p>
        </div>

        {/* 傾向まとめ */}
        <Panel style={{marginBottom:16}}>
          <Label style={{display:"block", marginBottom:10}}>あなたの傾向</Label>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:18, fontWeight:900, color:C.cyan, fontFamily:"'Courier New',monospace"}}>{avgRank.toFixed(1)}位</div>
              <div style={{fontSize:9, color:C.muted}}>平均順位</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:18, fontWeight:900, color:C.yellow, fontFamily:"'Courier New',monospace"}}>{winCount}回</div>
              <div style={{fontSize:9, color:C.muted}}>1位の回数</div>
            </div>
          </div>
          <div style={{fontSize:11, color:C.text, marginBottom:8}}>
            投資配分の平均：
            {Object.entries(avgAlloc).map(([k,v]) => (
              <span key={k} style={{marginLeft:8, color: k===dominant[0] ? C.purple : C.muted, fontWeight: k===dominant[0] ? 700 : 400}}>
                {ALLOC_LABELS[k]}{v}%
              </span>
            ))}
          </div>
          {dominant[1] >= 40 && (
            <div style={{fontSize:11, color:C.orange, background:`${C.orange}12`, padding:"8px 10px", borderRadius:6}}>
              💡 あなたは「{ALLOC_LABELS[dominant[0]]}」に偏りがちです（平均{dominant[1]}%）。他の投資先も試してみると新しい戦略が見つかるかもしれません。
            </div>
          )}
          {devMatchRate !== null && (
            <div style={{fontSize:11, color:C.muted, marginTop:8}}>
              🎯 プロダクト開発の市場ニーズ的中率：<span style={{color: devMatchRate>=50?C.green:C.orange, fontWeight:700}}>{devMatchRate}%</span>
              （{totalDevMatches}/{totalDevAttempts}回）
            </div>
          )}
        </Panel>

        {/* 純資産の推移（プレイ間） */}
        <Panel style={{marginBottom:16}}>
          <Label style={{display:"block", marginBottom:10}}>純資産の推移（古い→新しい）</Label>
          <div style={{display:"flex", alignItems:"flex-end", gap:4, height:70}}>
            {[...records].reverse().map((r, i) => (
              <div key={i} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3}}>
                <div style={{
                  width:"100%", borderRadius:"3px 3px 0 0",
                  background: r.rank===1 ? C.yellow : C.cyan,
                  height:`${Math.max(4, r.netWorth/maxNetWorth*60)}px`,
                  opacity: r.rank===1 ? 1 : 0.7,
                }}/>
                <span style={{fontSize:8, color:C.muted}}>{r.rank}位</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* 個別の履歴一覧 */}
        <Panel>
          <Label style={{display:"block", marginBottom:10}}>履歴一覧</Label>
          {records.map((r, i) => {
            const date = new Date(r.playedAt);
            const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,"0")}`;
            const marketName = MARKETS[r.marketId]?.name || r.marketId;
            return (
              <div key={i} style={{
                display:"flex", alignItems:"center", gap:10, padding:"10px 0",
                borderBottom: i<records.length-1 ? `1px solid ${C.border}` : "none",
              }}>
                <span style={{fontSize:18}}>{r.rank===1?"🥇":r.rank===2?"🥈":r.rank===3?"🥉":"　"}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:11, fontWeight:700, color:C.text}}>{marketName} / {PLAYER_TYPES[r.playerType]?.name||r.playerType}</div>
                  <div style={{fontSize:9, color:C.muted}}>{dateStr}　借入{r.borrowCount||0}回　価格変更{r.priceChangeCount||0}回</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13, fontWeight:900, color:C.cyan, fontFamily:"'Courier New',monospace"}}>¥{r.netWorth.toLocaleString()}万</div>
                  <div style={{fontSize:9, color:C.muted}}>{r.stores}店</div>
                </div>
              </div>
            );
          })}
        </Panel>
      </div>
    </div>
  );
}

function TutorialScreen({ onComplete }) {
  const [slide, setSlide] = useState(0);
  const total = 5;

  const slides = [
    // ===== スライド1：このゲームは何？ =====
    {
      title: "LINEミニアプリ市場で戦え",
      subtitle: "SaaS Market Battle",
      content: (
        <div>
          <div style={{textAlign:"center",marginBottom:20}}>
            {/* 市場イメージ：3つの業種アイコン */}
            <div style={{display:"flex",justifyContent:"center",gap:16,marginBottom:16}}>
              {[["🍜","飲食"],["🏪","小売"],["✂️","美容室"]].map(([icon,label])=>(
                <div key={label} style={{background:C.panel,borderRadius:12,padding:"16px 20px",textAlign:"center",border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:36}}>{icon}</div>
                  <div style={{fontSize:11,color:C.muted,marginTop:6}}>{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{display:"grid",gap:10}}>
            <div style={{display:"flex",gap:12,alignItems:"flex-start",background:C.panel,borderRadius:10,padding:"12px 14px"}}>
              <span style={{fontSize:22,flexShrink:0}}>🏢</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:2}}>あなたはSaaSベンダー</div>
                <div style={{fontSize:12,color:C.muted}}>飲食・小売・美容室向けのLINEミニアプリを提供する事業者として市場に参入する</div>
              </div>
            </div>
            <div style={{display:"flex",gap:12,alignItems:"flex-start",background:C.panel,borderRadius:10,padding:"12px 14px"}}>
              <span style={{fontSize:22,flexShrink:0}}>⚔️</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:2}}>競合と店舗を奪い合う</div>
                <div style={{fontSize:12,color:C.muted}}>同じ市場に2〜3社のライバルが存在。毎四半期、投資戦略と価格で競争する</div>
              </div>
            </div>
          </div>
        </div>
      ),
    },

    // ===== スライド2：勝利条件 =====
    {
      title: "勝つのは誰だ？",
      subtitle: "3年後の純資産で決まる",
      content: (
        <div>
          {/* 時系列イメージ */}
          <div style={{marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:16}}>
              {[["🌅","Year 1\n黎明期","先行者を\n取れるかが勝負","#E3B341"],
                ["🚀","Year 2\n急成長","投資を\n加速せよ","#3FB950"],
                ["🏁","Year 3\n成熟期","奪い合いが\n激化する","#D2A8FF"]].map(([icon,label,desc,color],i)=>(
                <div key={i} style={{flex:1,textAlign:"center"}}>
                  <div style={{background:`${color}22`,border:`1px solid ${color}55`,borderRadius:10,padding:"12px 6px"}}>
                    <div style={{fontSize:28}}>{icon}</div>
                    <div style={{fontSize:11,fontWeight:700,color,marginTop:4,whiteSpace:"pre-line"}}>{label}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:4,whiteSpace:"pre-line"}}>{desc}</div>
                  </div>
                  {i<2&&<div style={{fontSize:18,color:C.muted}}>→</div>}
                </div>
              ))}
            </div>
          </div>

          {/* 勝利条件 */}
          <div style={{background:`${C.cyan}15`,border:`1px solid ${C.cyan}44`,borderRadius:12,padding:"16px",textAlign:"center"}}>
            <div style={{fontSize:14,color:C.muted,marginBottom:6}}>勝利条件</div>
            <div style={{fontSize:22,fontWeight:900,color:C.cyan}}>12Q終了時の</div>
            <div style={{fontSize:22,fontWeight:900,color:C.cyan}}>純資産（資本金＋利益剰余金）最大</div>
            <div style={{fontSize:11,color:C.muted,marginTop:8}}>店舗を増やして売上を積み上げ、借りすぎず賢く投資して資産を作れ</div>
          </div>
        </div>
      ),
    },

    // ===== スライド3：毎Qの流れ =====
    {
      title: "1四半期の流れ",
      subtitle: "これを12回繰り返す",
      content: (
        <div>
          <div style={{display:"grid",gap:8}}>
            {[
              {step:"01", icon:"💰", color:C.cyan,   title:"予算を配分する",
               desc:"今期の投資可能額を5つの項目に自由に配分。残しても次Qに繰り越せる。"},
              {step:"02", icon:"⚡", color:C.yellow,  title:"特別アクション（任意）",
               desc:"大手との契約・広報PR・資金調達など1Q1回の特別手を打てる。"},
              {step:"03", icon:"▶️", color:C.green,   title:"四半期を進める",
               desc:"全員の配分が決まったら実行。競争が解決され結果が出る。"},
              {step:"04", icon:"📊", color:C.purple,  title:"決算・競争結果を確認",
               desc:"PL/BSと競合との比較を確認。次Qの戦略を立てる。"},
            ].map(s=>(
              <div key={s.step} style={{display:"flex",gap:12,alignItems:"center",background:C.panel,borderRadius:10,padding:"10px 14px",border:`1px solid ${s.color}33`}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:`${s.color}33`,border:`1px solid ${s.color}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:900,color:s.color,flexShrink:0}}>
                  {s.step}
                </div>
                <span style={{fontSize:20,flexShrink:0}}>{s.icon}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:C.text}}>{s.title}</div>
                  <div style={{fontSize:11,color:C.muted}}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },

    // ===== スライド4：5つのパラメータ =====
    {
      title: "5つの競争力",
      subtitle: "投資しないと毎Q劣化する",
      content: (
        <div>
          <div style={{display:"grid",gap:8,marginBottom:14}}>
            {[
              {icon:"👥",name:"営業力",        color:"#06B6D4",desc:"新規獲得ペースに直結",bar:70},
              {icon:"⚙️",name:"プロダクト品質",color:"#A855F7",desc:"解約率を下げる・競争スコアに寄与",bar:55},
              {icon:"📢",name:"ブランド認知",   color:"#E3B341",desc:"シェア獲得を加速。未投資で最も劣化",bar:40},
              {icon:"🎧",name:"CS品質",         color:"#FFA657",desc:"解約率を下げる。長期保有に重要",bar:50},
            ].map(p=>(
              <div key={p.name} style={{display:"flex",gap:10,alignItems:"center",background:C.panel,borderRadius:8,padding:"8px 12px"}}>
                <span style={{fontSize:18,flexShrink:0}}>{p.icon}</span>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:700,color:p.color}}>{p.name}</span>
                    <span style={{fontSize:10,color:C.muted}}>{p.desc}</span>
                  </div>
                  <div style={{background:C.border,borderRadius:3,height:5,overflow:"hidden"}}>
                    <div style={{width:`${p.bar}%`,height:"100%",background:p.color,borderRadius:3}}/>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{background:`${C.red}15`,border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px 12px",fontSize:11,color:C.red,textAlign:"center"}}>
            ⚠️ 投資しなかった項目は毎Q自動で劣化します。全部は維持できない
          </div>
        </div>
      ),
    },

    // ===== スライド5：価格戦略 =====
    {
      title: "価格が勝敗を分ける",
      subtitle: "年1回だけ設定できる",
      content: (
        <div>
          {/* 価格スペクトラム */}
          <div style={{background:C.panel,borderRadius:12,padding:"16px",marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24}}>📉</div>
                <div style={{fontSize:11,fontWeight:700,color:C.green}}>低価格</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24}}>⚖️</div>
                <div style={{fontSize:11,fontWeight:700,color:C.cyan}}>標準</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24}}>💎</div>
                <div style={{fontSize:11,fontWeight:700,color:C.yellow}}>高価格</div>
              </div>
            </div>
            <div style={{background:`linear-gradient(to right, ${C.green}, ${C.cyan}, ${C.yellow})`,height:6,borderRadius:3,marginBottom:10}}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,fontSize:10,color:C.muted,textAlign:"center"}}>
              <div>競争スコア⬆<br/>ARPU⬇</div>
              <div>バランス型</div>
              <div>ARPU⬆<br/>競争スコア⬇<br/>解約リスク⬆</div>
            </div>
          </div>

          <div style={{display:"grid",gap:8}}>
            <div style={{display:"flex",gap:10,background:C.panel,borderRadius:8,padding:"10px 12px",border:`1px solid ${C.red}44`}}>
              <span style={{fontSize:20}}>⚠️</span>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:C.red,marginBottom:2}}>値上げすると即時解約が発生</div>
                <div style={{fontSize:11,color:C.muted}}>値上げ幅 × 市場感度 × 保有店舗数 = 解約店舗数</div>
              </div>
            </div>
            <div style={{display:"flex",gap:10,background:C.panel,borderRadius:8,padding:"10px 12px",border:`1px solid ${C.cyan}44`}}>
              <span style={{fontSize:20}}>💡</span>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:C.cyan,marginBottom:2}}>対人戦の核心</div>
                <div style={{fontSize:11,color:C.muted}}>相手が低価格のときに自分が値上げすると店舗を根こそぎ奪われる</div>
              </div>
            </div>
          </div>
        </div>
      ),
    },
  ];

  const s = slides[slide];

  return (
    <div style={bgBase}>
      <div style={{maxWidth:560,margin:"0 auto",padding:"32px 20px",minHeight:"100vh",display:"flex",flexDirection:"column"}}>
        {/* ヘッダー */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
          <div style={{fontSize:11,color:C.muted,letterSpacing:2}}>TUTORIAL</div>
          <button onClick={onComplete} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:12}}>
            スキップ →
          </button>
        </div>

        {/* プログレスバー */}
        <div style={{display:"flex",gap:4,marginBottom:28}}>
          {Array.from({length:total}).map((_,i)=>(
            <div key={i} style={{flex:1,height:3,borderRadius:2,
              background:i<=slide?C.cyan:C.border,transition:"background 0.3s"}}/>
          ))}
        </div>

        {/* スライドコンテンツ */}
        <div style={{flex:1}}>
          <div style={{marginBottom:6,fontSize:11,color:C.cyan,letterSpacing:2,fontWeight:700}}>
            {String(slide+1).padStart(2,"0")} / {String(total).padStart(2,"0")}
          </div>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:"0 0 4px"}}>{s.title}</h2>
          <p style={{fontSize:13,color:C.muted,margin:"0 0 20px"}}>{s.subtitle}</p>
          {s.content}
        </div>

        {/* ナビゲーション */}
        <div style={{display:"flex",gap:12,marginTop:24}}>
          {slide > 0 && (
            <button onClick={()=>setSlide(s=>s-1)}
              style={{flex:1,padding:"14px 0",background:C.panel,border:`1px solid ${C.border}`,
                borderRadius:10,color:C.muted,fontSize:14,cursor:"pointer",fontWeight:700}}>
              ← 前へ
            </button>
          )}
          <button onClick={()=>slide<total-1?setSlide(s=>s+1):onComplete()}
            style={{flex:2,padding:"14px 0",
              background:slide===total-1?`linear-gradient(135deg,#006080,${C.cyan})`:`${C.cyan}22`,
              border:`1px solid ${C.cyan}`,borderRadius:10,
              color:slide===total-1?"#fff":C.cyan,
              fontSize:14,cursor:"pointer",fontWeight:700,
              boxShadow:slide===total-1?`0 4px 20px ${C.cyan}44`:"none"}}>
            {slide===total-1?"ゲームスタート 🚀":"次へ →"}
          </button>
        </div>
      </div>
    </div>
  );
}


function PriceSettingScreen({ pendingPrice, onConfirm }) {
  const { baseArpu, currentPrice, currentStores, priceSensitivity, isInitial } = pendingPrice;
  const [inputPrice, setInputPrice] = useState(currentPrice || baseArpu);
  const multiplier = calcPriceMultiplier(inputPrice, baseArpu);
  // 価格スコア（competitiveScoreと同じ二乗カーブ）
  const _ratio = (inputPrice - baseArpu) / Math.max(baseArpu, 1);
  const priceScore = Math.max(0, Math.min(100, 50 - Math.sign(_ratio) * Math.pow(Math.abs(_ratio), 0.5) * 80));
  const revenueChangePct = ((multiplier - 1.0) * 100).toFixed(1);
  const hikeRatio = isInitial ? 0 : (inputPrice - currentPrice) / Math.max(currentPrice, 1);
  const churnStores = (!isInitial && hikeRatio > 0) ? Math.floor((currentStores||0) * hikeRatio * (priceSensitivity||0.6)) : 0;

  return (
    <div style={bgBase}>
      <div style={{maxWidth:560, margin:"0 auto", padding:"48px 20px"}}>
        <div style={{textAlign:"center", marginBottom:28}}>
          <div style={{fontSize:11,letterSpacing:4,color:C.yellow,marginBottom:8}}>
            {isInitial ? "INITIAL PRICE SETTING" : "ANNUAL PRICE REVIEW"}
          </div>
          <h2 style={{fontSize:24,fontWeight:900,color:C.text,margin:"0 0 8px"}}>
            {isInitial ? "初期価格を設定しよう" : "来年度の価格設定"}
          </h2>
          <p style={{fontSize:13,color:C.muted,lineHeight:1.6}}>
            {isInitial
              ? "ゲーム開始前に月額利用料を決めてください。\n価格は毎年見直せます。"
              : `月額利用料を設定してください。\n`}
            {!isInitial && <span style={{color:C.yellow}}>価格は年に1回のみ変更できます。</span>}
          </p>
        </div>

        <Panel style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
            <div>
              <Label style={{display:"block",marginBottom:4}}>市場標準価格</Label>
              <span style={{fontSize:20,fontWeight:900,color:C.muted,fontFamily:"'Courier New',monospace"}}>¥{baseArpu}万/月</span>
            </div>
            <div style={{textAlign:"right"}}>
              <Label style={{display:"block",marginBottom:4}}>現在の設定価格</Label>
              <span style={{fontSize:20,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{currentPrice || baseArpu}万/月</span>
            </div>
          </div>

          <Label style={{display:"block",marginBottom:8}}>新しい価格（万円/月）</Label>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <span style={{fontSize:16,color:C.muted,flexShrink:0}}>¥</span>
            <input type="number" value={inputPrice} min={1} max={baseArpu*5}
              inputMode="numeric" pattern="[0-9]*"
              onChange={e => setInputPrice(Math.max(1, Math.min(baseArpu*5, Number(e.target.value))))}
              style={{flex:1,background:C.bg,border:`2px solid ${C.cyan}`,borderRadius:8,
                padding:"12px 16px",color:C.text,fontSize:24,fontWeight:900,
                fontFamily:"'Courier New',monospace",outline:"none",textAlign:"right"}}
            />
            <span style={{fontSize:14,color:C.muted,flexShrink:0}}>万円/月</span>
          </div>
          <div style={{fontSize:10,color:C.muted,marginTop:-8,marginBottom:14}}>
            ¥1万 〜 ¥{baseArpu*5}万（標準価格の5倍まで）
          </div>

          {/* プリセット */}
          <div style={{display:"flex",gap:6,marginBottom:16}}>
            {[0.7,0.85,1.0,1.15,1.3].map(r=>{
              const p=Math.round(baseArpu*r);
              const label=r===0.7?"激安":r===0.85?"割安":r===1.0?"標準":r===1.15?"割高":"プレミアム";
              return (
                <button key={r} onClick={()=>setInputPrice(p)} style={{
                  flex:1,padding:"6px 2px",borderRadius:8,fontSize:10,fontWeight:700,cursor:"pointer",
                  border:`1px solid ${inputPrice===p?C.cyan:C.border}`,
                  background:inputPrice===p?`${C.cyan}22`:C.bg,
                  color:inputPrice===p?C.cyan:C.muted}}>
                  <div>{label}</div>
                  <div style={{fontFamily:"'Courier New',monospace"}}>¥{p}</div>
                </button>
              );
            })}
          </div>

          {/* 効果プレビュー */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            {[
              ["💰 売上/店舗", `${Number(revenueChangePct)>=0?"+":""}${revenueChangePct}%`,
                Number(revenueChangePct)>=0?C.green:C.red],
              ["📊 競争力スコア寄与", `${priceScore.toFixed(0)} pt`,
                priceScore>=35?C.green:priceScore>=20?C.yellow:C.red],
              ["📤 即時解約", churnStores>0?`-${churnStores}店`:"なし",
                churnStores>0?C.red:C.green],
            ].map(([l,v,c])=>(
              <div key={l} style={{background:C.bg,borderRadius:8,padding:"10px",textAlign:"center",border:`1px solid ${c}33`}}>
                <div style={{fontSize:10,color:C.muted,marginBottom:4}}>{l}</div>
                <div style={{fontSize:16,fontWeight:900,color:c,fontFamily:"'Courier New',monospace"}}>{v}</div>
              </div>
            ))}
          </div>
          {churnStores > 0 && (
            <div style={{marginTop:10,padding:"8px 12px",background:"#F8514912",border:"1px solid #F8514944",borderRadius:8,fontSize:11,color:"#F85149"}}>
              ⚠️ 値上げ{(hikeRatio*100).toFixed(0)}% × 価格感度{((priceSensitivity||0.25)*100).toFixed(0)}% → 現在{currentStores||0}店の約{churnStores}店が即時解約
            </div>
          )}
        </Panel>

        <Panel style={{marginBottom:20,padding:"12px 16px",background:`${C.yellow}0A`,border:`1px solid ${C.yellow}33`}}>
          <div style={{fontSize:11,color:C.yellow,fontWeight:700,marginBottom:4}}>💡 価格戦略</div>
          <div style={{fontSize:11,color:C.muted,lineHeight:1.6}}>
            {inputPrice < baseArpu*0.85 && "低価格：新規獲得加速・競合奪取しやすい。ただし1店舗あたり収益が下がる。"}
            {inputPrice>=baseArpu*0.85&&inputPrice<=baseArpu*1.15 && "標準価格：安定したシェア維持。バランス型戦略。"}
            {inputPrice > baseArpu*1.15 && "高価格：1店舗あたり収益が上がるが獲得ペースが落ちる。品質・ブランドが高い場合に有効。"}
          </div>
        </Panel>

        <button onClick={()=>onConfirm(inputPrice)}
          style={{width:"100%",background:`linear-gradient(135deg,#006080,${C.cyan})`,
            color:"#fff",border:"none",borderRadius:10,padding:16,
            fontSize:15,fontWeight:700,cursor:"pointer",letterSpacing:2,
            boxShadow:`0 4px 20px ${C.cyan}44`}}>
          ¥{inputPrice}万/月で来年度スタート →
        </button>
      </div>
    </div>
  );
}


const bgBase={minHeight:"100vh",background:"#0D1117",color:C.text,fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif"};

function SetupMarket({onNext}) {
  const [sel,setSel]=useState(null);
  return (
    <div style={bgBase}>
      <div style={{maxWidth:680,margin:"0 auto",padding:"60px 24px"}}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <Label style={{display:"block",marginBottom:12,fontSize:11}}>LINE Mini App</Label>
          <h1 style={{fontSize:32,fontWeight:900,margin:0,background:`linear-gradient(135deg,${C.text},${C.cyan})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
            SaaS Market Battle
          </h1>
          <p style={{color:C.muted,marginTop:10,fontSize:13}}>
            予算配分と競争戦略で総資産最大化を目指す経営シミュレーション
          </p>
        </div>
        <Label style={{display:"block",marginBottom:16}}>STEP 1 — 参入市場</Label>
        <div style={{display:"grid",gap:14,marginBottom:28}}>
          {Object.values(MARKETS).map(m=>(
            <div key={m.id} onClick={()=>setSel(m.id)} style={{
              background:sel===m.id?`${m.color}12`:C.panel,
              border:`2px solid ${sel===m.id?m.color:C.border}`,
              borderRadius:14,padding:"18px 22px",cursor:"pointer",transition:"all 0.18s",
              transform:sel===m.id?"translateX(6px)":"none",
              boxShadow:sel===m.id?`0 0 24px ${m.color}28`:"none"}}>
              <div style={{display:"flex",alignItems:"center",gap:16}}>
                <span style={{fontSize:36}}>{m.icon}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:17,fontWeight:800,color:sel===m.id?m.color:C.text,marginBottom:4}}>{m.name}</div>
                  <div style={{fontSize:12,color:C.muted}}>{m.desc}</div>
                </div>
                <div style={{display:"grid",gap:5}}>
                  {[["ARPU",`¥${m.arpu}万/Q`],["総店舗",`${m.totalStores}店`],["参入難度","★".repeat(m.entryDiff)]].map(([l,v])=>(
                    <div key={l} style={{display:"flex",gap:8,justifyContent:"flex-end",fontSize:11}}>
                      <span style={{color:C.muted}}>{l}</span>
                      <span style={{color:sel===m.id?m.color:C.text,fontWeight:700}}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <button onClick={()=>sel&&onNext(sel)} disabled={!sel}
          style={{width:"100%",background:sel?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,
            color:sel?"#fff":C.muted,border:"none",borderRadius:10,padding:"14px 0",
            fontSize:15,fontWeight:700,cursor:sel?"pointer":"not-allowed",letterSpacing:2,
            boxShadow:sel?`0 4px 20px ${C.cyan}44`:"none"}}>
          NEXT →
        </button>
      </div>
    </div>
  );
}

function SetupType({marketId,onStart,onBack}) {
  const [sel,setSel]=useState(null);
  const m=MARKETS[marketId];
  return (
    <div style={bgBase}>
      <div style={{maxWidth:680,margin:"0 auto",padding:"60px 24px"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <Label style={{display:"block",marginBottom:8}}>{m.icon} {m.name}</Label>
          <h1 style={{fontSize:26,fontWeight:900,margin:0,color:C.text}}>事業者タイプを選択</h1>
        </div>
        <Label style={{display:"block",marginBottom:16}}>STEP 2 — 初期BS・パラメータ</Label>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
          {Object.values(PLAYER_TYPES).map(pt=>{
            const ta=totalAssets(pt.bs);
            const avail=pt.id==="vendor"?250:80;
            return (
              <div key={pt.id} onClick={()=>setSel(pt.id)} style={{
                background:sel===pt.id?"#001C2E":C.panel,
                border:`2px solid ${sel===pt.id?C.cyan:C.border}`,
                borderRadius:14,padding:20,cursor:"pointer",transition:"all 0.18s",
                boxShadow:sel===pt.id?`0 0 28px ${C.cyan}28`:"none"}}>
                <div style={{textAlign:"center",marginBottom:14}}>
                  <div style={{fontSize:36}}>{pt.icon}</div>
                  <div style={{fontSize:15,fontWeight:800,color:sel===pt.id?C.cyan:C.text,marginTop:6}}>{pt.name}</div>
                  <div style={{fontSize:11,color:C.muted,marginTop:4}}>{pt.desc}</div>
                </div>
                <div style={{background:C.bg,borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                  <Label style={{display:"block",marginBottom:6}}>初期BS</Label>
                  {[["現預金",pt.bs.cash],["資本金",pt.bs.capital],["総資産",ta]].map(([l,v])=>(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",fontSize:11}}>
                      <span style={{color:C.muted}}>{l}</span>
                      <Num v={v} unit="万" style={{fontSize:11}}/>
                    </div>
                  ))}
                </div>
                <div style={{background:C.bg,borderRadius:8,padding:"8px 12px",marginBottom:10}}>
                  <Label style={{display:"block",marginBottom:6}}>投資上限の決まり方</Label>
                  <div style={{fontSize:11,color:C.muted,lineHeight:1.6}}>
                    現預金 × <span style={{color:C.yellow,fontWeight:700}}>{Math.round(pt.investRatio*100)}%</span>
                    （安全バッファ控除後）+ FCF予測
                  </div>
                  <div style={{marginTop:4,fontSize:10,color:C.muted}}>
                    投資効率 <span style={{color:pt.investEfficiency>1?C.green:C.muted,fontWeight:700}}>{pt.investEfficiency}倍</span>
                    {" | 高値ほど投資効果が逓減"}
                    {pt.id==="vendor"?" | 固定費¥200万/Q":" | 固定費¥40万/Q（軽量）"}
                  </div>
                </div>
                {[["⚙️ 品質",pt.ops.solutionQuality,C.purple],["👥 営業力",pt.ops.salesPower,C.cyan],
                  ["📢 ブランド",pt.ops.brandAwareness,C.yellow],
                  ["🎧 CS",pt.ops.supportQuality,C.orange]].map(([l,v,c])=>(
                  <div key={l} style={{marginBottom:7}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:10,color:C.muted}}>{l}</span>
                      <span style={{fontSize:10,color:c,fontWeight:700}}>{v}</span>
                    </div>
                    <Bar value={v} color={c}/>
                  </div>
                ))}
                {pt.id==="startup"&&<div style={{marginTop:8,fontSize:10,color:C.orange,textAlign:"center"}}>✦ エクイティ調達 使用可</div>}
              </div>
            );
          })}
        </div>
        <Panel style={{marginBottom:20,padding:"12px 18px"}}>
          <Label style={{display:"block",marginBottom:8}}>対戦NPC</Label>
          <div style={{display:"flex",gap:20}}>
            {NPC_PROFILES.map(n=>(
              <div key={n.id} style={{display:"flex",gap:10,alignItems:"center"}}>
                <span style={{fontSize:20}}>{n.icon}</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:n.color}}>{n.name}</div>
                  <div style={{fontSize:10,color:C.muted}}>{PLAYER_TYPES[n.type]?.name} / {n.strategy==="sales_heavy"?"営業特化":"開発特化"}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onBack} style={{background:C.panel,color:C.muted,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px 20px",fontSize:14,cursor:"pointer"}}>← 戻る</button>
          <button onClick={()=>sel&&onStart(sel)} disabled={!sel}
            style={{flex:1,background:sel?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,
              color:sel?"#fff":C.muted,border:"none",borderRadius:10,padding:"13px 0",
              fontSize:15,fontWeight:700,cursor:sel?"pointer":"not-allowed",letterSpacing:2,
              boxShadow:sel?`0 4px 20px ${C.cyan}44`:"none"}}>
            ゲームスタート 🚀
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [screen,setScreen] = useState(() => {
    // localStorage で表示済みかチェック（2回目以降はlobbyから）
    try {
      const done = localStorage.getItem(TUTORIAL_KEY);
      return done ? "lobby" : "tutorial";
    } catch { return "tutorial"; }
  });
  const [tutorialDone,setTutorialDone] = useState(false);
  const [onlineMode,setOnlineMode] = useState(false);
  const [onlineInfo,setOnlineInfo] = useState(null); // {roomCode, playerId, isHost}
  const [marketId,setMarketId]   = useState(null);
  const [playerType,setPlayerType] = useState(null);
  const [bs,setBs]               = useState(null);
  const [ops,setOps]             = useState(null);
  const [npcs,setNpcs]           = useState([]);
  const [quarter,setQuarter]     = useState(1);
  const [allocation,setAllocation] = useState({sales:0,dev:0,marketing:0,price:0,cs:0});
  const [investTarget,setInvestTarget] = useState(null); // Stage2: 今期の投資目標額（未入力=null）
  const [showBorrowPanel,setShowBorrowPanel] = useState(false); // Stage3: 借入確認パネルの表示
  const [borrowedThisQuarter,setBorrowedThisQuarter] = useState(0); // 今Q新規借入した額（investRatio制限なしで使える）
  const [prevAllocation,setPrevAllocation] = useState({sales:0,dev:0,marketing:0,price:0,cs:0});
  const [specialAction,setSpecialAction] = useState(null);
  const [usedSpecials,setUsedSpecials]   = useState([]);
  const [lastPL,setLastPL]       = useState(null);
  const [lastEvent,setLastEvent] = useState(null);
  const [lastNetIncome,setLastNetIncome] = useState(0);
  const [prevNpcOps,setPrevNpcOps] = useState({});
  const [prevOps,setPrevOps] = useState(null); // Stage1: 自分のパラメータ変化表示用
  const [narratives,setNarratives] = useState([]);
  const [pendingChoice,setPendingChoice]   = useState(null);
  const [activeEffects,setActiveEffects]   = useState([]);
  const [permanentOpexExtra,setPermanentOpexExtra] = useState(0);
  const [pendingPrice,setPendingPrice]     = useState(null); // 年次価格設定待ち
  const [bsAnimReady,setBsAnimReady]       = useState(false); // BSアニメーション開始フラグ
  const [marketNeed,setMarketNeed]         = useState(null); // ★ 市場の顧客ニーズ（全社共通、非公開）
  const [truceProposals,setTruceProposals] = useState([]); // ★ ③今Q提案した不戦条約の相手ID一覧
  const hasSavedRecordRef = useRef(false); // ★ gameover到達時の保存が複数回走らないようにするフラグ
  const [tab,setTab]             = useState("budget");
  const [history,setHistory]     = useState([]);
  const [playStats,setPlayStats] = useState({
    allocTotals: {sales:0, dev:0, marketing:0, cs:0}, // 累積投資配分（傾向分析用）
    devFocusAttempts: 0, devFocusMatches: 0,          // ②devFocus的中率
    priceChangeCount: 0,                              // 価格変更回数
    borrowCount: 0,                                   // 借入回数
  });


  // ============================================================
  // オンラインモード：Firebase同期
  // ============================================================
  const room = useRoom();
  const calculatedForRef = useRef(null); // 同じQを2回計算しないためのガード

  // オンラインモード：roomDataの変化を監視してゲーム状態を同期
  useEffect(() => {
    if (!onlineMode || !room.roomData || !room.playerId) return;
    const rd = room.roomData;
    const myState = rd.gameState?.[room.playerId];

    // ★ playing状態でgameStateが更新されたとき自分のbs/opsを同期
    if (rd.status === "playing" && myState) {
      if (myState.bs) setBs(myState.bs);
      if (myState.ops) setOps({...myState.ops});
      if (myState.usedSpecials) setUsedSpecials(myState.usedSpecials);
      if (typeof rd.quarter === "number") setQuarter(rd.quarter);
      setLastNetIncome(myState.lastNetIncome || 0);
    }

    // 結果画面への遷移
    if (rd.status === "result" && screen !== "result") {
      // ★ 結果画面でも自分のgameStateを最新に更新
      if (myState) {
        setBs(myState.bs);
        setOps({...myState.ops});
        setUsedSpecials(myState.usedSpecials || []);
        setLastNetIncome(myState.lastNetIncome || 0);
      }
      if (typeof rd.quarter === "number") setQuarter(rd.quarter);
      const myLog = rd.quarterLogs?.[room.playerId];
      if (myLog) {
        setLastPL(myLog.pl);
        setLastEvent(myLog.event || null);
        setNarratives(myLog.narratives || []);
      }
      // ★ 他プレイヤーをNPCとして更新
      const otherPlayers = Object.entries(rd.players || {})
        .filter(([pid]) => pid !== room.playerId)
        .map(([pid, p]) => {
          const state = rd.gameState?.[pid];
          return {
            id: pid, name: p.name,
            type: p.playerType,
            icon: PLAYER_TYPES[p.playerType]?.icon || "👤",
            color: ["#FF6B6B","#4ECDC4","#FFE66D"][Object.keys(rd.players).indexOf(pid) % 3],
            strategy: "sales_heavy",
            bs: state?.bs || {...PLAYER_TYPES[p.playerType]?.bs},
            ops: state?.ops || {...PLAYER_TYPES[p.playerType]?.ops},
          };
        });
      if (otherPlayers.length > 0) setNpcs(otherPlayers);
      setBsAnimReady(false); // オンライン同期でresult画面に入る際もアニメーションを最初から
      setScreen("result");
    }

    // 年次レビューへの遷移
    if (rd.status === "yearreview" && screen !== "yearreview") {
      if (myState) {
        setBs(myState.bs);
        setOps({...myState.ops});
        setUsedSpecials(myState.usedSpecials || []);
      }
      if (typeof rd.quarter === "number") setQuarter(rd.quarter - 1); // yearreviewはQ進む前
      setScreen("yearreview");
    }

    // ゲームオーバー
    if (rd.status === "gameover" && screen !== "gameover") {
      if (myState) { setBs(myState.bs); setOps({...myState.ops}); }
      setScreen("gameover");
    }
  }, [room.roomData, onlineMode]);

  // オンラインモード：全員準備完了時にホストが計算実行
  useEffect(() => {
    if (!onlineMode || !room.isHost || !room.roomData) return;
    if (room.roomData.status !== "playing") return;

    const players = room.roomData.players || {};
    const playerList = Object.values(players);
    if (playerList.length < 2) return;

    // ★ 全員がreadyの時だけ計算する（1人でもfalseがいたら何もしない）
    const allReady = playerList.every(p => p.ready === true);
    if (!allReady) return;

    // ★ 同じQを2回計算しないためのガード
    const currentQ = room.roomData.quarter || 1;
    if (calculatedForRef.current === currentQ) return;
    calculatedForRef.current = currentQ;

    const market = MARKETS[marketId];
    if (!market || !room.roomData.gameState) return;

    const playerEntries = Object.entries(players);
    const gameStates = room.roomData.gameState;
    // ★ 市場ニーズ（全プレイヤー共通、Firebase経由で同期）。次Qに向けて1回だけ更新する
    const currentMarketNeed = room.roomData.marketNeed || DEV_FOCUS_KEYS[0];
    const nextMarketNeed = evolveMarketNeed(currentMarketNeed);

    // ★ ③外交：合意成立(accepted)した不戦条約のみtruceMapに反映（双方向）
    const truceMap = {};
    Object.values(room.roomData.truceProposals || {}).forEach(p => {
      if (p.status !== "accepted") return;
      truceMap[p.from] = [...(truceMap[p.from]||[]), p.to];
      truceMap[p.to] = [...(truceMap[p.to]||[]), p.from];
    });

    // 競争計算（★ gameStateが存在しないプレイヤーは除外し、不正なops={}がresolveMarketに混入するのを防ぐ）
    const allPlayerOps = playerEntries
      .filter(([pid]) => gameStates[pid]?.ops)
      .map(([pid]) => ({
        id: pid,
        ops: gameStates[pid].ops,
      }));
    const competResults = resolveMarket(allPlayerOps, market, room.roomData.quarter || 1, 0, truceMap);

    // 各プレイヤーのQ処理
    const newGameState = {};
    const quarterLogs = {};

    playerEntries.forEach(([pid, p]) => {
      const pState = gameStates[pid];
      if (!pState) return;
      const alloc = p.allocation || {sales:0,dev:0,marketing:0,price:0,cs:0};
      const special = p.specialAction || null;
      const pt = PLAYER_TYPES[p.playerType];
      const eff = pt?.investEfficiency || 1.0;
      const baseOpex = pt?.baseOpex || 100;

      // ★ Stage1: 時間差反映（前Qのpendingをcommit→今Qの配分をpendingへ積む）
      // ★ devFocusのマッチング判定もFirebase経由の市場ニーズで正しく機能する
      let pOps = commitPendingInvestment(pState.ops, eff, currentMarketNeed);
      pOps = queuePendingInvestment(pOps, alloc, eff);
      let pBs = {...pState.bs};
      let sgaAdd = 0, capitalizeAmt = 0;

      // 特別アクション（★ oneTimeチェックを追加し、ソロモードと同じロジックに統一）
      if (special && SPECIAL_ACTIONS[special] && (!SPECIAL_ACTIONS[special]?.oneTime || !pState.usedSpecials?.includes(special))) {
        const r = applySpecialAction(pBs, pOps, special, pState.usedSpecials || [], p.playerType);
        pBs = r.bs; pOps = r.ops; sgaAdd = r.sgaAdd || 0; capitalizeAmt = r.capitalizeAmt || 0;
      }

      // 競争結果適用
      const cr = competResults.find(r => r.id === pid);
      if (!cr) return;
      const finalOps = {...pOps, stores: cr.finalStores};

      // PL計算
      const dep = Math.floor(pBs.softwareAsset * SW_DEP_RATE);
      pBs.softwareAsset -= dep;

      // ★ Stage3: ローンスケジュールに基づく返済処理（ソロモードと統一）
      const loanCalc = calcLoanRepayment(pBs);
      const interest = loanCalc.interestPaid;
      const principalPaid = loanCalc.principalPaid;
      pBs.loanSchedule = loanCalc.newSchedule;
      pBs.debt = Math.max(0, pBs.debt - principalPaid);

      let allocSga = 0, allocCap = 0;
      BUDGET_ITEMS.forEach(item => {
        const amt = alloc[item.id] || 0;
        if (amt > 0) { if (item.capitalize) allocCap += amt; else allocSga += amt; }
      });
      pBs.softwareAsset += allocCap;

      const revenue = calcRevenue(finalOps, market);
      const cogs = calcCogs(finalOps, market);
      const varCost = calcVarCost(finalOps, market);
      // ★ 営業力強化＝人員増強と解釈。ソロモードと統一
      const salesOpexAddon = calcSalesOpexAddon(finalOps.salesPower);
      const totalBaseOpex = baseOpex + salesOpexAddon;
      const totalSga = allocSga + sgaAdd + totalBaseOpex + varCost;
      const operatingProfit = revenue - cogs - totalSga - dep;
      const netIncome = operatingProfit - interest;

      // ★ sgaAddはapplySpecialActionで既にpBs.cashから引かれているため、ここでは引かない（二重減算回避）
      pBs.cash += revenue - cogs - varCost - totalBaseOpex - allocSga - allocCap - interest - principalPaid;
      pBs.retainedEarnings += netIncome;

      const newUsed = special && SPECIAL_ACTIONS[special]?.oneTime
        ? [...(pState.usedSpecials||[]), special]
        : (pState.usedSpecials||[]);

      newGameState[pid] = {
        bs: pBs, ops: finalOps, usedSpecials: newUsed,
        allocation: {sales:0,dev:0,marketing:0,price:0,cs:0},
        specialAction: null,
        lastNetIncome: netIncome,
        permanentOpexExtra: pState.permanentOpexExtra || 0,
      };

      // ★ ③外交：このプレイヤーが関わった不戦条約の結果のみ抽出（pid視点でキー=相手id）
      const myTruceResults = {};
      Object.values(room.roomData.truceProposals || {}).forEach(p => {
        if (p.status === "pending") return;
        if (p.from === pid) myTruceResults[p.to] = p.status === "accepted";
        else if (p.to === pid) myTruceResults[p.from] = p.status === "accepted";
      });

      const pl = {
        revenue, cogs, grossProfit: revenue-cogs, varCost,
        allocSga, allocCap, sgaAdd, opex: totalBaseOpex, baseOpexCore: baseOpex, salesOpexAddon, totalSga,
        depAmt: dep, interestExpense: interest, principalPaid,
        operatingProfit, netIncome,
        competResult: {
          newFromUnclaimed: cr.newFromUnclaimed || 0,
          stolenFromRivals: cr.stolenFromRivals || 0,
          naturalChurn: cr.naturalChurn || 0,
          lostToRivals: cr.lostToRivals || 0,
          finalStores: cr.finalStores,
        },
        playerAlloc: alloc, playerSpecial: special,
        market: { arpu: market.arpu, varCostPerStore: market.varCostPerStore, cogsPerStore: market.cogsPerStore },
        priceMultiplier: finalOps.priceMultiplier,
        setPrice: finalOps.setPrice,
        truceResults: myTruceResults,
      };
      quarterLogs[pid] = { pl, event: null, narratives: [] };
    });

    const nextQ = currentQ + 1;
    const nextStatus = currentQ % 4 === 0 ? "yearreview"
                     : nextQ > MAX_QUARTERS ? "gameover"
                     : "result";

    room.writeQuarterResult(nextQ, newGameState, quarterLogs, nextStatus, nextMarketNeed);
  }, [room.roomData, onlineMode]);

  // オンライン：配分提出
  const onlineSubmitAllocation = async () => {
    if (!onlineMode) return;
    await room.submitAllocation(allocation, specialAction);
    setPrevAllocation(allocation);
    setAllocation({...allocation});
    setSpecialAction(null);
  };

  function startGame(ptId) {
    const pt = PLAYER_TYPES[ptId];
    setBs({...pt.bs});
    setOps({...pt.ops});
    setNpcs(NPC_PROFILES.map(n=>({
      ...n,
      bs:{...PLAYER_TYPES[n.type].bs},
      ops:{...PLAYER_TYPES[n.type].ops},
      usedSpecials:[],
    })));
    setPlayerType(ptId);
    // ★ 初回も価格設定を行う
    const market = MARKETS[marketId];
    setPendingPrice({
      currentPrice: market?.arpu || 80,
      baseArpu: market?.arpu || 80,
      currentStores: 0,
      priceSensitivity: market?.priceSensitivity || 0.6,
      isInitial: true, // 初回フラグ（解約なし）
    });
    setScreen("pricesetting");
  }

  // BS連動型投資上限（継続効果のinvestBonusも加算）
  const investBonusFromEffects = activeEffects.filter(e=>e.type==="investBonus").reduce((s,e)=>s+e.value,0);
  // ★ Stage2: 自己資金だけで出せる上限（旧availableBudgetの実体）
  // ★ Stage3: 今Q新規借入した分はinvestRatio制限を受けずそのまま全額投資に使える
  const selfFundCapacity = bs
    ? calcInvestCapacity(bs, playerType, lastNetIncome) + investBonusFromEffects + borrowedThisQuarter
    : 0;
  // 投資目標額（未入力ならデフォルトで自己資金上限と同額にしておく＝従来の挙動を維持）
  const effectiveTarget = investTarget != null ? investTarget : selfFundCapacity;
  // 不足額（借入で解消可能。現時点でまだ解消されていない分）
  const shortfall = Math.max(0, effectiveTarget - selfFundCapacity);
  // 実際に配分に使える額（自己資金上限とtargetの小さい方）
  const availableBudget = Math.min(effectiveTarget, selfFundCapacity);
  const allocTotal = BUDGET_ITEMS.reduce((s,item)=>s+(allocation[item.id]||0),0);
  // ★ devに配分があるのにdevFocus未選択なら実行不可（顧客価値の方向性を必ず選ばせる）
  const devFocusMissing = (allocation.dev||0) > 0 && !allocation.devFocus;
  const canExecute = allocTotal <= availableBudget && !devFocusMissing;

  // Stage3: 借入を実行する
  function doBorrow(amount) {
    if (!bs || amount <= 0) return;
    const limit = maxBorrowable(bs);
    const actualAmount = Math.min(amount, limit);
    if (actualAmount <= 0) return;
    setBs(b => borrowMoney(b, actualAmount));
    setBorrowedThisQuarter(b => b + actualAmount); // ★ 今Q借入した分はinvestRatio制限を受けずに使える
    setPlayStats(s => ({...s, borrowCount: s.borrowCount + 1})); // ★ プレイ履歴用
    setShowBorrowPanel(false);
  }

  function executeQuarter() {
    if (!canExecute) return;
    const market = MARKETS[marketId];

    // ★ Stage1: 今Qの開始時点のops（commit前）を保存。result画面で「前Q投資の反映」を見せるため
    setPrevOps({...ops});

    // ランダムイベント抽選（選択型は別処理）
    let ev = null;
    const roll = Math.random();
    let cumProb = 0;
    for (const e of RANDOM_EVENTS) {
      cumProb += e.prob;
      if (roll < cumProb) { ev = e; break; }
    }

    const { pBs, finalPOps, pl, newNpcs, newUsedSpecials, nextMarketNeed } =
      processQuarter(bs, ops, allocation, specialAction,
                     npcs, market, quarter, usedSpecials, playerType, marketNeed, truceProposals);
    setMarketNeed(nextMarketNeed);
    setTruceProposals([]); // ★ 今Qの提案はリセット（次Qは再度提案が必要）

    // ★ プレイ履歴用：投資配分の累積・devFocus的中率を記録
    setPlayStats(s => {
      const next = {...s, allocTotals: {...s.allocTotals}};
      BUDGET_ITEMS.forEach(item => {
        next.allocTotals[item.id] = (next.allocTotals[item.id]||0) + (allocation[item.id]||0);
      });
      if (finalPOps.lastDevFocusResult) {
        next.devFocusAttempts = s.devFocusAttempts + 1;
        next.devFocusMatches = s.devFocusMatches + (finalPOps.lastDevFocusResult.matched ? 1 : 0);
      }
      return next;
    });

    // 継続効果の適用
    let finalBs = pBs, finalOps = finalPOps;
    let newActiveEffects = activeEffects
      .map(e => ({...e, remaining: e.remaining - 1}))
      .filter(e => e.remaining > 0);

    // ★ BS整合：現金支出はcashのみ減算。retainedEarningsはprocessQuarter内で計算済み
    // ここでは「PLを通さない現金支出」として扱い、otherAsset調整でBSを合わせる
    let extraCashOut = 0;

    activeEffects.forEach(eff => {
      if (eff.type === "revenueShock") {
        const shock = Math.floor(calcRevenue(finalOps, market) * Math.abs(eff.value));
        extraCashOut += shock;
      }
    });

    // 永続固定費（提携コスト等）
    if (permanentOpexExtra > 0) {
      extraCashOut += permanentOpexExtra;
    }

    // extraCashOutをBS整合的に反映：cash減 + otherAsset減（費用として吸収）
    if (extraCashOut > 0) {
      finalBs = {
        ...finalBs,
        cash: finalBs.cash - extraCashOut,
        // retainedEarningsも同額減らしてBS整合を維持
        retainedEarnings: finalBs.retainedEarnings - extraCashOut,
      };
    }

    // 新イベント自動適用
    let npcDamageTarget = null;
    let npcBoostAll = 0;
    if (ev && ev.type === "auto") {
      // BS効果（仕様変更コスト等）- cashとretainedEarningsを同額変動させてBS整合
      if (ev.bsEffect) {
        const bsBefore = {...finalBs};
        const bsAfter  = ev.bsEffect(finalBs, finalOps);
        const cashDiff = bsAfter.cash - bsBefore.cash;
        finalBs = {...bsAfter, retainedEarnings: finalBs.retainedEarnings + cashDiff};
      }
      // Ops効果（自社）
      if (ev.opsBoost) Object.entries(ev.opsBoost).forEach(([k,v])=>{
        finalOps = {...finalOps, [k]: Math.min(PARAM_MAX, (finalOps[k]||0)+v)};
      });
      if (ev.opsRisk) {
        if (ev.opsRisk.randomParam) {
          const params = ["salesPower","solutionQuality","brandAwareness","supportQuality"];
          const target = params[Math.floor(Math.random()*params.length)];
          finalOps = {...finalOps, [target]: Math.max(0, (finalOps[target]||0)+ev.opsRisk.randomParam)};
        }
        if (ev.opsRisk.storeRatio) finalOps = {...finalOps, stores: Math.floor(finalOps.stores*(1+ev.opsRisk.storeRatio))};
        if (ev.opsRisk.supportQuality) finalOps = {...finalOps, supportQuality: Math.max(0,(finalOps.supportQuality||0)+ev.opsRisk.supportQuality)};
        if (ev.opsRisk.brandAwareness) finalOps = {...finalOps, brandAwareness: Math.max(0,(finalOps.brandAwareness||0)+ev.opsRisk.brandAwareness)};
        if (ev.opsRisk.solutionQuality) finalOps = {...finalOps, solutionQuality: Math.max(0,(finalOps.solutionQuality||0)+ev.opsRisk.solutionQuality)};
      }
      if (ev.revenueShock) {
        const shock = Math.floor(calcRevenue(finalOps, market) * Math.abs(ev.revenueShock));
        // cashとretainedEarningsを同額減らしてBS整合
        finalBs = {...finalBs, cash: finalBs.cash - shock, retainedEarnings: finalBs.retainedEarnings - shock};
        if (ev.duration > 1) newActiveEffects.push({id:ev.id, type:"revenueShock", value:ev.revenueShock, remaining:ev.duration-1});
      }
      if (ev.investBonus && ev.duration > 1) {
        newActiveEffects.push({id:ev.id, type:"investBonus", value:ev.investBonus, remaining:ev.duration-1});
      }
      if (ev.marketBoost) { /* resolveMarket側で反映済み */ }
      // NPC効果
      if (ev.npcDamage) npcDamageTarget = ev.npcDamage;
      if (ev.npcBoostTarget) npcBoostAll = ev.npcBoostTarget.allParams || 0;
      // LINE Partner Bonus
      if (ev.lineFeatureBonus) {
        const myScore = competitiveScore(finalOps, market?.arpu);
        const topScore = Math.max(myScore, ...newNpcs.map(n=>competitiveScore(n.ops, market?.arpu)));
        if (myScore >= topScore) finalOps = {...finalOps, solutionQuality: Math.min(PARAM_MAX,(finalOps.solutionQuality||0)+15)};
      }
      if (ev.partnerBonus) {
        const myScore = competitiveScore(finalOps, market?.arpu);
        const topScore = Math.max(myScore, ...newNpcs.map(n=>competitiveScore(n.ops, market?.arpu)));
        if (myScore >= topScore) newActiveEffects.push({id:"partnerBonus", type:"acquisitionBonus", value:0.5, remaining:1});
      }
    }

    // NPC更新
    const finalNpcs = newNpcs.map((n, idx) => {
      let nOps = {...n.ops};
      if (npcBoostAll > 0) {
        Object.keys(nOps).forEach(k => { if(typeof nOps[k]==="number"&&k!=="stores") nOps[k]=Math.min(PARAM_MAX,nOps[k]+npcBoostAll); });
      }
      if (npcDamageTarget && idx === 0) { // 最初のNPCにダメージ
        if (npcDamageTarget.stores) nOps = {...nOps, stores: Math.floor(nOps.stores*(1-npcDamageTarget.stores))};
        if (npcDamageTarget.brandAwareness) nOps = {...nOps, brandAwareness: Math.max(0,(nOps.brandAwareness||0)-npcDamageTarget.brandAwareness)};
      }
      return {...n, ops: nOps};
    });

    // 選択型イベントは処理を一時停止して選択を待つ
    if (ev && ev.type === "choice") {
      // 先にPL結果を保存してから選択画面へ
      const myScore2 = competitiveScore(finalOps, market?.arpu);
      const enrichedResult2 = {...pl.competResult, quarter, myScore:myScore2, rivalScores:finalNpcs.map(n=>competitiveScore(n.ops, market?.arpu))};
      const newNarratives2 = generateCompetitiveNarrative(enrichedResult2, finalNpcs, prevNpcOps, getPhase(quarter));
      setHistory(h=>[...h,{quarter,netWorth:equity(finalBs),stores:Math.floor(finalOps.stores)||0,netIncome:pl.netIncome,phase:getPhase(quarter).name,npcSnapshot:finalNpcs.map(n=>({id:n.id,name:n.name,color:n.color,stores:Math.floor(n.ops.stores)||0,netWorth:equity(n.bs)}))}]);
      setPrevNpcOps(Object.fromEntries(finalNpcs.map(n=>[n.id,{...n.ops}])));
      setBs(finalBs); setOps(finalOps); setNpcs(finalNpcs);
      setUsedSpecials(newUsedSpecials); setLastPL({...pl,competResult:enrichedResult2}); setLastEvent(ev);
      setLastNetIncome(pl.netIncome); setNarratives(newNarratives2);
      setActiveEffects(newActiveEffects);
      setPrevAllocation(allocation); setAllocation({...allocation}); setSpecialAction(null);
      setInvestTarget(null); setBorrowedThisQuarter(0); // Stage2/3: 次Qはリセット
      setPendingChoice(ev); // 選択画面へ
      setScreen("choice");
      return;
    }

    // 通常処理
    const myScore = competitiveScore(finalOps, market?.arpu);
    const enrichedResult = {...pl.competResult, quarter, myScore, rivalScores:finalNpcs.map(n=>competitiveScore(n.ops, market?.arpu))};
    const newNarratives = generateCompetitiveNarrative(enrichedResult, finalNpcs, prevNpcOps, getPhase(quarter));

    setHistory(h=>[...h,{quarter,netWorth:equity(finalBs),stores:Math.floor(finalOps.stores)||0,netIncome:pl.netIncome,phase:getPhase(quarter).name,npcSnapshot:finalNpcs.map(n=>({id:n.id,name:n.name,color:n.color,stores:Math.floor(n.ops.stores)||0,netWorth:equity(n.bs)}))}]);
    setPrevNpcOps(Object.fromEntries(finalNpcs.map(n=>[n.id,{...n.ops}])));
    setBs(finalBs); setOps(finalOps); setNpcs(finalNpcs);
    setUsedSpecials(newUsedSpecials); setLastPL({...pl,competResult:enrichedResult}); setLastEvent(ev);
    setLastNetIncome(pl.netIncome); setNarratives(newNarratives);
    setActiveEffects(newActiveEffects);
    setPrevAllocation(allocation); setAllocation({...allocation}); setSpecialAction(null);
    setInvestTarget(null); setBorrowedThisQuarter(0); // Stage2/3: 次Qはリセット
    goToResultOrForecast(pl);
  }

  // 選択型イベントの確定
  function resolveChoice(choiceIdx) {
    if (!pendingChoice) return;
    const choice = pendingChoice.choices[choiceIdx];
    let newBs = {...bs}, newOps = {...ops};

    if (choice.effect === "none") { setBs(newBs); setOps(newOps); setPendingChoice(null); goToResultOrForecast(lastPL); return; }
    // ★ bsCostはPLを通らない支出なので、cashとretainedEarningsを同額変動させてBS整合を維持
    if (choice.bsCost)      newBs = {...newBs, cash: newBs.cash - choice.bsCost, retainedEarnings: newBs.retainedEarnings - choice.bsCost};
    // ★ cashGainは「出資（capitalGainとセット）」なら資本金の増加で資産側が既にカバーされるためretainedEarningsには積まない。
    //   単独の現金収入（出資を伴わない）ならretainedEarningsにも積んでBS整合を保つ。
    if (choice.cashGain) {
      if (choice.capitalGain) {
        newBs = {...newBs, cash: newBs.cash + choice.cashGain};
      } else {
        newBs = {...newBs, cash: newBs.cash + choice.cashGain, retainedEarnings: newBs.retainedEarnings + choice.cashGain};
      }
    }
    if (choice.capitalGain) newBs = {...newBs, capital: newBs.capital + choice.capitalGain};
    if (choice.storeBonus)  newOps = {...newOps, stores: newOps.stores + choice.storeBonus};
    if (choice.permanentOpex) setPermanentOpexExtra(p => p + choice.permanentOpex);
    if (choice.opsBoost)  Object.entries(choice.opsBoost).forEach(([k,v])=>{ newOps[k]=Math.min(PARAM_MAX,(newOps[k]||0)+v); });
    if (choice.opsRisk) {
      if (choice.opsRisk.solutionQuality) newOps = {...newOps, solutionQuality: Math.max(0,(newOps.solutionQuality||0)+choice.opsRisk.solutionQuality)};
      if (choice.opsRisk.supportQuality)  newOps = {...newOps, supportQuality:  Math.max(0,(newOps.supportQuality||0)+choice.opsRisk.supportQuality)};
    }
    setBs(newBs); setOps(newOps);
    setPendingChoice(null);
    goToResultOrForecast(lastPL);
  }

  function advance() {
    if (onlineMode) {
      room.advanceYear();
      setScreen("play"); setTab("budget");
      return;
    }
    if (quarter >= MAX_QUARTERS) { setScreen("gameover"); return; }
    if (quarter % 4 === 0) { setScreen("yearreview"); return; }
    // ★ yearreview後にconfirmPriceでquarterが既に進んでいる場合はここでは進めない
    // （screen="play"から"result"になった時点のquarterで判定するため問題なし）
    setQuarter(q => q + 1); setScreen("play"); setTab("budget");
  }

  // battlefield画面（陣取り合戦シーン）→ result画面の順で遷移
  function goToResultOrForecast(pl) {
    setBsAnimReady(false); // BSアニメーションを最初から見せるためリセット
    setScreen("battlefield");
  }

  function advanceFromYearReview() {
    const market = MARKETS[marketId];
    const nextQ = quarter + 1; // ★ 非同期stateに依存しないよう値を先に計算
    setPendingPrice({
      currentPrice: ops.setPrice || market?.arpu || 80,
      baseArpu: market?.arpu || 80,
      currentStores: ops.stores || 0,
      priceSensitivity: market?.priceSensitivity || 0.6,
      nextQuarter: nextQ, // ★ confirmPriceで確実にセットするためここで渡す
    });
    setScreen("pricesetting");
  }

  function confirmPrice(newPrice) {
    const market = MARKETS[marketId];
    const baseArpu = market?.arpu || 80;
    const prevPrice = pendingPrice?.isInitial ? newPrice : (ops.setPrice || baseArpu);
    const multiplier = calcPriceMultiplier(newPrice, baseArpu);

    const hikeRatio = pendingPrice?.isInitial ? 0 : (newPrice - prevPrice) / Math.max(prevPrice, 1);
    let churnStores = 0;
    let churnMessage = null;
    if (hikeRatio > 0 && ops.stores > 0) {
      const sensitivity = market?.priceSensitivity || 0.6;
      churnStores = Math.floor(ops.stores * hikeRatio * sensitivity);
      if (churnStores > 0) {
        churnMessage = {
          icon: "📤", color: "#F85149",
          text: `値上げ（+${(hikeRatio*100).toFixed(0)}%）により ${churnStores}店が解約。競争スコアも低下します。`,
        };
      }
    }

    setOps(o => ({
      ...o,
      setPrice: newPrice,
      priceMultiplier: multiplier,
      stores: Math.max(0, (o.stores||0) - churnStores),
    }));
    if (churnMessage) setNarratives([churnMessage]);
    // ★ プレイ履歴用：初回設定は除き、年次の価格変更のみカウント
    if (!pendingPrice?.isInitial && newPrice !== prevPrice) {
      setPlayStats(s => ({...s, priceChangeCount: s.priceChangeCount + 1}));
    }

    // ★ NPCの価格戦略も同じ年次タイミング（Q4→Q5、Q8→Q9）でのみ再判定する（初回は標準価格のまま）
    if (!pendingPrice?.isInitial) {
      const playerStores = ops.stores || 0;
      setNpcs(ns => ns.map(n => {
        const decision = decideNpcPriceStrategy(n, playerStores, baseArpu);
        return {
          ...n,
          priceStrategy: decision.strategy,
          ops: { ...n.ops, setPrice: decision.setPrice, priceMultiplier: decision.priceMultiplier },
        };
      }));
    }

    // ★ yearreview後はnextQuarterを使って確実にquarterをセット
    // （setQuarter(q=>q+1)の非同期による競合状態を回避）
    if (pendingPrice?.nextQuarter) {
      setQuarter(pendingPrice.nextQuarter);
    }
    setPendingPrice(null);
    setScreen("play");
    setTab("budget");
  }

  const yr=Math.ceil(quarter/4), qq=((quarter-1)%4)+1;
  const market=marketId?MARKETS[marketId]:null;
  const phase=getPhase(quarter);

  const allPlayers = bs ? [
    {id:"player",name:"あなた",icon:"⭐",color:C.cyan,isPlayer:true,netWorth:equity(bs),totalAssets:totalAssets(bs),stores:Math.floor(ops.stores)||0,bs,ops},
    ...npcs.map(n=>({...n,netWorth:equity(n.bs),totalAssets:totalAssets(n.bs),stores:Math.floor(n.ops.stores)||0}))
  ].sort((a,b)=>b.netWorth-a.netWorth) : [];

  // ★ プレイ履歴の保存：gameover画面に到達した時点で1回だけ記録する
  useEffect(() => {
    if (screen !== "gameover" || onlineMode || hasSavedRecordRef.current) return;
    if (!bs || allPlayers.length === 0) return;
    hasSavedRecordRef.current = true;

    const rank = allPlayers.findIndex(p => p.isPlayer) + 1;
    const allocSum = Object.values(playStats.allocTotals).reduce((s,v)=>s+v, 0) || 1;
    const allocRatios = {};
    Object.entries(playStats.allocTotals).forEach(([k,v]) => { allocRatios[k] = Math.round(v/allocSum*100); });

    savePlayRecord({
      playedAt: Date.now(),
      marketId, playerType,
      netWorth: equity(bs),
      stores: ops.stores || 0,
      rank,
      allocRatios, // 投資配分の傾向（%）
      devFocusAttempts: playStats.devFocusAttempts,
      devFocusMatches: playStats.devFocusMatches,
      priceChangeCount: playStats.priceChangeCount,
      borrowCount: playStats.borrowCount,
      finalPrice: ops.setPrice || 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  if (screen==="tutorial") return (
    <TutorialScreen onComplete={()=>{
      try { localStorage.setItem(TUTORIAL_KEY,"1"); } catch {}
      setTutorialDone(true);
      setScreen("lobby");
    }}/>
  );
  if (screen==="history") return (
    <PlayHistoryScreen onBack={()=>setScreen("lobby")}/>
  );
  if (screen==="lobby") return (
    <OnlineLobby
      room={room}
      onTutorial={()=>setScreen("tutorial")}
      onHistory={()=>setScreen("history")}
      onSolo={(info) => {
        if (info && info.mode === "online") {
          // オンラインモード：ゲーム開始
          // gameStateから自分の初期bs/opsをセットしてからplay画面へ
          const myState = info.gameState?.[info.playerId];
          const pt = PLAYER_TYPES[info.playerType];
          setOnlineMode(true);
          setOnlineInfo(info);
          setMarketId(info.marketId);
          setPlayerType(info.playerType);
          setBs(myState?.bs || {...pt.bs});
          setOps(myState?.ops || {...pt.ops});
          // NPC初期化（自分以外のプレイヤーをNPCとして扱う）
          const otherPlayers = Object.entries(info.allPlayers || {})
            .filter(([pid]) => pid !== info.playerId)
            .map(([pid, p]) => ({
              id: pid,
              name: p.name,
              type: p.playerType,
              icon: PLAYER_TYPES[p.playerType]?.icon || "👤",
              color: ["#FF6B6B","#4ECDC4","#FFE66D"][Object.keys(info.allPlayers).indexOf(pid) % 3],
              strategy: "sales_heavy",
              bs: {...PLAYER_TYPES[p.playerType]?.bs},
              ops: {...PLAYER_TYPES[p.playerType]?.ops},
            }));
          setNpcs(otherPlayers);
          setQuarter(info.quarter || 1);
          setScreen("play");
        } else {
          // ソロモード
          setOnlineMode(false);
          setScreen("market");
        }
      }}
    />
  );
  if (screen==="market") return <SetupMarket onNext={id=>{setMarketId(id);setScreen("type");}}/>;
  if (screen==="type")   return <SetupType marketId={marketId} onBack={()=>setScreen("market")} onStart={startGame}/>;

  // CHOICE EVENT SCREEN
  if (screen === "choice" && pendingChoice) {
    const ev = pendingChoice;
    const catColor = {market:C.green,rival:C.red,chance:C.cyan,risk:C.orange,platform:C.purple,choice:C.yellow}[ev.cat]||C.yellow;
    return (
      <div style={bgBase}>
        <div style={{maxWidth:600,margin:"0 auto",padding:"48px 20px"}}>
          <div style={{textAlign:"center",marginBottom:32}}>
            <div style={{fontSize:48,marginBottom:12}}>{ev.icon}</div>
            <div style={{fontSize:11,letterSpacing:4,color:catColor,textTransform:"uppercase",marginBottom:8}}>突発イベント — 選択</div>
            <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:"0 0 10px"}}>{ev.name}</h2>
            <p style={{fontSize:13,color:C.muted,lineHeight:1.6}}>{ev.desc}</p>
          </div>
          <div style={{display:"grid",gap:14,marginBottom:24}}>
            {ev.choices.map((choice,i)=>(
              <div key={i} onClick={()=>resolveChoice(i)} style={{
                background:C.panel,border:`2px solid ${C.border}`,borderRadius:14,padding:"20px 22px",cursor:"pointer",transition:"all 0.2s",
              }}>
                <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                  <span style={{fontSize:28,flexShrink:0}}>{choice.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:16,fontWeight:800,color:C.text,marginBottom:6}}>{choice.label}</div>
                    <div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>{choice.desc}</div>
                    <div style={{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}}>
                      {choice.storeBonus&&<span style={{fontSize:11,background:`${C.green}22`,color:C.green,padding:"2px 10px",borderRadius:20}}>店舗+{choice.storeBonus}</span>}
                      {choice.bsCost&&<span style={{fontSize:11,background:`${C.red}22`,color:C.red,padding:"2px 10px",borderRadius:20}}>現金-{choice.bsCost}万</span>}
                      {choice.permanentOpex&&<span style={{fontSize:11,background:`${C.orange}22`,color:C.orange,padding:"2px 10px",borderRadius:20}}>固定費+{choice.permanentOpex}万/Q</span>}
                      {choice.opsBoost&&Object.entries(choice.opsBoost).map(([k,v])=>(
                        <span key={k} style={{fontSize:11,background:`${C.cyan}22`,color:C.cyan,padding:"2px 10px",borderRadius:20}}>
                          {({salesPower:"営業力",solutionQuality:"品質",brandAwareness:"ブランド",supportQuality:"CS"})[k]||k}+{v}
                        </span>
                      ))}
                      {choice.opsRisk&&Object.entries(choice.opsRisk).filter(([k])=>k!=="randomParam"&&k!=="storeRatio").map(([k,v])=>(
                        <span key={k} style={{fontSize:11,background:`${C.red}22`,color:C.red,padding:"2px 10px",borderRadius:20}}>
                          {({salesPower:"営業力",solutionQuality:"品質",brandAwareness:"ブランド",supportQuality:"CS"})[k]||k}{v}
                        </span>
                      ))}
                      {choice.cashGain&&<span style={{fontSize:11,background:`${C.green}22`,color:C.green,padding:"2px 10px",borderRadius:20}}>現金+{choice.cashGain}万</span>}
                      {choice.capitalGain&&<span style={{fontSize:11,background:`${C.cyan}22`,color:C.cyan,padding:"2px 10px",borderRadius:20}}>資本金+{choice.capitalGain}万</span>}
                      {choice.effect==="none"&&<span style={{fontSize:11,background:`${C.muted}22`,color:C.muted,padding:"2px 10px",borderRadius:20}}>変化なし</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:C.muted,textAlign:"center"}}>
            いずれかを選択してください。この決断は取り消せません。
          </div>
        </div>
      </div>
    );
  }

  // PRICE SETTING SCREEN（年次レビュー後）
  if (screen === "pricesetting" && pendingPrice) {
    return <PriceSettingScreen pendingPrice={pendingPrice} onConfirm={confirmPrice} />;
  }

  // YEAR REVIEW SCREEN
  if (screen === "yearreview") {
    // quarterはyearreview遷移時点の値（Q4またはQ8）
    const completedYear = quarter <= 4 ? 1 : quarter <= 8 ? 2 : 3;
    const qStart = (completedYear - 1) * 4 + 1;
    const qEnd   = completedYear * 4;

    // historyからYear分を抽出（quarterが一致するものを使う）
    const yearHistory = history.filter(h => h.quarter >= qStart && h.quarter <= qEnd);

    // ★ 直接bs/opsから取る（historyが空でも表示できる）
    const yearEndTA     = equity(bs);
    const yearEndStores = Math.floor(ops.stores) || 0;

    const prevYearEndTA = completedYear > 1
      ? (history.find(h => h.quarter === qStart - 1)?.netWorth || 0)
      : equity(PLAYER_TYPES[playerType]?.bs || {capital:0, retainedEarnings:0});
    const taGrowth = yearEndTA - prevYearEndTA;

    const phaseNext = getPhase(qEnd + 1);

    // グラフ用：historyがあれば使い、なければ現在値だけ
    const chartData = yearHistory.length > 0 ? yearHistory : [{
      quarter: qEnd, netWorth: yearEndTA, stores: yearEndStores,
      netIncome: lastNetIncome, phase: getPhase(qEnd).name
    }];
    const maxTA     = Math.max(...chartData.map(h => h.netWorth), yearEndTA, 1);
    const maxStores = Math.max(...chartData.map(h => h.stores), yearEndStores, 1);
    const lastSnapshot = yearHistory[yearHistory.length-1]?.npcSnapshot
      || npcs.map(n => ({id:n.id, name:n.name, color:n.color, stores:Math.floor(n.ops.stores)||0, netWorth:equity(n.bs)}));

    return (
      <div style={bgBase}>
        <div style={{maxWidth:640, margin:"0 auto", padding:"32px 20px"}}>
          {/* ヘッダー */}
          <div style={{textAlign:"center", marginBottom:24}}>
            <Label style={{display:"block", marginBottom:8}}>Year Review</Label>
            <h1 style={{fontSize:28, fontWeight:900, margin:0, color:C.text}}>
              Year {completedYear} 終了
            </h1>
            <div style={{marginTop:10, display:"flex", justifyContent:"center", gap:8}}>
              <span style={{fontSize:12, color:C.muted}}>次フェーズ：</span>
              <PhaseTag phase={phaseNext}/>
            </div>
            <div style={{fontSize:12, color:C.muted, marginTop:6}}>{phaseNext.desc}</div>
          </div>

          {/* KPI */}
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:20}}>
            {[
              ["🏦 期末総資産", `¥${yearEndTA.toLocaleString()}万`, C.cyan],
              ["📈 年間総資産増減", `${taGrowth>=0?"+":""}¥${taGrowth.toLocaleString()}万`, taGrowth>=0?C.green:C.red],
              ["🏪 期末店舗数", `${yearEndStores}店`, C.text],
            ].map(([l,v,c])=>(
              <Panel key={l} style={{textAlign:"center", padding:"12px 8px"}}>
                <div style={{fontSize:16, fontWeight:900, color:c, fontFamily:"'Courier New',monospace"}}>{v}</div>
                <Label style={{display:"block", marginTop:4, fontSize:9}}>{l}</Label>
              </Panel>
            ))}
          </div>

          {/* 純資産推移バーグラフ */}
          <Panel style={{marginBottom:14}}>
            <Label style={{display:"block", marginBottom:10}}>純資産推移（Year {completedYear}）</Label>
            <div style={{display:"flex", alignItems:"flex-end", gap:6, height:80}}>
              {chartData.map((h,i)=>(
                <div key={i} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
                  <div style={{fontSize:9, color:C.muted, fontFamily:"'Courier New',monospace"}}>
                    ¥{Math.round(h.netWorth/100)/10}k
                  </div>
                  <div style={{width:"100%", background:h.netIncome>=0?C.cyan:C.red, borderRadius:"3px 3px 0 0",
                    height:`${Math.max(4, h.netWorth/maxTA*64)}px`,
                    boxShadow:`0 0 8px ${h.netIncome>=0?C.cyan:C.red}66`, transition:"height 0.4s"}}/>
                  <span style={{fontSize:9, color:C.muted}}>Q{((h.quarter-1)%4)+1}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* 店舗推移バーグラフ */}
          <Panel style={{marginBottom:14}}>
            <Label style={{display:"block", marginBottom:10}}>店舗数推移（Year {completedYear}）</Label>
            <div style={{display:"flex", alignItems:"flex-end", gap:6, height:60}}>
              {chartData.map((h,i)=>(
                <div key={i} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
                  <div style={{fontSize:9, color:C.muted}}>{h.stores}</div>
                  <div style={{width:"100%", background:C.purple, borderRadius:"3px 3px 0 0",
                    height:`${Math.max(4, h.stores/maxStores*48)}px`,
                    boxShadow:`0 0 6px ${C.purple}66`}}/>
                  <span style={{fontSize:9, color:C.muted}}>Q{((h.quarter-1)%4)+1}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* 競合比較 */}
          {lastSnapshot.length > 0 && (
            <Panel style={{marginBottom:14}}>
              <Label style={{display:"block", marginBottom:10}}>期末シェア比較（純資産）</Label>
              {[{name:"あなた", stores:yearEndStores, color:C.cyan, ta:yearEndTA}, ...lastSnapshot.map(n=>({name:n.name, stores:n.stores, color:n.color, ta:n.netWorth}))].map((p,i)=>{
                const maxTAAll = Math.max(...[yearEndTA, ...lastSnapshot.map(n=>n.netWorth)], 1);
                return (
                  <div key={i} style={{marginBottom:10}}>
                    <div style={{display:"flex", justifyContent:"space-between", marginBottom:4}}>
                      <span style={{fontSize:12, fontWeight:700, color:p.color}}>{p.name}</span>
                      <span style={{fontSize:11, color:C.muted, fontFamily:"'Courier New',monospace"}}>
                        {p.stores}店 / ¥{p.ta.toLocaleString()}万
                      </span>
                    </div>
                    <div style={{background:C.border, borderRadius:3, height:6, overflow:"hidden"}}>
                      <div style={{width:`${p.ta/maxTAAll*100}%`, height:"100%",
                        background:p.color, borderRadius:3, boxShadow:`0 0 6px ${p.color}66`}}/>
                    </div>
                  </div>
                );
              })}
            </Panel>
          )}

          {/* 次年度へのメッセージ */}
          <Panel style={{marginBottom:20, background:`${phaseNext.color}0A`, border:`1px solid ${phaseNext.color}33`}}>
            <div style={{fontSize:13, fontWeight:700, color:phaseNext.color, marginBottom:6}}>
              {phaseNext.icon} Year {completedYear+1}の戦略ポイント
            </div>
            <div style={{fontSize:12, color:C.muted, lineHeight:1.6}}>
              {phaseNext.id === "growth" && "市場が急拡大。未獲得市場が広がる今こそ積極投資を。営業とブランドへの配分を厚くしてシェアを先取りせよ。"}
              {phaseNext.id === "mature" && "未開拓は残り僅か。競合からの奪取が主戦場となる。品質とCSで解約を防ぎ、スコア差をつけて競合店舗を奪いに行け。"}
              {phaseNext.id === "dawn" && "市場黎明期。先行者優位が大きい。まず足場を固めることが最優先。"}
            </div>
          </Panel>

          <button onClick={advanceFromYearReview}
            style={{width:"100%", background:`linear-gradient(135deg,#006080,${C.cyan})`,
              color:"#fff", border:"none", borderRadius:10, padding:16,
              fontSize:15, fontWeight:700, cursor:"pointer", letterSpacing:2,
              boxShadow:`0 4px 20px ${C.cyan}44`}}>
            Year {completedYear+1} へ →
          </button>
        </div>
      </div>
    );
  }


  if (screen==="gameover") {
    const rank=allPlayers.findIndex(p=>p.isPlayer)+1;
    const pf=allPlayers.find(p=>p.isPlayer);
    return (
      <div style={bgBase}>
        <div style={{maxWidth:600,margin:"0 auto",padding:"60px 24px",textAlign:"center"}}>
          <div style={{fontSize:60,marginBottom:12}}>{rank===1?"🏆":rank===2?"🥈":"🥉"}</div>
          <h1 style={{fontSize:30,fontWeight:900,margin:0,background:`linear-gradient(135deg,${C.text},${C.cyan})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>GAME OVER</h1>
          <div style={{color:C.muted,margin:"10px 0 32px",fontSize:13}}>3年間の経営シミュレーション終了</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:28}}>
            {[["💰 純資産",`¥${equity(pf?.bs||{capital:0,retainedEarnings:0}).toLocaleString()}万`,C.cyan],
              ["🏪 最終店舗",`${pf?.stores||0}店`,C.green],
              ["🏅 順位",`${rank}位`,rank===1?C.yellow:C.text]
            ].map(([l,v,c])=>(
              <Panel key={l} style={{padding:"12px 8px",textAlign:"center"}}>
                <div style={{fontSize:17,fontWeight:900,color:c,fontFamily:"'Courier New',monospace"}}>{v}</div>
                <Label style={{display:"block",marginTop:4}}>{l}</Label>
              </Panel>
            ))}
          </div>
          <Panel style={{marginBottom:28}}>
            <Label style={{display:"block",marginBottom:12}}>最終スコアボード（純資産）</Label>
            {allPlayers.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:i<allPlayers.length-1?`1px solid ${C.border}`:"none"}}>
                <span style={{fontSize:20}}>{i===0?"🥇":i===1?"🥈":"🥉"}</span>
                <span style={{fontSize:20}}>{p.icon}</span>
                <div style={{flex:1,textAlign:"left"}}>
                  <div style={{fontSize:13,fontWeight:700,color:p.color}}>{p.name}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:15,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{p.netWorth.toLocaleString()}万</div>
                  <div style={{fontSize:10,color:C.muted}}>{p.stores}店舗</div>
                </div>
              </div>
            ))}
          </Panel>
          <button onClick={()=>{
            setScreen("lobby");setMarketId(null);setPlayerType(null);setBs(null);setOps(null);
            setQuarter(1);setUsedSpecials([]);setHistory([]);setLastPL(null);setLastEvent(null);
            setLastNetIncome(0);setPrevNpcOps({});setNarratives([]);setPrevOps(null);setInvestTarget(null);setBorrowedThisQuarter(0);setMarketNeed(null);setTruceProposals([]);
            hasSavedRecordRef.current = false;
            setPlayStats({allocTotals:{sales:0,dev:0,marketing:0,cs:0}, devFocusAttempts:0, devFocusMatches:0, priceChangeCount:0, borrowCount:0});
            setAllocation({sales:0,dev:0,marketing:0,price:0,cs:0});
            setOnlineMode(false);setOnlineInfo(null);
            setPendingChoice(null);setPendingPrice(null);setActiveEffects([]);setPermanentOpexExtra(0);
          }}
            style={{background:`linear-gradient(135deg,#006080,${C.cyan})`,color:"#fff",border:"none",borderRadius:10,padding:"14px 48px",fontSize:15,fontWeight:700,cursor:"pointer",letterSpacing:2}}>
            もう一度プレイ
          </button>
        </div>
      </div>
    );
  }

  // BATTLEFIELD SCENE：陣取り合戦の専用シーン
  if (screen === "battlefield" && lastPL && market) {
    const cr = lastPL.competResult || {};
    const prevPlayerStores = Math.max(0, Math.floor((ops.stores||0) - (cr.newFromUnclaimed||0) - (cr.stolenFromRivals||0) + (cr.naturalChurn||0) + (cr.lostToRivals||0)));
    const finalPlayerStores = Math.floor(ops.stores) || 0;
    return (
      <BattleBoardScene
        npcs={npcs}
        prevPlayerStores={prevPlayerStores}
        finalPlayerStores={finalPlayerStores}
        competResult={cr}
        market={market}
        quarter={quarter}
        onContinue={() => setScreen("result")}
      />
    );
  }
  // ★ フォールバック：battlefield画面に来たがmarketが取得できない等の異常時は、
  //   画面が固まらないよう自動的にresultへ進める（Q1等での原因不明な表示崩れの保険）
  if (screen === "battlefield" && lastPL && !market) {
    setTimeout(() => setScreen("result"), 0);
    return <div style={bgBase}/>;
  }

  // QUARTER RESULT
  if (screen==="result" && lastPL) {
    const cr = lastPL.competResult;
    return (
      <div style={bgBase}>
        <div style={{maxWidth:640,margin:"0 auto",padding:"32px 20px"}}>
          <div style={{textAlign:"center",marginBottom:20}}>
            <Label style={{display:"block",marginBottom:6}}>Quarter Report</Label>
            <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:"0 0 8px"}}>Year {yr} Q{qq} — 決算</h2>
            <PhaseTag phase={phase}/>
          </div>
          {lastEvent && (
            <div style={{background:`${C.yellow}10`,border:`1px solid ${C.yellow}33`,borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",gap:12,alignItems:"flex-start"}}>
              <span style={{fontSize:26}}>{lastEvent.icon}</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:C.yellow}}>{lastEvent.name}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:2}}>{lastEvent.desc}</div>
              </div>
            </div>
          )}

          {/* ① 原因：前Q投資の反映 */}
          {prevOps && (() => {
            const changes = [
              ["👥 営業力", "salesPower", C.cyan],
              ["⚙️ 品質", "solutionQuality", C.purple],
              ["📢 ブランド", "brandAwareness", C.yellow],
              ["🎧 CS", "supportQuality", C.orange],
            ].map(([label, key, color]) => ({
              label, color, diff: ops[key] - prevOps[key],
            })).filter(c => Math.abs(c.diff) >= 0.05);

            if (changes.length === 0 && !ops.lastDevFocusResult) return null;
            return (
              <Panel style={{marginBottom:14}}>
                <Label style={{display:"block",marginBottom:10}}>⏳ 前Qの投資が反映されました</Label>
                {changes.length > 0 && (
                  <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                    {changes.map(c => (
                      <span key={c.label} style={{
                        fontSize:11, fontWeight:700,
                        color: c.diff >= 0 ? c.color : C.red,
                        background: `${c.diff >= 0 ? c.color : C.red}18`,
                        padding:"4px 10px", borderRadius:20,
                      }}>
                        {c.label} {c.diff >= 0 ? "+" : ""}{c.diff.toFixed(1)}
                      </span>
                    ))}
                  </div>
                )}
                {/* ★ devFocusの当たり/外れ判定（市場ニーズは事後にだけ開示） */}
                {ops.lastDevFocusResult && (() => {
                  const r = ops.lastDevFocusResult;
                  const chosen = DEV_FOCUS_TYPES[r.focus];
                  const actual = DEV_FOCUS_TYPES[r.marketNeed];
                  return (
                    <div style={{
                      marginTop: changes.length > 0 ? 10 : 0, paddingTop: changes.length > 0 ? 10 : 0,
                      borderTop: changes.length > 0 ? `1px dashed ${C.border}` : "none",
                    }}>
                      <div style={{fontSize:11, fontWeight:700, color: r.matched ? C.green : C.orange, marginBottom:4}}>
                        {r.matched ? "🎯 的中！市場ニーズと一致" : "💭 ミスマッチ：市場が求めていたのは別の価値だった"}
                      </div>
                      <div style={{fontSize:10, color:C.muted}}>
                        選んだ方向性：{chosen?.icon} {chosen?.name}　/　市場の実際のニーズ：{actual?.icon} {actual?.name}
                      </div>
                      <div style={{fontSize:10, color: r.matched ? C.green : C.orange, marginTop:2}}>
                        効果は通常の{r.matched ? "1.3倍" : "0.8倍"}でした
                      </div>
                    </div>
                  );
                })()}
              </Panel>
            );
          })()}

          {/* ①.5 外交：不戦条約の結果 */}
          {lastPL.truceResults && Object.keys(lastPL.truceResults).length > 0 && (
            <Panel style={{marginBottom:14}}>
              <Label style={{display:"block",marginBottom:8}}>🤝 不戦条約の結果</Label>
              <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                {Object.entries(lastPL.truceResults).map(([rivalId, accepted]) => {
                  const npc = npcs.find(n => n.id === rivalId);
                  const onlinePlayer = onlineMode ? (room.players||[]).find(p => p.id === rivalId) : null;
                  const displayName = npc?.name || onlinePlayer?.name || rivalId;
                  return (
                    <span key={rivalId} style={{
                      fontSize:11, fontWeight:700,
                      color: accepted ? C.green : C.red,
                      background: `${accepted ? C.green : C.red}18`,
                      padding:"4px 10px", borderRadius:20,
                    }}>
                      {displayName}：{accepted ? "✅ 合意成立" : "❌ 拒否された"}
                    </span>
                  );
                })}
              </div>
            </Panel>
          )}

          {/* ② 過程：競争ナラティブ */}
          {narratives.length > 0 && (
            <div style={{display:"grid",gap:8,marginBottom:14}}>
              {narratives.map((msg,i) => (
                <div key={i} style={{
                  background:`${msg.color}12`,
                  border:`1px solid ${msg.color}44`,
                  borderLeft:`3px solid ${msg.color}`,
                  borderRadius:8, padding:"10px 14px",
                  display:"flex", gap:12, alignItems:"flex-start"
                }}>
                  <span style={{fontSize:20,flexShrink:0}}>{msg.icon}</span>
                  <span style={{fontSize:12,color:"#F0F6FC",lineHeight:1.5}}>{msg.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* ② 過程：戦況バトルカード（奪取/解約の内訳） */}
          <BattleResultCard
            competResult={cr}
            prevStores={Math.max(0, Math.floor((ops.stores||0) - (cr?.newFromUnclaimed||0) - (cr?.stolenFromRivals||0) + (cr?.naturalChurn||0) + (cr?.lostToRivals||0)))}
            finalStores={Math.floor(ops.stores)||0}
          />

          {/* ③ 結果：マーケットシェア */}
          <Panel style={{marginBottom:14}}>
            <Label style={{display:"block",marginBottom:12}}>マーケットシェア</Label>
            <MarketShareChart
              players={[
                {name:"あなた", stores:Math.floor(ops.stores)||0, color:"#00C8D4", isPlayer:true},
                ...npcs.map(n=>({name:n.name, stores:Math.floor(n.ops.stores)||0, color:n.color, isPlayer:false}))
              ]}
              market={market}
              quarter={quarter}
            />
          </Panel>

          {/* ③ 結果：店舗数トレンドからの観測ベース警告（内部スコアは見せない） */}
          {(() => {
            // ★ 競合の内部パラメータ・スコアは非公開。観測可能な「店舗数の伸び」だけで警戒を促す。
            const threats = npcs.filter(n => {
              const prev = prevNpcOps[n.id];
              if (!prev) return false;
              const growthRate = prev.stores > 0 ? (n.ops.stores - prev.stores) / prev.stores : 0;
              return growthRate > 0.15; // 15%以上の急成長を観測したら警戒
            });
            if (threats.length === 0) return null;
            return (
              <div style={{background:"#F8514912",border:"1px solid #F8514944",borderRadius:8,padding:"10px 14px",marginBottom:14}}>
                <div style={{fontSize:12,fontWeight:700,color:"#F85149",marginBottom:6}}>⚠️ 競合の急成長を観測</div>
                {threats.map(n => {
                  const prev = prevNpcOps[n.id];
                  const growthPct = prev.stores > 0 ? Math.round((n.ops.stores - prev.stores) / prev.stores * 100) : 0;
                  return (
                    <div key={n.id} style={{fontSize:11,color:"#8B949E",marginTop:3}}>
                      <span style={{color:n.color,fontWeight:700}}>{n.name}</span>
                      {" "}が前Qから店舗数+{growthPct}%。何を強化したのかは不明だが、警戒が必要かもしれない。
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* ④ 数字：PL/BS組成アニメーション */}
          <PLBuildAnimation pl={lastPL} quarter={quarter} onComplete={() => setBsAnimReady(true)}/>

          {bsAnimReady && <BSBuildAnimation bs={bs} quarter={quarter}/>}

          {/* ⑤ 将来予測：競合の動向（観測可能な情報のみ） */}
          <Panel style={{marginTop:14}}>
            <Label style={{display:"block",marginBottom:10}}>競合の動向</Label>
            {npcs.map(n => {
              return (
                <div key={n.id} style={{
                  padding:"10px 0", borderBottom:`1px solid ${C.border}`,
                }}>
                  <div style={{display:"flex",gap:12,alignItems:"center"}}>
                    <span style={{fontSize:20}}>{n.icon}</span>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:13,fontWeight:700,color:n.color}}>{n.name}</span>
                        {n.lastSpecial && (
                          <span style={{fontSize:10,background:`${C.cyan}22`,color:C.cyan,padding:"1px 8px",borderRadius:20}}>
                            ⚡ 何らかの特別アクションを実施
                          </span>
                        )}
                      </div>
                      {/* ★ 観測可能な情報のみ：店舗数の増減（内部パラメータは非公開） */}
                      {prevNpcOps[n.id] && (() => {
                        const prev = prevNpcOps[n.id];
                        const storeDiff = (n.ops.stores||0) - (prev.stores||0);
                        if (Math.abs(storeDiff) < 1) return null;
                        return (
                          <span style={{
                            fontSize:10, fontWeight:700,
                            color: storeDiff > 0 ? C.green : C.red,
                            background: `${storeDiff > 0 ? C.green : C.red}18`,
                            padding:"1px 8px", borderRadius:20,
                          }}>
                            店舗数 {storeDiff>0?"+":""}{storeDiff}
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontWeight:700,color:C.cyan,fontFamily:"'Courier New',monospace"}}>
                        ¥{equity(n.bs).toLocaleString()}万
                      </div>
                      <div style={{fontSize:10,color:C.muted}}>
                        {n.ops.stores}店
                      </div>
                    </div>
                  </div>
                  {/* ★ シェア比較バー：内部スコアではなく店舗数（観測可能）で表示 */}
                  <div style={{marginTop:8, display:"flex", alignItems:"center", gap:6}}>
                    <span style={{fontSize:9, color:C.cyan, width:20, flexShrink:0}}>You</span>
                    <div style={{flex:1, height:6, background:C.border, borderRadius:3, overflow:"hidden", display:"flex"}}>
                      <div className="sb-bar-fill" style={{
                        height:"100%",
                        width: `${(ops.stores/(Math.max(1,ops.stores+n.ops.stores)))*100}%`,
                        background: C.cyan, borderRadius:"3px 0 0 3px",
                      }}/>
                      <div className="sb-bar-fill" style={{
                        height:"100%",
                        width: `${(n.ops.stores/(Math.max(1,ops.stores+n.ops.stores)))*100}%`,
                        background: n.color, borderRadius:"0 3px 3px 0",
                      }}/>
                    </div>
                    <span style={{fontSize:9, color:n.color, width:20, flexShrink:0, textAlign:"right"}}>{n.name.slice(0,2)}</span>
                  </div>
                </div>
              );
            })}
            <div style={{marginTop:10, fontSize:9, color:C.muted, textAlign:"center"}}>
              ※ 競合の内部パラメータ・投資内容は非公開。観測できるのは店舗数と資産規模のみ。
            </div>
          </Panel>

          {/* ⑥ 振り返り：今期の予算配分 */}
          {lastPL.playerAlloc && (
            <Panel style={{marginTop:14}}>
              <Label style={{display:"block",marginBottom:8}}>📝 今期の予算配分（振り返り）</Label>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {BUDGET_ITEMS.map(item=>{
                  const v=lastPL.playerAlloc[item.id]||0;
                  return v>0?(
                    <div key={item.id} style={{background:`${item.color}18`,border:`1px solid ${item.color}44`,borderRadius:20,padding:"3px 12px",fontSize:11,color:item.color,fontWeight:700}}>
                      {item.icon} {item.name} ¥{v}万
                    </div>
                  ):null;
                })}
                {lastPL.playerSpecial && (
                  <div style={{background:`${C.cyan}18`,border:`1px solid ${C.cyan}44`,borderRadius:20,padding:"3px 12px",fontSize:11,color:C.cyan,fontWeight:700}}>
                    ⚡ {SPECIAL_ACTIONS[lastPL.playerSpecial]?.name}
                  </div>
                )}
              </div>
            </Panel>
          )}

          <button onClick={advance} style={{marginTop:18,width:"100%",background:`linear-gradient(135deg,#006080,${C.cyan})`,color:"#fff",border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",letterSpacing:2}}>
            {quarter>=MAX_QUARTERS
              ? "最終結果を見る 🏁"
              : quarter%4===0
                ? `Year ${quarter/4} 振り返りへ →`
                : `Year ${Math.ceil((quarter+1)/4)} Q${(quarter%4)+1} へ →`}
          </button>
        </div>
      </div>
    );
  }

  // MAIN PLAY SCREEN
  return (
    <div style={bgBase}>
      {/* Header */}
      <div style={{background:"#010810",borderBottom:`1px solid ${C.border}`,padding:"10px 20px",position:"sticky",top:0,zIndex:10}}>
        <div style={{maxWidth:900,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontSize:10,letterSpacing:3,color:C.cyan,textTransform:"uppercase"}}>LINE Mini App SaaS Battle</div>
            <div style={{fontSize:15,fontWeight:900,color:C.text,marginTop:2}}>{market?.icon} {market?.name}</div>
          </div>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>Y{yr} Q{qq}</div>
            {onlineMode && room.players.length > 0 && (
              <div style={{display:"flex",gap:6,justifyContent:"center",marginTop:4}}>
                {room.players.map(p=>(
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:p.ready?C.green:C.muted}}/>
                    <span style={{color:p.id===room.playerId?C.cyan:C.muted}}>{p.name}</span>
                  </div>
                ))}
              </div>
            )}
            <PhaseTag phase={phase}/>
            <div style={{width:100,height:3,background:C.border,borderRadius:2,margin:"4px auto 0"}}>
              <div style={{width:`${quarter/MAX_QUARTERS*100}%`,height:"100%",background:C.cyan,borderRadius:2}}/>
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:9,color:C.muted,letterSpacing:2,textTransform:"uppercase"}}>純資産（勝利条件）</div>
            <div style={{fontSize:18,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{equity(bs).toLocaleString()}万</div>
            <div style={{fontSize:10,color:bs.cash<50?C.red:C.muted}}>現預金 ¥{bs.cash}万</div>
          </div>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"16px 16px 40px"}}>
        {/* KPI Row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {[["💰 純資産",`¥${equity(bs).toLocaleString()}万`,equity(bs)>=0?C.cyan:C.red,true],
            ["🏦 総資産",`¥${totalAssets(bs).toLocaleString()}万`,C.muted],
            ["🏪 店舗数",`${ops.stores}店`,C.text],
            ["💳 借入金",`¥${bs.debt}万`,bs.debt>0?C.yellow:C.muted],
            ["🎯 競争力",`${competitiveScore(ops, market?.arpu).toFixed(0)}`,C.purple],
          ].map(([l,v,c,h])=>(
            <Panel key={l} style={{textAlign:"center",padding:"8px 6px",border:`1px solid ${h?C.cyan:C.border}`,boxShadow:h?`0 0 16px ${C.cyan}22`:"none"}}>
              <div style={{fontSize:h?16:14,fontWeight:900,color:c,fontFamily:"'Courier New',monospace"}}>{v}</div>
              <Label style={{display:"block",marginTop:2,fontSize:9}}>{l}</Label>
            </Panel>
          ))}
        </div>

        {/* フェーズ説明 */}
        <div style={{background:`${phase.color}0A`,border:`1px solid ${phase.color}33`,borderRadius:10,padding:"8px 16px",marginBottom:14,display:"flex",gap:12,alignItems:"center"}}>
          <span style={{fontSize:20}}>{phase.icon}</span>
          <div style={{flex:1}}>
            <span style={{fontSize:12,fontWeight:700,color:phase.color}}>{phase.name}</span>
            <span style={{fontSize:11,color:C.muted,marginLeft:8}}>{phase.desc}</span>
          </div>
          <div style={{fontSize:11,color:C.muted}}>
            未獲得市場: {Math.max(0,Math.floor(market.totalStores*marketPenetration(quarter))-ops.stores-npcs.reduce((s,n)=>s+n.ops.stores,0))}店
          </div>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:4,marginBottom:14,background:C.panel,borderRadius:10,padding:4}}>
          {[["budget","💰 予算配分"],["diplomacy","🤝 外交"],["special","⚡ 特別アクション"],["bs","🏦 BS/財務"],["ops","📊 競争力"],["rank","🏆 順位"]].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flex:1,background:tab===id?`linear-gradient(135deg,#006080,${C.cyan})`:"transparent",color:tab===id?"#fff":C.muted,border:"none",borderRadius:8,padding:"8px 4px",fontSize:11,fontWeight:600,cursor:"pointer",transition:"all 0.18s"}}>
              {label}
            </button>
          ))}
        </div>

        {/* BUDGET TAB */}
        {tab==="budget" && (
          <>
            {/* Stage2: 投資目標額の入力 */}
            <Panel style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
                <Label>🎯 今期の投資目標額</Label>
                <span style={{fontSize:10,color:C.muted}}>自己資金上限: ¥{selfFundCapacity}万</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:14,color:C.muted}}>¥</span>
                <input
                  type="number" inputMode="numeric"
                  value={investTarget ?? selfFundCapacity}
                  onChange={e => {
                    const v = Math.max(0, Number(e.target.value) || 0);
                    setInvestTarget(v);
                  }}
                  style={{
                    flex:1, background:C.bg, border:`2px solid ${shortfall>0?C.red:C.cyan}`, borderRadius:8,
                    padding:"10px 14px", color:C.text, fontSize:18, fontWeight:800,
                    fontFamily:"'Courier New',monospace", outline:"none", textAlign:"right",
                  }}
                />
                <span style={{fontSize:12,color:C.muted,flexShrink:0}}>万円</span>
              </div>
              {shortfall > 0 ? (
                <div style={{marginTop:10,padding:"8px 12px",background:`${C.red}12`,border:`1px solid ${C.red}44`,borderRadius:8,fontSize:11,color:C.red}}>
                  ⚠️ 自己資金だけでは¥{shortfall}万足りません。
                  <br/>今期は自己資金上限の¥{availableBudget}万までしか配分できません。
                  <button onClick={() => setShowBorrowPanel(v => !v)} style={{
                    marginTop:8, width:"100%", padding:"8px 0", borderRadius:8, border:`1px solid ${C.cyan}`,
                    background:`${C.cyan}15`, color:C.cyan, fontSize:11, fontWeight:700, cursor:"pointer",
                  }}>
                    🏦 借入で補う →
                  </button>
                </div>
              ) : (
                <div style={{marginTop:8,fontSize:10,color:C.muted}}>
                  自己資金で目標を満たせます（¥{availableBudget}万を配分可能）
                </div>
              )}

              {/* Stage3: 借入確認パネル */}
              {showBorrowPanel && (() => {
                const limit = maxBorrowable(bs);
                const suggested = Math.min(shortfall, limit);
                const de = deRatio(bs);
                const canBorrowEnough = limit >= shortfall;
                return (
                  <div style={{marginTop:10, padding:"12px", background:C.bg, border:`1px solid ${C.cyan}44`, borderRadius:8}}>
                    <div style={{fontSize:11, color:C.muted, marginBottom:8}}>
                      現在のD/Eレシオ: {de===Infinity?"∞":(de*100).toFixed(0)+"%"}（上限200%）
                      <br/>借入可能上限: ¥{limit}万
                    </div>
                    {limit <= 0 ? (
                      <div style={{fontSize:11, color:C.red}}>
                        ⚠️ D/Eレシオが上限に達しているため、これ以上借入できません。
                      </div>
                    ) : (
                      <>
                        <div style={{fontSize:11, color:C.text, marginBottom:8}}>
                          ¥{suggested}万を借入（4Q均等返済、金利{(INTEREST_RATE*100).toFixed(0)}%/Q）
                          {!canBorrowEnough && <span style={{color:C.orange}}>　※不足分を全額カバーできません</span>}
                        </div>
                        <button onClick={() => doBorrow(suggested)} style={{
                          width:"100%", padding:"10px 0", borderRadius:8, border:"none",
                          background:`linear-gradient(135deg,#006080,${C.cyan})`, color:"#fff",
                          fontSize:12, fontWeight:700, cursor:"pointer",
                        }}>
                          ¥{suggested}万を借入する
                        </button>
                      </>
                    )}
                  </div>
                );
              })()}
            </Panel>

            <Panel style={{marginBottom:14}}>
              <div style={{marginBottom:12,padding:"8px 12px",background:C.bg,borderRadius:8,fontSize:11,color:C.muted,lineHeight:1.6}}>
                💡 未投資の項目は毎Q自動で劣化します。すべてに配分する予算はありません。何を伸ばし、何を犠牲にするか。
              </div>
              <BudgetAllocator availableBudget={availableBudget} allocation={allocation} onChange={setAllocation} bs={bs} playerType={playerType} ops={ops}/>
            </Panel>
            <Panel style={{marginBottom:14,padding:"12px 16px"}}>
              <Label style={{display:"block",marginBottom:8}}>このQの予測変化（投資 or 劣化）</Label>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
                {BUDGET_ITEMS.map(item=>{
                  const invested = allocation[item.id] || 0;
                  const pt = PLAYER_TYPES[playerType];
                  const eff = pt?.investEfficiency || 1.0;
                  const currentVal = ops?.[item.param] || 0;
                  const gain = invested > 0
                    ? calcParamGain(currentVal, item.basePer100, invested, eff)
                    : -item.decay;
                  return (
                    <div key={item.id} style={{textAlign:"center",padding:"8px 4px",background:C.bg,borderRadius:8,
                      border:`1px solid ${invested>0?item.color+"44":C.border}`}}>
                      <div style={{fontSize:16}}>{item.icon}</div>
                      <div style={{fontSize:10,color:C.muted,marginTop:2}}>{item.name}</div>
                      <div style={{fontSize:11,fontWeight:800,color:item.color,marginTop:2}}>{Number(currentVal).toFixed(1)}</div>
                      <div style={{fontSize:12,fontWeight:800,color:gain>0?C.green:C.red,marginTop:1}}>
                        {gain>0?"+":""}{Number(gain).toFixed(1)}
                      </div>
                      {invested > 0 && currentVal > 80 && (
                        <div style={{fontSize:8,color:C.yellow,marginTop:1}}>逓減中</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Panel>
            <div style={{display:"flex",gap:10}}>
              <Panel style={{flex:1,padding:"10px 14px"}}>
                <div style={{fontSize:11,color:C.muted}}>予算消費: <span style={{color:C.yellow,fontWeight:700}}>¥{allocTotal}万</span> / ¥{availableBudget}万</div>
                {allocTotal>availableBudget&&<div style={{fontSize:11,color:C.red,marginTop:2}}>⚠️ 予算超過</div>}
                {devFocusMissing&&<div style={{fontSize:11,color:C.red,marginTop:2}}>⚠️ プロダクト開発の方向性を選んでください</div>}
              </Panel>
              <button
                onClick={onlineMode ? onlineSubmitAllocation : executeQuarter}
                disabled={onlineMode ? (room.myPlayer?.ready || !canExecute) : !canExecute}
                style={{background:canExecute?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,
                  color:canExecute?"#fff":C.muted,border:"none",borderRadius:10,
                  padding:"12px 24px",fontSize:14,fontWeight:700,cursor:canExecute?"pointer":"not-allowed",
                  letterSpacing:1,whiteSpace:"nowrap",boxShadow:canExecute?`0 4px 20px ${C.cyan}44`:"none"}}>
                {onlineMode ? (room.myPlayer?.ready ? "⏳ 全員の準備待ち..." : "準備完了 ✓") : "四半期を進める →"}
              </button>
            </div>
          </>
        )}

        {/* DIPLOMACY TAB：①不戦条約の提案 */}
        {tab==="diplomacy" && (
          <Panel style={{marginBottom:14}}>
            <Label style={{display:"block",marginBottom:8}}>🤝 不戦条約</Label>
            <div style={{fontSize:11,color:C.muted,marginBottom:14,lineHeight:1.6}}>
              提案した相手と合意できれば、今期はお互いに奪取・解約流出が発生しません。
              相手が受けるかどうかは分かりません（劣勢な相手ほど受けやすい傾向があります）。
            </div>
            {onlineMode ? (() => {
              const otherPlayers = (room.players || []).filter(p => p.id !== room.playerId);
              const proposals = room.roomData?.truceProposals || {};
              return (
                <div style={{display:"grid",gap:10}}>
                  {otherPlayers.length === 0 && (
                    <div style={{fontSize:11,color:C.muted,textAlign:"center",padding:"20px 0"}}>対戦相手がいません</div>
                  )}
                  {otherPlayers.map(p => {
                    const key = [room.playerId, p.id].sort().join("_");
                    const proposal = proposals[key];
                    const iSentIt = proposal?.from === room.playerId;
                    const theyAskedMe = proposal?.from === p.id && proposal?.status === "pending";
                    return (
                      <div key={p.id} style={{
                        background:C.bg,borderRadius:10,padding:"10px 14px",
                        border:`1px solid ${proposal?.status==="accepted"?C.green:C.border}`,
                      }}>
                        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:theyAskedMe?8:0}}>
                          <span style={{fontSize:20}}>👤</span>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13,fontWeight:700,color:C.text}}>{p.name}</div>
                            {proposal && (
                              <div style={{fontSize:9,color: proposal.status==="accepted"?C.green : proposal.status==="declined"?C.red : C.yellow}}>
                                {proposal.status==="accepted" ? "✅ 合意成立" :
                                 proposal.status==="declined" ? "❌ 拒否されました" :
                                 iSentIt ? "⏳ 相手の応答待ち" : "🔔 不戦を提案されています"}
                              </div>
                            )}
                          </div>
                          {!proposal && (
                            <button onClick={() => room.proposeTruce(p.id)} style={{
                              padding:"8px 16px",borderRadius:8,border:`1.5px solid ${C.border}`,
                              background:C.panel,color:C.muted,fontSize:11,fontWeight:700,cursor:"pointer",
                            }}>
                              不戦を提案
                            </button>
                          )}
                        </div>
                        {theyAskedMe && (
                          <div style={{display:"flex",gap:8}}>
                            <button onClick={() => room.respondTruce(p.id, true)} style={{
                              flex:1,padding:"7px 0",borderRadius:8,border:"none",
                              background:`${C.green}22`,color:C.green,fontSize:11,fontWeight:700,cursor:"pointer",
                            }}>
                              合意する
                            </button>
                            <button onClick={() => room.respondTruce(p.id, false)} style={{
                              flex:1,padding:"7px 0",borderRadius:8,border:"none",
                              background:`${C.red}22`,color:C.red,fontSize:11,fontWeight:700,cursor:"pointer",
                            }}>
                              拒否する
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })() : (
              <div style={{display:"grid",gap:10}}>
                {npcs.map(n => {
                  const proposed = truceProposals.includes(n.id);
                  return (
                    <div key={n.id} style={{
                      display:"flex",alignItems:"center",gap:12,
                      background:C.bg,borderRadius:10,padding:"10px 14px",
                      border:`1px solid ${proposed?C.cyan:C.border}`,
                    }}>
                      <span style={{fontSize:20}}>{n.icon}</span>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:700,color:n.color}}>{n.name}</div>
                        <div style={{fontSize:9,color:C.muted}}>{n.ops.stores}店</div>
                      </div>
                      <button
                        onClick={() => setTruceProposals(p => proposed ? p.filter(id=>id!==n.id) : [...p, n.id])}
                        style={{
                          padding:"8px 16px",borderRadius:8,border:`1.5px solid ${proposed?C.cyan:C.border}`,
                          background: proposed ? `${C.cyan}18` : C.panel,
                          color: proposed ? C.cyan : C.muted,
                          fontSize:11,fontWeight:700,cursor:"pointer",
                        }}>
                        {proposed ? "提案中 ✓" : "不戦を提案"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {/* SPECIAL ACTION TAB */}
        {tab==="special" && (
          <>
            <Panel style={{marginBottom:14,padding:"12px 16px"}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:12}}>
                特別アクションは予算配分とは別枠で、1Qに1枚だけ実行できます。コストは現預金から即時消費。
              </div>
              <SpecialActionSelector selected={specialAction} onSelect={setSpecialAction}
                usedSpecials={usedSpecials} playerType={playerType} availableCash={bs.cash}
                currentPhaseId={phase.id} bs={bs}/>
            </Panel>
            <div style={{display:"flex",gap:10}}>
              <Panel style={{flex:1,padding:"10px 14px"}}>
                <div style={{fontSize:11,color:C.muted}}>
                  {specialAction
                    ? `選択: ${SPECIAL_ACTIONS[specialAction]?.name} (¥${SPECIAL_ACTIONS[specialAction]?.cost||0}万)`
                    : "特別アクションなし（スキップ可）"}
                </div>
              </Panel>
              <button
                onClick={onlineMode ? onlineSubmitAllocation : executeQuarter}
                disabled={onlineMode ? (room.myPlayer?.ready || !canExecute) : !canExecute}
                style={{background:canExecute?`linear-gradient(135deg,#006080,${C.cyan})`:C.border,
                  color:canExecute?"#fff":C.muted,border:"none",borderRadius:10,
                  padding:"12px 24px",fontSize:14,fontWeight:700,
                  cursor:canExecute?"pointer":"not-allowed",
                  letterSpacing:1,whiteSpace:"nowrap"}}>
                {onlineMode ? (room.myPlayer?.ready ? "⏳ 全員の準備待ち..." : "準備完了 ✓") : "四半期を進める →"}
              </button>
            </div>
          </>
        )}

        {/* BS TAB */}
        {tab==="bs" && (
          <>
            <Label style={{display:"block",marginBottom:12}}>貸借対照表（現在）</Label>
            <BSTable bs={bs}/>

            {/* Stage3: 返済スケジュール */}
            {bs.loanSchedule && bs.loanSchedule.length > 0 && (
              <Panel style={{marginTop:14}}>
                <Label style={{display:"block",marginBottom:10}}>🏦 返済スケジュール</Label>
                <div style={{display:"grid", gap:8}}>
                  {bs.loanSchedule.map((loan, i) => (
                    <div key={i} style={{
                      display:"flex", justifyContent:"space-between", alignItems:"center",
                      background:C.bg, borderRadius:8, padding:"8px 12px", border:`1px solid ${C.border}`,
                    }}>
                      <span style={{fontSize:11, color:C.muted}}>
                        借入¥{loan.principal}万（残り{loan.remainingQuarters}Q）
                      </span>
                      <span style={{fontSize:12, fontWeight:700, color:C.orange, fontFamily:"'Courier New',monospace"}}>
                        ¥{loan.quarterlyPrincipal}万/Q
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:8, fontSize:10, color:C.muted}}>
                  D/Eレシオ: {(() => { const de = deRatio(bs); return de===Infinity ? "∞" : (de*100).toFixed(0)+"%"; })()}（上限200%）
                </div>
              </Panel>
            )}

            {history.length>0&&(
              <Panel style={{marginTop:14}}>
                <Label style={{display:"block",marginBottom:10}}>純資産推移</Label>
                <div style={{display:"flex",alignItems:"flex-end",gap:4,height:70}}>
                  {history.map((h,i)=>{
                    const max=Math.max(...history.map(x=>x.netWorth),equity(bs),1);
                    return (
                      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <div style={{width:"100%",background:h.netIncome>=0?C.cyan:C.red,borderRadius:"3px 3px 0 0",
                          height:`${Math.max(3,h.netWorth/max*60)}px`,transition:"height 0.3s",
                          boxShadow:`0 0 6px ${h.netIncome>=0?C.cyan:C.red}66`}}/>
                        <span style={{fontSize:8,color:C.muted}}>Q{h.quarter}</span>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}
          </>
        )}

        {/* OPS TAB */}
        {tab==="ops" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <Panel>
              <Label style={{display:"block",marginBottom:12}}>競争力パラメータ（自分のみ）</Label>
              {Object.values(allocation||{}).some(v=>v>0) && (
                <div style={{marginBottom:10,padding:"6px 10px",background:`${C.purple}10`,border:`1px solid ${C.purple}33`,borderRadius:6,fontSize:10,color:C.purple}}>
                  ⏳ 今Q投資中の分は来Qから反映されます
                </div>
              )}
              {[["⚙️ ソリューション品質","solutionQuality",C.purple],
                ["👥 営業力","salesPower",C.cyan],
                ["📢 ブランド認知","brandAwareness",C.yellow],
                ["🎧 サポート品質","supportQuality",C.orange]
              ].map(([l,k,c])=>(
                <div key={k} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:11,color:C.muted}}>{l}</span>
                    <span style={{fontSize:11,color:c,fontWeight:800}}>{Number(ops[k]).toFixed(1)}</span>
                  </div>
                  <div style={{position:"relative",height:6}}>
                    <Bar value={ops[k]} color={c} max={PARAM_MAX}/>
                  </div>
                </div>
              ))}
              <div style={{marginTop:8,fontSize:10,color:C.muted}}>※ 競合の内部パラメータは非公開。店舗数・資産規模からのみ動向を推測できる。</div>
            </Panel>
            <div>
              <Panel style={{marginBottom:12}}>
                <Label style={{display:"block",marginBottom:10}}>競争力スコア（自分のみ）</Label>
                <div style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{fontSize:11,color:C.cyan,fontWeight:700}}>あなた</span>
                    <span style={{fontSize:12,fontWeight:800,color:C.cyan,fontFamily:"'Courier New',monospace"}}>{competitiveScore(ops, market?.arpu).toFixed(1)}</span>
                  </div>
                  <Bar value={competitiveScore(ops, market?.arpu)} color={C.cyan} max={150}/>
                </div>
                <div style={{fontSize:9,color:C.muted,marginTop:8}}>
                  ※ 競合のスコアは非公開。店舗数・資産の変化からのみ推測できる。
                </div>
              </Panel>
              <Panel>
                <Label style={{display:"block",marginBottom:10}}>経営指標</Label>
                {[["推計売上/Q",`¥${calcRevenue(ops,market).toLocaleString()}万`],
                  ["解約率",`${(calcChurn(ops,market?.arpu)*100).toFixed(1)}%`],
                  ["利息負担/Q",`¥${Math.floor(bs.debt*INTEREST_RATE)}万`],
                  ["SW償却/Q",`¥${Math.floor(bs.softwareAsset*SW_DEP_RATE)}万`],
                  ["市場残余",`${Math.max(0,Math.floor(market.totalStores*marketPenetration(quarter))-[ops,...npcs.map(n=>n.ops)].reduce((s,o)=>s+o.stores,0))}店`],
                ].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${C.border}`,fontSize:11}}>
                    <span style={{color:C.muted}}>{l}</span>
                    <span style={{color:C.text,fontWeight:700}}>{v}</span>
                  </div>
                ))}
              </Panel>
            </div>
          </div>
        )}

        {/* RANK TAB */}
        {tab==="rank" && (
          <div>
            <Panel style={{marginBottom:14}}>
              <Label style={{display:"block",marginBottom:12}}>マーケットシェア（現在）</Label>
              <MarketShareChart
                players={allPlayers.map(p=>({name:p.isPlayer?"あなた":p.name, stores:p.stores, color:p.color, isPlayer:p.isPlayer}))}
                market={market}
                quarter={quarter}
              />
            </Panel>

            {/* 年次振り返り */}
            {[1,2,3].map(yr=>{
              const qEnd = yr * 4;
              const qStart = qEnd - 3;
              const yearHistory = history.filter(h=>h.quarter>=qStart&&h.quarter<=qEnd);
              if(yearHistory.length===0) return null;
              const lastQ = yearHistory[yearHistory.length-1];
              const firstQ = yearHistory[0];
              const taGrowth = lastQ.netWorth - (history.find(h=>h.quarter===qStart-1)?.netWorth || (yr===1?equity(PLAYER_TYPES[playerType]?.bs||{capital:0,retainedEarnings:0}):0));
              const phaseLabel = yr===1?"🌅 黎明期":yr===2?"🚀 急成長":"🏁 成熟期";
              const yearDone = quarter > qEnd;
              return (
                <Panel key={yr} style={{marginBottom:12,opacity:yearDone?1:0.6,border:`1px solid ${yearDone?C.border:C.border+"88"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div>
                      <span style={{fontSize:13,fontWeight:800,color:C.text}}>Year {yr}</span>
                      <span style={{fontSize:11,color:C.muted,marginLeft:8}}>{phaseLabel}</span>
                    </div>
                    {!yearDone && <span style={{fontSize:10,color:C.yellow}}>進行中</span>}
                  </div>
                  {/* 各Q概要 */}
                  <div style={{display:"flex",gap:4,marginBottom:12}}>
                    {yearHistory.map(h=>(
                      <div key={h.quarter} style={{flex:1,background:C.bg,borderRadius:6,padding:"6px 4px",textAlign:"center",
                        border:`1px solid ${h.netIncome>=0?C.green+"44":C.red+"44"}`}}>
                        <div style={{fontSize:9,color:C.muted}}>Q{((h.quarter-1)%4)+1}</div>
                        <div style={{fontSize:10,fontWeight:700,color:h.netIncome>=0?C.green:C.red}}>
                          {h.netIncome>=0?"+":""}{Math.round(h.netIncome/100)/10}k万
                        </div>
                        <div style={{fontSize:9,color:C.muted}}>{h.stores}店</div>
                      </div>
                    ))}
                  </div>
                  {/* 年間サマリー */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.cyan,fontFamily:"'Courier New',monospace"}}>
                        {lastQ.stores}店
                      </div>
                      <div style={{fontSize:9,color:C.muted}}>期末店舗数</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:13,fontWeight:800,color:taGrowth>=0?C.green:C.red,fontFamily:"'Courier New',monospace"}}>
                        {taGrowth>=0?"+":""}{taGrowth.toLocaleString()}万
                      </div>
                      <div style={{fontSize:9,color:C.muted}}>純資産増減</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:13,fontWeight:800,color:C.text,fontFamily:"'Courier New',monospace"}}>
                        {lastQ.phase}
                      </div>
                      <div style={{fontSize:9,color:C.muted}}>期末フェーズ</div>
                    </div>
                  </div>
                  {/* NPC vs プレイヤー比較（期末） */}
                  {lastQ.npcSnapshot && (
                    <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
                      <div style={{fontSize:10,color:C.muted,marginBottom:6}}>期末シェア比較</div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <span style={{fontSize:12}}>⭐</span>
                          <span style={{fontSize:11,fontWeight:700,color:C.cyan}}>{lastQ.stores}店</span>
                        </div>
                        {lastQ.npcSnapshot.map(n=>(
                          <div key={n.id} style={{display:"flex",alignItems:"center",gap:4}}>
                            <span style={{fontSize:9,color:C.muted}}>vs</span>
                            <span style={{fontSize:11,fontWeight:700,color:n.color}}>{n.name.slice(0,4)} {n.stores}店</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Panel>
              );
            })}
            <Panel>
              <Label style={{display:"block",marginBottom:14}}>スコアボード — 勝利条件: 純資産最大</Label>
              {allPlayers.map((p,i)=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 8px",
                  borderBottom:i<allPlayers.length-1?`1px solid ${C.border}`:"none",
                  background:p.isPlayer?"#00C8D411":"transparent",borderRadius:8}}>
                  <span style={{fontSize:20,width:24,textAlign:"center"}}>{i===0?"🥇":i===1?"🥈":"🥉"}</span>
                  <span style={{fontSize:20}}>{p.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:p.color}}>{p.name}</div>
                    <div style={{fontSize:10,color:C.muted}}>{p.stores}店 | 総資産¥{p.totalAssets.toLocaleString()}万 | score:{competitiveScore(p.ops, market?.arpu).toFixed(0)}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:16,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{p.netWorth.toLocaleString()}万</div>
                    <div style={{fontSize:9,color:C.muted}}>純資産</div>
                  </div>
                </div>
              ))}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
