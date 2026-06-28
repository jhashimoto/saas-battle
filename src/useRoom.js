import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase.js";
import { ref, set, get, update, onValue, off, serverTimestamp } from "firebase/database";

const GAME_VERSION = "5.6";
const STORAGE_KEY = `saas_battle_room_v${GAME_VERSION}`;
const TUTORIAL_KEY = `saas_tutorial_done_v${GAME_VERSION}`;
// ★ App.jsx側のDEV_FOCUS_TYPESと同じキー一覧（市場ニーズの初期化に使用。循環import回避のためここに複製）
const DEV_FOCUS_KEYS_FOR_ROOM = ["efficiency", "uiux", "reliability"];

function clearOldVersionCache() {
  try {
    Object.keys(localStorage).forEach(key => {
      if ((key.startsWith("saas_battle_room") || key.startsWith("saas_tutorial_done")) && key !== STORAGE_KEY && key !== TUTORIAL_KEY) {
        localStorage.removeItem(key);
      }
    });
  } catch(e) {}
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function saveRoomToStorage(roomCode, playerId, isHost) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, playerId, isHost, savedAt: Date.now(), version: GAME_VERSION })); } catch(e) {}
}

function loadRoomFromStorage() {
  try {
    clearOldVersionCache();
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return null;
    const d = JSON.parse(s);
    if (d.version !== GAME_VERSION) { localStorage.removeItem(STORAGE_KEY); return null; }
    if (Date.now() - d.savedAt > 6 * 60 * 60 * 1000) { localStorage.removeItem(STORAGE_KEY); return null; }
    return d;
  } catch(e) { return null; }
}

function clearRoomStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
}

export { GAME_VERSION, TUTORIAL_KEY, clearRoomStorage };

export function useRoom() {
  const saved = loadRoomFromStorage();
  const [roomCode, setRoomCode] = useState(saved?.roomCode || null);
  const [playerId, setPlayerId] = useState(saved?.playerId || null);
  const [isHost, setIsHost] = useState(saved?.isHost || false);
  const [roomData, setRoomData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    onValue(roomRef, (snap) => {
      if (snap.exists()) setRoomData(snap.val());
      else { setRoomData(null); clearRoomStorage(); }
    });
    return () => off(roomRef);
  }, [roomCode]);

  const createRoom = useCallback(async (playerName, marketId, playerType) => {
    setLoading(true); setError(null);
    try {
      let code;
      for (let i = 0; i < 10; i++) {
        code = generateRoomCode();
        const snap = await get(ref(db, `rooms/${code}`));
        if (!snap.exists()) break;
      }
      const pid = `p_${Date.now()}`;
      await set(ref(db, `rooms/${code}`), {
        host: pid, status: "waiting", marketId, quarter: 1, version: GAME_VERSION,
        createdAt: serverTimestamp(),
        players: { [pid]: { name: playerName, playerType, ready: false, isHost: true, joinedAt: serverTimestamp() } }
      });
      setRoomCode(code); setPlayerId(pid); setIsHost(true);
      saveRoomToStorage(code, pid, true);
    } catch(e) { setError("ルームの作成に失敗しました: " + e.message); }
    finally { setLoading(false); }
  }, []);

  const joinRoom = useCallback(async (code, playerName, playerType) => {
    setLoading(true); setError(null);
    try {
      const snap = await get(ref(db, `rooms/${code}`));
      if (!snap.exists()) { setError("ルームが見つかりません"); setLoading(false); return; }
      const room = snap.val();
      if (room.status !== "waiting") { setError("このルームはすでにゲームが始まっています"); setLoading(false); return; }
      if (room.version && room.version !== GAME_VERSION) { setError("バージョンが異なります。ページを再読み込みしてください"); setLoading(false); return; }
      const players = room.players || {};
      if (Object.keys(players).length >= 3) { setError("ルームが満員です（最大3人）"); setLoading(false); return; }
      const pid = `p_${Date.now()}`;
      await update(ref(db, `rooms/${code}/players/${pid}`), { name: playerName, playerType, ready: false, isHost: false, joinedAt: serverTimestamp() });
      setRoomCode(code); setPlayerId(pid); setIsHost(false);
      saveRoomToStorage(code, pid, false);
    } catch(e) { setError("参加に失敗しました: " + e.message); }
    finally { setLoading(false); }
  }, []);

  const startGame = useCallback(async (initialStates) => {
    if (!isHost || !roomCode) return;
    // ★ 市場ニーズ（全員共通、非公開）の初期値をランダムに設定
    const initialMarketNeed = DEV_FOCUS_KEYS_FOR_ROOM[Math.floor(Math.random() * DEV_FOCUS_KEYS_FOR_ROOM.length)];
    await update(ref(db, `rooms/${roomCode}`), { status: "playing", quarter: 1, gameState: initialStates, marketNeed: initialMarketNeed });
  }, [isHost, roomCode]);

  const submitAllocation = useCallback(async (allocation, specialAction) => {
    if (!roomCode || !playerId) return;
    await update(ref(db, `rooms/${roomCode}/players/${playerId}`), { ready: true, allocation, specialAction: specialAction || null });
  }, [roomCode, playerId]);

  // ★ ③外交：不戦条約の提案（targetIdに対して提案を送る）
  const proposeTruce = useCallback(async (targetId) => {
    if (!roomCode || !playerId || !targetId) return;
    const key = [playerId, targetId].sort().join("_");
    await update(ref(db, `rooms/${roomCode}/truceProposals/${key}`), {
      from: playerId, to: targetId, status: "pending",
    });
  }, [roomCode, playerId]);

  // ★ ③外交：不戦条約への応答（accepted: true/false）
  const respondTruce = useCallback(async (proposerId, accepted) => {
    if (!roomCode || !playerId || !proposerId) return;
    const key = [playerId, proposerId].sort().join("_");
    await update(ref(db, `rooms/${roomCode}/truceProposals/${key}`), {
      status: accepted ? "accepted" : "declined",
    });
  }, [roomCode, playerId]);

  // ★ 不戦条約データをクリア（Q確定時にホストが呼ぶ）
  const clearTruceProposals = useCallback(async () => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), { truceProposals: null });
  }, [isHost, roomCode]);

  const writeQuarterResult = useCallback(async (newQuarter, gameState, quarterLogs, status = "result", nextMarketNeed) => {
    if (!isHost || !roomCode) return;
    const payload = { quarter: newQuarter, status, gameState, quarterLogs, lastUpdated: serverTimestamp(), truceProposals: null };
    if (nextMarketNeed) payload.marketNeed = nextMarketNeed;
    await update(ref(db, `rooms/${roomCode}`), payload);
    const players = roomData?.players || {};
    const updates = {};
    Object.keys(players).forEach(pid => {
      updates[`rooms/${roomCode}/players/${pid}/ready`] = false;
      updates[`rooms/${roomCode}/players/${pid}/allocation`] = null;
      updates[`rooms/${roomCode}/players/${pid}/specialAction`] = null;
    });
    if (Object.keys(updates).length > 0) await update(ref(db), updates);
  }, [isHost, roomCode, roomData]);

  const advanceYear = useCallback(async () => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), { status: "playing" });
  }, [isHost, roomCode]);

  const leaveRoom = useCallback(() => {
    clearRoomStorage();
    setRoomCode(null); setPlayerId(null); setIsHost(false); setRoomData(null);
  }, []);

  return {
    roomCode, roomData, playerId, isHost, error, loading,
    allReady: roomData?.players ? Object.values(roomData.players).every(p => p.ready) : false,
    createRoom, joinRoom, startGame, submitAllocation, writeQuarterResult, advanceYear, leaveRoom,
    proposeTruce, respondTruce, clearTruceProposals,
    myPlayer: roomData?.players?.[playerId] || null,
    players: roomData?.players ? Object.entries(roomData.players).map(([id, p]) => ({...p, id})) : [],
  };
}
