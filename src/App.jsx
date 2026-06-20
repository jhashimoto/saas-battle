import { useState, useEffect, useRef } from "react";
import { useRoom, GAME_VERSION, TUTORIAL_KEY, clearRoomStorage } from "./useRoom.js";

// ============================================================
// DESIGN PHILOSOPHY
// 毎Q「予算をどう配分するか」を決める → 何かを増やすと何かが足りなくなる
// パラメータは毎Q自然劣化 → 維持するだけでもコストがかかる
// 市場フェーズ（黎明期→急成長→成熟）でルールが変わる
// ============================================================

const MARKETS = {
  food:   { id:"food",   name:"飲食 モバイルオーダー", icon:"🍜", color:"#FF6B35",
            arpu:80,  totalStores:800, varCostPerStore:0.5, entryDiff:1,
            priceSensitivity:0.60,
            desc:"参入しやすく競合が激しい。シェアを早く取れるかが勝負。" },
  retail: { id:"retail", name:"小売店 会員証",        icon:"🏪", color:"#06B6D4",
            arpu:140, totalStores:400, varCostPerStore:0.8, entryDiff:3,
            priceSensitivity:0.50,
            desc:"導入ハードルが高い。大手獲得で一気に優位に立てる。" },
  beauty: { id:"beauty", name:"美容室 予約サービス",  icon:"✂️", color:"#A855F7",
            arpu:200, totalStores:300, varCostPerStore:1.2, entryDiff:2,
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
    bs:  { cash:2000, softwareAsset:0, otherAsset:500, debt:0, capital:2500, retainedEarnings:0 },
    ops: { solutionQuality:40, salesPower:60, brandAwareness:55, supportQuality:50, stores:0, setPrice:0, priceMultiplier:1.0 },
    investRatio: 0.10, baseOpex: 200, investEfficiency: 1.0,
  },
  startup: {
    id:"startup", name:"スタートアップ", icon:"🚀",
    desc:"少ない予算でも投資効率1.8倍。集中投資で特定パラメータを一気に伸ばせる。",
    bs:  { cash:400, softwareAsset:0, otherAsset:50, debt:0, capital:450, retainedEarnings:0 },
    ops: { solutionQuality:55, salesPower:20, brandAwareness:20, supportQuality:35, stores:0, setPrice:0, priceMultiplier:1.0 },
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
    param:"brandAwareness",  basePer100:1.0, decay:1.0, capitalize:false,
    desc:"brandAwareness上昇（逓減あり）。未投資で毎Q-1.0。" },
  { id:"cs",       name:"CS・サポート",   icon:"🎧", color:"#FFA657",
    param:"supportQuality",  basePer100:0.9, decay:0.8, capitalize:false,
    desc:"supportQuality上昇（逓減あり）。未投資で毎Q-0.8。" },
];

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
    desc:"即時+25店。一気にシェアを取りに行く大型営業。", storeBonus:25, cat:"sales" },
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
  bank_loan:    { id:"bank_loan",    icon:"🏦", name:"銀行借入",        cost:0,
    desc:"現預金+1000、負債+1000。利息5%/Q。負債/資本200%上限。", cashGain:1000, debtGain:1000, cat:"funding" },
  bank_loan_lg: { id:"bank_loan_lg", icon:"🏛️", name:"大型銀行借入",   cost:0,
    desc:"現預金+3000、負債+3000。急成長期以降のみ。利息5%/Q。", cashGain:3000, debtGain:3000, cat:"funding", phase:"growth" },
  debt_repay:   { id:"debt_repay",   icon:"💸", name:"借入一括返済",    cost:0,
    desc:"負債を全額返済。利息負担から解放。", fullRepay:true, cat:"funding" },
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

// ============================================================
// GAME ENGINE
// ============================================================

function competitiveScore(ops, baseArpu) {
  const bc = Math.log2(1 + ops.brandAwareness) / Math.log2(101);
  // 価格スコア：指数0.5（急峻カーブ）
  // 値上げは急激にスコアが落ち、値下げは急激に上がる
  const priceScore = (baseArpu && ops.setPrice)
    ? (() => {
        const ratio = (ops.setPrice - baseArpu) / baseArpu;
        const curved = Math.sign(ratio) * Math.pow(Math.abs(ratio), 0.5);
        return Math.max(0, Math.min(100, 50 - curved * 80));
      })()
    : 50;
  return ops.salesPower * 0.30 + ops.solutionQuality * 0.25
       + bc * 25 + priceScore * 0.20 + ops.supportQuality * 0.10;
}

function calcChurn(ops) {
  const base = 0.12;
  return Math.max(0.005, Math.min(0.35,
    base
    - (ops.supportQuality - 50) * 0.0015
    - (ops.solutionQuality - 50) * 0.0006
  ));
}

function calcRevenue(ops, market) {
  // ARPUはpriceMultiplier（価格設定）で変動。solutionQualityはスコア経由のみ
  const priceMultiplier = ops.priceMultiplier || 1.0;
  return Math.floor(ops.stores * market.arpu * priceMultiplier);
}

// 価格設定からpriceMultiplierを計算
function calcPriceMultiplier(setPrice, baseArpu) {
  if (!setPrice || setPrice <= 0) return 1.0;
  return setPrice / baseArpu;
}

function calcVarCost(ops, market) {
  return Math.floor(ops.stores * market.varCostPerStore);
}

// 予算配分をopsに反映（逓減カーブ付き投資効果 or 自然劣化）
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
function applySpecialAction(bs, ops, actionId, usedActions) {
  const action = SPECIAL_ACTIONS[actionId];
  if (!action) return { bs, ops, sgaAdd: 0, capitalizeAmt: 0 };
  let newBs = { ...bs }, newOps = { ...ops };
  let sgaAdd = 0, capitalizeAmt = 0;

  if (action.cost > 0) {
    if (action.capitalize) { newBs.cash -= action.cost; capitalizeAmt = action.cost; newBs.softwareAsset += action.cost; }
    else                   { newBs.cash -= action.cost; sgaAdd = action.cost; }
  }
  if (action.cashGain)    newBs.cash    += action.cashGain;
  if (action.capitalGain) newBs.capital += action.capitalGain;
  if (action.debtGain)    newBs.debt    += action.debtGain;
  if (action.fullRepay)   { newBs.cash -= newBs.debt; newBs.debt = 0; }
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
function resolveMarket(allPlayers, market, quarter, extraUnclaimed = 0) {
  const phase = getPhase(quarter);
  const penetration = marketPenetration(quarter);
  const totalAvail = Math.floor(market.totalStores * penetration) + extraUnclaimed;
  const currentTotal = allPlayers.reduce((s, p) => s + p.ops.stores, 0);
  const unclaimed = Math.max(0, totalAvail - currentTotal);

  const baseArpu = market?.arpu || 80;
  const scores = allPlayers.map(p => competitiveScore(p.ops, baseArpu));
  const totalScore = scores.reduce((s, x) => s + x, 0);

  return allPlayers.map((player, i) => {
    const myScore = scores[i];
    const myShare = totalScore > 0 ? myScore / totalScore : 1 / allPlayers.length;

    const rawNewFromUnclaimed = Math.floor(unclaimed * myShare * 0.15 * phase.growthBonus);
    const newFromUnclaimed = unclaimed > 0 ? Math.max(1, rawNewFromUnclaimed) : 0;

    // 競合からの奪取（スコア差 + 価格差ボーナス + 営業力ボーナス）
    let stolenFromRivals = 0;
    allPlayers.forEach((rival, j) => {
      if (i === j || rival.ops.stores === 0) return;
      const diff = myScore - scores[j];
      if (diff > 0) {
        let rate = Math.min(0.20, (diff / Math.max(scores[j], 1)) * 0.25 * phase.stealMultiplier);
        // ★ 営業力ボーナス：salesPowerが高いほど奪取率に上乗せ（スコア差に関係なく効く）
        const salesBonus = (player.ops.salesPower / 150) * 0.08;
        rate = Math.min(0.35, rate + salesBonus);
        // ★ 価格差ボーナス
        const myPrice = player.ops.setPrice || market.arpu;
        const rivalPrice = rival.ops.setPrice || market.arpu;
        if (myPrice < rivalPrice) {
          const priceDiffRatio = (rivalPrice - myPrice) / rivalPrice;
          rate = Math.min(0.40, rate + priceDiffRatio * (market.priceSensitivity || 0.6) * 0.4);
        }
        stolenFromRivals += Math.floor(rival.ops.stores * rate);
      }
    });

    // 競合に奪われる（スコア差 + 価格差ペナルティ）
    let lostToRivals = 0;
    allPlayers.forEach((rival, j) => {
      if (i === j || player.ops.stores === 0) return;
      const diff = scores[j] - myScore;
      if (diff > 0) {
        let rate = Math.min(0.20, (diff / Math.max(myScore, 1)) * 0.25 * phase.stealMultiplier);
        // ★ 自分が高く相手が安い場合：価格差に応じて追加流出
        const myPrice = player.ops.setPrice || market.arpu;
        const rivalPrice = rival.ops.setPrice || market.arpu;
        if (myPrice > rivalPrice) {
          const priceDiffRatio = (myPrice - rivalPrice) / myPrice;
          rate = Math.min(0.30, rate + priceDiffRatio * (market.priceSensitivity || 0.6) * 0.4);
        }
        lostToRivals += Math.floor(player.ops.stores * rate);
      }
    });

    // 自然解約
    const churnRate = calcChurn(player.ops);
    const naturalChurn = Math.floor(player.ops.stores * churnRate);

    const gained = newFromUnclaimed + stolenFromRivals;
    const lost   = naturalChurn + lostToRivals;
    const final  = Math.max(0, player.ops.stores + gained - lost);

    return { id: player.id, newFromUnclaimed, stolenFromRivals, naturalChurn, lostToRivals,
             gained, lost, finalStores: final, churnRate };
  });
}

// 1Qの全処理
function processQuarter(playerBs, playerOps, playerAlloc, playerSpecial,
                        npcs, market, quarter, usedSpecials, playerType) {
  const phase = getPhase(quarter);
  const pt = PLAYER_TYPES[playerType];
  const investEfficiency = pt?.investEfficiency || 1.0;
  const baseOpex = pt?.baseOpex || 100;

  // --- Player: 予算配分適用（investEfficiency込み）---
  let pOps = applyBudgetAllocation(playerOps, playerAlloc, investEfficiency);

  // --- Player: 特別アクション ---
  let pBs = { ...playerBs };
  let sgaAdd = 0, capitalizeAmt = 0;
  if (playerSpecial && (!SPECIAL_ACTIONS[playerSpecial]?.oneTime || !usedSpecials.includes(playerSpecial))) {
    const r = applySpecialAction(pBs, pOps, playerSpecial, usedSpecials);
    pBs = r.bs; pOps = r.ops; sgaAdd = r.sgaAdd; capitalizeAmt = r.capitalizeAmt;
  }

  // --- NPC: 予算配分（BS連動）---
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
    const nOps = applyBudgetAllocation(n.ops, alloc, nEff);
    const nSpecial = Math.random() < 0.40 ? (n.strategy==="sales_heavy"?"chain_deal":"line_collab") : null;
    let nBs = {...n.bs};
    if (nSpecial) { const r = applySpecialAction(nBs, nOps, nSpecial, []); nBs = r.bs; }
    return { ...n, ops: nOps, bs: nBs, usedSpecial: nSpecial };
  });

  // --- 競争解決 ---
  const allForCompet = [
    { id:"player", ops: pOps },
    ...npcProcessed.map(n => ({ id: n.id, ops: n.ops })),
  ];
  const competResults = resolveMarket(allForCompet, market, quarter);
  const pResult = competResults.find(r => r.id === "player");

  // --- Player PL確定 ---
  const finalPOps = { ...pOps, stores: pResult.finalStores };

  // SW償却（既存資産分のみ）
  const dep = Math.floor(pBs.softwareAsset * SW_DEP_RATE);
  pBs.softwareAsset -= dep;

  // 利息
  const interest = Math.floor(pBs.debt * INTEREST_RATE);

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

  const revenue  = calcRevenue(finalPOps, market);
  const cogs     = Math.floor(revenue * 0.25);
  const varCost  = calcVarCost(finalPOps, market);
  const totalSga = allocSga + sgaAdd + baseOpex + varCost;
  const grossProfit     = revenue - cogs;
  const operatingProfit = grossProfit - totalSga - dep;
  const netIncome       = operatingProfit - interest;

  // ★ BS整合：
  // cash変動   = rev - cogs - varCost - opex - allocSga - sgaAdd - allocCapitalize - interest
  // retainedΔ = rev - cogs - varCost - opex - allocSga - sgaAdd - dep - interest  (= netIncome)
  // swAssetΔ  = allocCapitalize - dep
  // totalAssetsΔ = cashΔ + swΔ = netIncome ✓ → 純資産Δ(=retainedΔ)と一致
  pBs.cash += revenue - cogs - varCost - baseOpex - allocSga - sgaAdd - allocCapitalize - interest;
  pBs.retainedEarnings += netIncome; // netIncome = rev-cogs-varCost-opex-allocSga-sgaAdd-dep-interest

  const pl = {
    revenue, cogs, grossProfit, varCost,
    allocSga, allocCapitalize, sgaAdd, opex: baseOpex, totalSga,
    depAmt: dep, interestExpense: interest,
    operatingProfit, netIncome,
    competResult: pResult,
    phase: phase.name,
    playerAlloc, playerSpecial,
    investEfficiency,
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

    const nInt = Math.floor(nBs.debt * INTEREST_RATE);
    const nRev = calcRevenue(nFinalOps, market);
    const nCogs = Math.floor(nRev * 0.25);
    const nVarC = calcVarCost(nFinalOps, market);

    // ★ プレイヤーと同じBS整合ロジック
    const nNetIncome = nRev - nCogs - nVarC - nBaseOpex - nAllocSga - nDep - nInt;
    nBs.cash += nRev - nCogs - nVarC - nBaseOpex - nAllocSga - nAllocCap - nInt;
    nBs.retainedEarnings += nNetIncome;

    return { ...n, ops: nFinalOps, bs: nBs, lastSpecial: n.usedSpecial };
  });

  const newUsedSpecials = playerSpecial && SPECIAL_ACTIONS[playerSpecial]?.oneTime
    ? [...usedSpecials, playerSpecial] : usedSpecials;

  return { pBs, finalPOps, pl, newNpcs, newUsedSpecials };
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
      text: `競合に ${cr.lostToRivals}店を奪われた。【${severity}】スコア差を縮めないと流出が続く。`,
    });
  }

  // NPC戦略変化の通知
  npcs.forEach(n => {
    if (!prevNpcOps) return;
    const prev = prevNpcOps[n.id];
    if (!prev) return;
    const devGain = n.ops.solutionQuality - prev.solutionQuality;
    const salesGain = n.ops.salesPower - prev.salesPower;
    if (devGain >= 3) {
      messages.push({
        type: "npc_dev",
        icon: "🔬",
        color: n.color,
        text: `${n.name}がプロダクト開発に注力。品質スコアが+${devGain.toFixed(1)}上昇中。`,
      });
    }
    if (salesGain >= 3) {
      messages.push({
        type: "npc_sales",
        icon: "📣",
        color: n.color,
        text: `${n.name}が営業を強化。来Qから市場獲得ペースが上がる見込み。`,
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
          <path key={i} d={seg.path} fill={seg.color}
            stroke={seg.isPlayer ? "#fff" : "transparent"} strokeWidth={seg.isPlayer ? 2 : 0}
            opacity={seg.label === "未獲得" ? 0.3 : 0.9} />
        ))}
        <circle cx={cx} cy={cy} r={28} fill="#161B22" />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="#F0F6FC" fontSize={11} fontWeight={700}>{totalStores}店</text>
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
// BUDGET ALLOCATOR COMPONENT
// =// ============================================================
// BUDGET ALLOCATOR — スライダーUI + 前回値保持
// ============================================================
function BudgetAllocator({ availableBudget, allocation, onChange, bs, playerType, ops }) {
  const total = Object.values(allocation).reduce((s,v)=>s+(v||0),0);
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
    onChange({ ...allocation, [id]: clamped });
  };

  return (
    <div>
      <div style={{marginBottom:12,padding:"10px 14px",background:C.bg,borderRadius:8,border:`1px solid ${C.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <Label>今Q投資可能上限</Label>
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
                        {paramLabels[item.param]||item.param} {gain>0?"+":""}{Number(gain).toFixed(1)}
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
function PLTable({pl}) {
  const rows=[
    ["売上高",          pl.revenue,                    false,C.green],
    ["売上原価",        -pl.cogs,                      false,C.red],
    ["売上総利益",       pl.grossProfit,                true],
    ["予算投資費用",    -pl.allocSga,                  false,C.muted],
    ["特別アクション費",-pl.sgaAdd,                    false,pl.sgaAdd>0?C.orange:C.muted],
    ["店舗変動費",      -pl.varCost,                   false,C.orange],
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
function OnlineLobby({ onSolo, onTutorial, room }) {
  const { roomCode, roomData, playerId, isHost, error, loading, allReady,
          createRoom, joinRoom, startGame, players } = room;

  const [mode, setMode]         = useState(null); // "create" | "join"
  const [playerName, setName]   = useState("");
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
      subtitle: "3年後の総資産で決まる",
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
            <div style={{fontSize:22,fontWeight:900,color:C.cyan}}>総資産（現金＋資産）最大</div>
            <div style={{fontSize:11,color:C.muted,marginTop:8}}>店舗を増やして売上を積み上げ、賢く投資して資産を作れ</div>
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
            <input type="number" value={inputPrice} min={1}
              inputMode="numeric" pattern="[0-9]*"
              onChange={e => setInputPrice(Math.max(1, Number(e.target.value)))}
              style={{flex:1,background:C.bg,border:`2px solid ${C.cyan}`,borderRadius:8,
                padding:"12px 16px",color:C.text,fontSize:24,fontWeight:900,
                fontFamily:"'Courier New',monospace",outline:"none",textAlign:"right"}}
            />
            <span style={{fontSize:14,color:C.muted,flexShrink:0}}>万円/月</span>
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
  const [prevAllocation,setPrevAllocation] = useState({sales:0,dev:0,marketing:0,price:0,cs:0});
  const [specialAction,setSpecialAction] = useState(null);
  const [usedSpecials,setUsedSpecials]   = useState([]);
  const [lastPL,setLastPL]       = useState(null);
  const [lastEvent,setLastEvent] = useState(null);
  const [lastNetIncome,setLastNetIncome] = useState(0);
  const [prevNpcOps,setPrevNpcOps] = useState({});
  const [narratives,setNarratives] = useState([]);
  const [pendingChoice,setPendingChoice]   = useState(null);
  const [activeEffects,setActiveEffects]   = useState([]);
  const [permanentOpexExtra,setPermanentOpexExtra] = useState(0);
  const [pendingPrice,setPendingPrice]     = useState(null); // 年次価格設定待ち
  const [tab,setTab]             = useState("budget");
  const [history,setHistory]     = useState([]);


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

    // 競争計算
    const allPlayerOps = playerEntries.map(([pid, p]) => ({
      id: pid,
      ops: gameStates[pid]?.ops || {},
    }));
    const competResults = resolveMarket(allPlayerOps, market, room.roomData.quarter || 1);

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

      // パラメータ更新
      let pOps = applyBudgetAllocation(pState.ops, alloc, eff);
      let pBs = {...pState.bs};
      let sgaAdd = 0, capitalizeAmt = 0;

      // 特別アクション
      if (special && SPECIAL_ACTIONS[special] && !pState.usedSpecials?.includes(special)) {
        const r = applySpecialAction(pBs, pOps, special, pState.usedSpecials || []);
        pBs = r.bs; pOps = r.ops; sgaAdd = r.sgaAdd || 0; capitalizeAmt = r.capitalizeAmt || 0;
      }

      // 競争結果適用
      const cr = competResults.find(r => r.id === pid);
      if (!cr) return;
      const finalOps = {...pOps, stores: cr.finalStores};

      // PL計算
      const dep = Math.floor(pBs.softwareAsset * SW_DEP_RATE);
      pBs.softwareAsset -= dep;
      const interest = Math.floor(pBs.debt * INTEREST_RATE);

      let allocSga = 0, allocCap = 0;
      BUDGET_ITEMS.forEach(item => {
        const amt = alloc[item.id] || 0;
        if (amt > 0) { if (item.capitalize) allocCap += amt; else allocSga += amt; }
      });
      pBs.softwareAsset += allocCap;

      const revenue = calcRevenue(finalOps, market);
      const cogs = Math.floor(revenue * 0.25);
      const varCost = calcVarCost(finalOps, market);
      const totalSga = allocSga + sgaAdd + baseOpex + varCost;
      const operatingProfit = revenue - cogs - totalSga - dep;
      const netIncome = operatingProfit - interest;

      pBs.cash += revenue - cogs - varCost - baseOpex - allocSga - sgaAdd - allocCap - interest;
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

      const pl = {
        revenue, cogs, grossProfit: revenue-cogs, varCost,
        allocSga, allocCap, sgaAdd, opex: baseOpex, totalSga,
        depAmt: dep, interestExpense: interest,
        operatingProfit, netIncome,
        competResult: {
          newFromUnclaimed: cr.newFromUnclaimed || 0,
          stolenFromRivals: cr.stolenFromRivals || 0,
          naturalChurn: cr.naturalChurn || 0,
          lostToRivals: cr.lostToRivals || 0,
          finalStores: cr.finalStores,
        },
        playerAlloc: alloc, playerSpecial: special,
      };
      quarterLogs[pid] = { pl, event: null, narratives: [] };
    });

    const nextQ = currentQ + 1;
    const nextStatus = currentQ % 4 === 0 ? "yearreview"
                     : nextQ > MAX_QUARTERS ? "gameover"
                     : "result";

    room.writeQuarterResult(nextQ, newGameState, quarterLogs, nextStatus);
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
  const availableBudget = bs ? calcInvestCapacity(bs, playerType, lastNetIncome) + investBonusFromEffects : 0;
  const allocTotal = Object.values(allocation).reduce((s,v)=>s+v,0);
  const canExecute = allocTotal <= availableBudget;

  function executeQuarter() {
    if (!canExecute) return;
    const market = MARKETS[marketId];

    // ランダムイベント抽選（選択型は別処理）
    let ev = null;
    const roll = Math.random();
    let cumProb = 0;
    for (const e of RANDOM_EVENTS) {
      cumProb += e.prob;
      if (roll < cumProb) { ev = e; break; }
    }

    const { pBs, finalPOps, pl, newNpcs, newUsedSpecials } =
      processQuarter(bs, ops, allocation, specialAction,
                     npcs, market, quarter, usedSpecials, playerType);

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
      setHistory(h=>[...h,{quarter,totalAssets:totalAssets(finalBs),stores:Math.floor(finalOps.stores)||0,netIncome:pl.netIncome,phase:getPhase(quarter).name,npcSnapshot:finalNpcs.map(n=>({id:n.id,name:n.name,color:n.color,stores:Math.floor(n.ops.stores)||0,totalAssets:totalAssets(n.bs)}))}]);
      setPrevNpcOps(Object.fromEntries(finalNpcs.map(n=>[n.id,{...n.ops}])));
      setBs(finalBs); setOps(finalOps); setNpcs(finalNpcs);
      setUsedSpecials(newUsedSpecials); setLastPL({...pl,competResult:enrichedResult2}); setLastEvent(ev);
      setLastNetIncome(pl.netIncome); setNarratives(newNarratives2);
      setActiveEffects(newActiveEffects);
      setPrevAllocation(allocation); setAllocation({...allocation}); setSpecialAction(null);
      setPendingChoice(ev); // 選択画面へ
      setScreen("choice");
      return;
    }

    // 通常処理
    const myScore = competitiveScore(finalOps, market?.arpu);
    const enrichedResult = {...pl.competResult, quarter, myScore, rivalScores:finalNpcs.map(n=>competitiveScore(n.ops, market?.arpu))};
    const newNarratives = generateCompetitiveNarrative(enrichedResult, finalNpcs, prevNpcOps, getPhase(quarter));

    setHistory(h=>[...h,{quarter,totalAssets:totalAssets(finalBs),stores:Math.floor(finalOps.stores)||0,netIncome:pl.netIncome,phase:getPhase(quarter).name,npcSnapshot:finalNpcs.map(n=>({id:n.id,name:n.name,color:n.color,stores:Math.floor(n.ops.stores)||0,totalAssets:totalAssets(n.bs)}))}]);
    setPrevNpcOps(Object.fromEntries(finalNpcs.map(n=>[n.id,{...n.ops}])));
    setBs(finalBs); setOps(finalOps); setNpcs(finalNpcs);
    setUsedSpecials(newUsedSpecials); setLastPL({...pl,competResult:enrichedResult}); setLastEvent(ev);
    setLastNetIncome(pl.netIncome); setNarratives(newNarratives);
    setActiveEffects(newActiveEffects);
    setPrevAllocation(allocation); setAllocation({...allocation}); setSpecialAction(null);
    setScreen("result");
  }

  // 選択型イベントの確定
  function resolveChoice(choiceIdx) {
    if (!pendingChoice) return;
    const choice = pendingChoice.choices[choiceIdx];
    let newBs = {...bs}, newOps = {...ops};

    if (choice.effect === "none") { setBs(newBs); setOps(newOps); setPendingChoice(null); setScreen("result"); return; }
    if (choice.bsCost)      newBs = {...newBs, cash: newBs.cash - choice.bsCost};
    if (choice.cashGain)    newBs = {...newBs, cash: newBs.cash + choice.cashGain};
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
    setScreen("result");
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
    {id:"player",name:"あなた",icon:"⭐",color:C.cyan,isPlayer:true,totalAssets:totalAssets(bs),stores:Math.floor(ops.stores)||0,bs,ops},
    ...npcs.map(n=>({...n,totalAssets:totalAssets(n.bs),stores:Math.floor(n.ops.stores)||0}))
  ].sort((a,b)=>b.totalAssets-a.totalAssets) : [];

  if (screen==="tutorial") return (
    <TutorialScreen onComplete={()=>{
      try { localStorage.setItem(TUTORIAL_KEY,"1"); } catch {}
      setTutorialDone(true);
      setScreen("lobby");
    }}/>
  );
  if (screen==="lobby") return (
    <OnlineLobby
      room={room}
      onTutorial={()=>setScreen("tutorial")}
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
    const yearEndTA     = totalAssets(bs);
    const yearEndStores = Math.floor(ops.stores) || 0;

    const prevYearEndTA = completedYear > 1
      ? (history.find(h => h.quarter === qStart - 1)?.totalAssets || 0)
      : totalAssets(PLAYER_TYPES[playerType]?.bs || {cash:0, softwareAsset:0, otherAsset:0});
    const taGrowth = yearEndTA - prevYearEndTA;

    const phaseNext = getPhase(qEnd + 1);

    // グラフ用：historyがあれば使い、なければ現在値だけ
    const chartData = yearHistory.length > 0 ? yearHistory : [{
      quarter: qEnd, totalAssets: yearEndTA, stores: yearEndStores,
      netIncome: lastNetIncome, phase: getPhase(qEnd).name
    }];
    const maxTA     = Math.max(...chartData.map(h => h.totalAssets), yearEndTA, 1);
    const maxStores = Math.max(...chartData.map(h => h.stores), yearEndStores, 1);
    const lastSnapshot = yearHistory[yearHistory.length-1]?.npcSnapshot
      || npcs.map(n => ({id:n.id, name:n.name, color:n.color, stores:Math.floor(n.ops.stores)||0, totalAssets:totalAssets(n.bs)}));

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

          {/* 総資産推移バーグラフ */}
          <Panel style={{marginBottom:14}}>
            <Label style={{display:"block", marginBottom:10}}>総資産推移（Year {completedYear}）</Label>
            <div style={{display:"flex", alignItems:"flex-end", gap:6, height:80}}>
              {chartData.map((h,i)=>(
                <div key={i} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
                  <div style={{fontSize:9, color:C.muted, fontFamily:"'Courier New',monospace"}}>
                    ¥{Math.round(h.totalAssets/100)/10}k
                  </div>
                  <div style={{width:"100%", background:h.netIncome>=0?C.cyan:C.red, borderRadius:"3px 3px 0 0",
                    height:`${Math.max(4, h.totalAssets/maxTA*64)}px`,
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
              <Label style={{display:"block", marginBottom:10}}>期末シェア比較</Label>
              {[{name:"あなた", stores:yearEndStores, color:C.cyan, ta:yearEndTA}, ...lastSnapshot.map(n=>({name:n.name, stores:n.stores, color:n.color, ta:n.totalAssets}))].map((p,i)=>{
                const maxTAAll = Math.max(...[yearEndTA, ...lastSnapshot.map(n=>n.totalAssets)], 1);
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
            {[["🏦 総資産",`¥${totalAssets(pf?.bs||{cash:0,softwareAsset:0,otherAsset:0}).toLocaleString()}万`,C.cyan],
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
            <Label style={{display:"block",marginBottom:12}}>最終スコアボード（総資産）</Label>
            {allPlayers.map((p,i)=>(
              <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:i<allPlayers.length-1?`1px solid ${C.border}`:"none"}}>
                <span style={{fontSize:20}}>{i===0?"🥇":i===1?"🥈":"🥉"}</span>
                <span style={{fontSize:20}}>{p.icon}</span>
                <div style={{flex:1,textAlign:"left"}}>
                  <div style={{fontSize:13,fontWeight:700,color:p.color}}>{p.name}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:15,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{p.totalAssets.toLocaleString()}万</div>
                  <div style={{fontSize:10,color:C.muted}}>{p.stores}店舗</div>
                </div>
              </div>
            ))}
          </Panel>
          <button onClick={()=>{
            setScreen("lobby");setMarketId(null);setPlayerType(null);setBs(null);setOps(null);
            setQuarter(1);setUsedSpecials([]);setHistory([]);setLastPL(null);setLastEvent(null);
            setLastNetIncome(0);setPrevNpcOps({});setNarratives([]);
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
          {lastPL.playerAlloc && (
            <Panel style={{marginBottom:14}}>
              <Label style={{display:"block",marginBottom:8}}>今期の予算配分</Label>
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
          {/* 競争ナラティブメッセージ */}
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

          {/* マーケットシェア */}
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

          {/* 競争スコア差の警告 */}
          {(() => {
            const myScore = competitiveScore(ops, market?.arpu);
            const threats = npcs.filter(n => competitiveScore(n.ops, market?.arpu) > myScore + 5);
            if (threats.length === 0) return null;
            return (
              <div style={{background:"#F8514912",border:"1px solid #F8514944",borderRadius:8,padding:"10px 14px",marginBottom:14}}>
                <div style={{fontSize:12,fontWeight:700,color:"#F85149",marginBottom:6}}>⚠️ スコア劣位 — 来Q以降の流出リスク</div>
                {threats.map(n => {
                  const diff = competitiveScore(n.ops, market?.arpu) - myScore;
                  const lossRate = Math.min(20, Math.floor(diff * 0.25 * getPhase(quarter).stealMultiplier));
                  return (
                    <div key={n.id} style={{fontSize:11,color:"#8B949E",marginTop:3}}>
                      <span style={{color:n.color,fontWeight:700}}>{n.name}</span>
                      {" "}にスコアで{diff.toFixed(1)}差をつけられている。
                      現在{ops.stores}店なら来Q約<span style={{color:"#F85149",fontWeight:700}}>{Math.floor(ops.stores*lossRate/100)}店</span>の流出予測。
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <PLTable pl={lastPL}/>

          {/* 競争内訳 */}
          <Panel style={{marginTop:14}}>
            <Label style={{display:"block",marginBottom:10}}>今Q 競争結果の内訳</Label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:10}}>
              {[["🆕 未開拓から獲得",`+${cr?.newFromUnclaimed||0}店`,"#3FB950"],
                ["⚔️ 競合から奪取",`+${cr?.stolenFromRivals||0}店`,"#00C8D4"],
                ["💔 自然解約",`-${cr?.naturalChurn||0}店`,"#F85149"],
                ["🏳️ 競合に奪われた",`-${cr?.lostToRivals||0}店`,"#FFA657"],
              ].map(([l,v,c])=>(
                <div key={l} style={{background:"#0D1117",borderRadius:8,padding:"8px 12px",display:"flex",justifyContent:"space-between",border:`1px solid ${C.border}`}}>
                  <span style={{fontSize:11,color:"#8B949E"}}>{l}</span>
                  <span style={{fontSize:13,fontWeight:800,color:c,fontFamily:"'Courier New',monospace"}}>{v}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* 競合の動向（スコア変化付き）*/}
          <Panel style={{marginTop:14}}>
            <Label style={{display:"block",marginBottom:10}}>競合の動向</Label>
            {npcs.map(n => {
              const nScore = competitiveScore(n.ops, market?.arpu);
              const myScore = competitiveScore(ops, market?.arpu);
              const scoreDiff = nScore - myScore;
              return (
                <div key={n.id} style={{
                  padding:"10px 0", borderBottom:`1px solid ${C.border}`,
                  background: scoreDiff > 10 ? "#F8514908" : "transparent",
                  borderRadius: scoreDiff > 10 ? 6 : 0,
                }}>
                  <div style={{display:"flex",gap:12,alignItems:"center"}}>
                    <span style={{fontSize:20}}>{n.icon}</span>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:13,fontWeight:700,color:n.color}}>{n.name}</span>
                        {n.lastSpecial && (
                          <span style={{fontSize:10,background:`${C.cyan}22`,color:C.cyan,padding:"1px 8px",borderRadius:20}}>
                            ⚡{SPECIAL_ACTIONS[n.lastSpecial]?.name}
                          </span>
                        )}
                        {scoreDiff > 10 && (
                          <span style={{fontSize:10,background:"#F8514922",color:"#F85149",padding:"1px 8px",borderRadius:20}}>
                            ⚠️ スコア差+{scoreDiff.toFixed(0)}
                          </span>
                        )}
                      </div>
                      {/* パラメータ変化ハイライト */}
                      {prevNpcOps[n.id] && (() => {
                        const prev = prevNpcOps[n.id];
                        const changes = [
                          ["品質", n.ops.solutionQuality - prev.solutionQuality, C.purple],
                          ["営業", n.ops.salesPower - prev.salesPower, C.cyan],
                          ["ブランド", n.ops.brandAwareness - prev.brandAwareness, C.yellow],
                          
                          ["CS", n.ops.supportQuality - prev.supportQuality, C.orange],
                        ].filter(([,v]) => Math.abs(v) >= 0.5);
                        return changes.length > 0 ? (
                          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                            {changes.map(([l,v,c]) => (
                              <span key={l} style={{fontSize:10,color:v>0?c:"#F85149",background:`${v>0?c:"#F85149"}18`,padding:"1px 7px",borderRadius:20}}>
                                {l} {v>0?"+":""}{v.toFixed(1)}
                              </span>
                            ))}
                          </div>
                        ) : null;
                      })()}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontWeight:700,color:C.cyan,fontFamily:"'Courier New',monospace"}}>
                        ¥{totalAssets(n.bs).toLocaleString()}万
                      </div>
                      <div style={{fontSize:10,color:C.muted}}>
                        {n.ops.stores}店 / score:{nScore.toFixed(0)}
                        {scoreDiff >= 0 ? <span style={{color:"#F85149"}}> (+{scoreDiff.toFixed(0)})</span>
                                        : <span style={{color:"#3FB950"}}> ({scoreDiff.toFixed(0)})</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </Panel>
          <button onClick={advance} style={{marginTop:18,width:"100%",background:`linear-gradient(135deg,#006080,${C.cyan})`,color:"#fff",border:"none",borderRadius:10,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",letterSpacing:2}}>
            {quarter>=MAX_QUARTERS?"最終結果を見る 🏁":`Year ${Math.ceil((quarter+1)/4)} Q${(quarter%4)+1} へ →`}
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
            <div style={{fontSize:9,color:C.muted,letterSpacing:2,textTransform:"uppercase"}}>総資産（勝利条件）</div>
            <div style={{fontSize:18,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{totalAssets(bs).toLocaleString()}万</div>
            <div style={{fontSize:10,color:bs.cash<50?C.red:C.muted}}>現預金 ¥{bs.cash}万</div>
          </div>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"16px 16px 40px"}}>
        {/* KPI Row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {[["🏦 総資産",`¥${totalAssets(bs).toLocaleString()}万`,C.cyan,true],
            ["💚 純資産",`¥${equity(bs).toLocaleString()}万`,equity(bs)>=0?C.green:C.red],
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
          {[["budget","💰 予算配分"],["special","⚡ 特別アクション"],["bs","🏦 BS/財務"],["ops","📊 競争力"],["rank","🏆 順位"]].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{flex:1,background:tab===id?`linear-gradient(135deg,#006080,${C.cyan})`:"transparent",color:tab===id?"#fff":C.muted,border:"none",borderRadius:8,padding:"8px 4px",fontSize:11,fontWeight:600,cursor:"pointer",transition:"all 0.18s"}}>
              {label}
            </button>
          ))}
        </div>

        {/* BUDGET TAB */}
        {tab==="budget" && (
          <>
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
            {history.length>0&&(
              <Panel style={{marginTop:14}}>
                <Label style={{display:"block",marginBottom:10}}>総資産推移</Label>
                <div style={{display:"flex",alignItems:"flex-end",gap:4,height:70}}>
                  {history.map((h,i)=>{
                    const max=Math.max(...history.map(x=>x.totalAssets),totalAssets(bs),1);
                    return (
                      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <div style={{width:"100%",background:h.netIncome>=0?C.cyan:C.red,borderRadius:"3px 3px 0 0",
                          height:`${Math.max(3,h.totalAssets/max*60)}px`,transition:"height 0.3s",
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
              <Label style={{display:"block",marginBottom:12}}>競争力パラメータ（vs 競合）</Label>
              {[["⚙️ ソリューション品質","solutionQuality",C.purple],
                ["👥 営業力","salesPower",C.cyan],
                ["📢 ブランド認知","brandAwareness",C.yellow],
                ["🎧 サポート品質","supportQuality",C.orange]
              ].map(([l,k,c])=>(
                <div key={k} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:11,color:C.muted}}>{l}</span>
                    <div style={{display:"flex",gap:8,fontSize:11}}>
                      <span style={{color:c,fontWeight:800}}>{Number(ops[k]).toFixed(1)}</span>
                      {npcs.map(n=>(
                        <span key={n.id} style={{color:n.color}}>{Number(n.ops[k]).toFixed(1)}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{position:"relative",height:6}}>
                    <Bar value={ops[k]} color={c} max={PARAM_MAX}/>
                    {npcs.map((n,i)=>(
                      <div key={n.id} style={{position:"absolute",top:0,left:`${Math.min(100,n.ops[k]/PARAM_MAX*100)}%`,width:2,height:6,background:n.color,borderRadius:1}}/>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{marginTop:8,fontSize:10,color:C.muted}}>縦線 = 競合のスコア位置</div>
            </Panel>
            <div>
              <Panel style={{marginBottom:12}}>
                <Label style={{display:"block",marginBottom:10}}>競争力スコア比較</Label>
                {[{name:"あなた",score:competitiveScore(ops, market?.arpu),color:C.cyan,isPlayer:true},...npcs.map(n=>({name:n.name,score:competitiveScore(n.ops, market?.arpu),color:n.color}))].map(p=>(
                  <div key={p.name} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <span style={{fontSize:11,color:p.isPlayer?C.cyan:p.color,fontWeight:p.isPlayer?700:400}}>{p.name}</span>
                      <span style={{fontSize:12,fontWeight:800,color:p.color,fontFamily:"'Courier New',monospace"}}>{p.score.toFixed(1)}</span>
                    </div>
                    <Bar value={p.score} color={p.color} max={150}/>
                  </div>
                ))}
              </Panel>
              <Panel>
                <Label style={{display:"block",marginBottom:10}}>経営指標</Label>
                {[["推計売上/Q",`¥${calcRevenue(ops,market).toLocaleString()}万`],
                  ["解約率",`${(calcChurn(ops)*100).toFixed(1)}%`],
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
              const taGrowth = lastQ.totalAssets - (history.find(h=>h.quarter===qStart-1)?.totalAssets || (yr===1?totalAssets(PLAYER_TYPES[playerType]?.bs||{cash:0,softwareAsset:0,otherAsset:0}):0));
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
                      <div style={{fontSize:9,color:C.muted}}>総資産増減</div>
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
              <Label style={{display:"block",marginBottom:14}}>スコアボード — 勝利条件: 総資産最大</Label>
              {allPlayers.map((p,i)=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 8px",
                  borderBottom:i<allPlayers.length-1?`1px solid ${C.border}`:"none",
                  background:p.isPlayer?"#00C8D411":"transparent",borderRadius:8}}>
                  <span style={{fontSize:20,width:24,textAlign:"center"}}>{i===0?"🥇":i===1?"🥈":"🥉"}</span>
                  <span style={{fontSize:20}}>{p.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:p.color}}>{p.name}</div>
                    <div style={{fontSize:10,color:C.muted}}>{p.stores}店 | 純資産¥{equity(p.bs).toLocaleString()}万 | score:{competitiveScore(p.ops, market?.arpu).toFixed(0)}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:16,fontWeight:900,color:C.cyan,fontFamily:"'Courier New',monospace"}}>¥{p.totalAssets.toLocaleString()}万</div>
                    <div style={{fontSize:9,color:C.muted}}>総資産</div>
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
