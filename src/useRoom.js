import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase.js";
import {
  ref, set, get, update, onValue, off, serverTimestamp
} from "firebase/database";

const STORAGE_KEY = "saas_battle_room";

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// localStorage にルーム情報を保存・復元
function saveRoomToStorage(roomCode, playerId, isHost) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({roomCode, playerId, isHost, savedAt: Date.now()})); } catch(e) {}
}
function loadRoomFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return null;
    const d = JSON.parse(s);
    // 24時間以上経過したら無効
    if (Date.now() - d.savedAt > 24 * 60 * 60 * 1000) { localStorage.removeItem(STORAGE_KEY); return null; }
    return d;
  } catch(e) { return null; }
}
function clearRoomStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
}

export function useRoom() {
  // localStorage から復元を試みる
  const saved = loadRoomFromStorage();
  const [roomCode, setRoomCode]   = useState(saved?.roomCode || null);
  const [playerId, setPlayerId]   = useState(saved?.playerId || null);
  const [isHost, setIsHost]       = useState(saved?.isHost || false);
  const [roomData, setRoomData]   = useState(null);
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(false);

  // ルームのリアルタイム監視
  useEffect(() => {
    if (!roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    onValue(roomRef, (snap) => {
      if (snap.exists()) {
        setRoomData(snap.val());
      } else {
        // ルームが削除された
        setRoomData(null);
        clearRoomStorage();
      }
    });
    return () => off(roomRef);
  }, [roomCode]);

  // ルーム作成
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
        host: pid,
        status: "waiting",
        marketId,
        quarter: 1,
        createdAt: serverTimestamp(),
        players: {
          [pid]: { name: playerName, playerType, ready: false, isHost: true, joinedAt: serverTimestamp() }
        }
      });
      setRoomCode(code); setPlayerId(pid); setIsHost(true);
      saveRoomToStorage(code, pid, true);
    } catch (e) {
      setError("ルームの作成に失敗しました: " + e.message);
    } finally { setLoading(false); }
  }, []);

  // ルーム参加
  const joinRoom = useCallback(async (code, playerName, playerType) => {
    setLoading(true); setError(null);
    try {
      const snap = await get(ref(db, `rooms/${code}`));
      if (!snap.exists()) { setError("ルームが見つかりません"); setLoading(false); return; }
      const room = snap.val();
      if (room.status !== "waiting") { setError("このルームはすでにゲームが始まっています"); setLoading(false); return; }
      const players = room.players || {};
      if (Object.keys(players).length >= 3) { setError("ルームが満員です（最大3人）"); setLoading(false); return; }
      const pid = `p_${Date.now()}`;
      await update(ref(db, `rooms/${code}/players/${pid}`), {
        name: playerName, playerType, ready: false, isHost: false, joinedAt: serverTimestamp(),
      });
      setRoomCode(code); setPlayerId(pid); setIsHost(false);
      saveRoomToStorage(code, pid, false);
    } catch (e) {
      setError("参加に失敗しました: " + e.message);
    } finally { setLoading(false); }
  }, []);

  // ゲーム開始（ホストのみ）
  const startGame = useCallback(async (initialStates) => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), {
      status: "playing",
      quarter: 1,
      gameState: initialStates,
    });
  }, [isHost, roomCode]);

  // 配分を提出（Ready）
  const submitAllocation = useCallback(async (allocation, specialAction) => {
    if (!roomCode || !playerId) return;
    await update(ref(db, `rooms/${roomCode}/players/${playerId}`), {
      ready: true,
      allocation,
      specialAction: specialAction || null,
    });
  }, [roomCode, playerId]);

  // 四半期結果を書き込む（ホストのみ）
  const writeQuarterResult = useCallback(async (newQuarter, gameState, quarterLogs, status = "result") => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), {
      quarter: newQuarter, status, gameState, quarterLogs,
      lastUpdated: serverTimestamp(),
    });
    // 全員のready状態をリセット
    const players = roomData?.players || {};
    const updates = {};
    Object.keys(players).forEach(pid => {
      updates[`rooms/${roomCode}/players/${pid}/ready`] = false;
      updates[`rooms/${roomCode}/players/${pid}/allocation`] = null;
      updates[`rooms/${roomCode}/players/${pid}/specialAction`] = null;
    });
    if (Object.keys(updates).length > 0) await update(ref(db), updates);
  }, [isHost, roomCode, roomData]);

  // 年次レビュー→次年度
  const advanceYear = useCallback(async () => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), { status: "playing" });
  }, [isHost, roomCode]);

  // ルームを離れる
  const leaveRoom = useCallback(() => {
    clearRoomStorage();
    setRoomCode(null); setPlayerId(null); setIsHost(false); setRoomData(null);
  }, []);

  const allReady = roomData?.players
    ? Object.values(roomData.players).every(p => p.ready)
    : false;

  const players = roomData?.players
    ? Object.entries(roomData.players).map(([id, p]) => ({...p, id}))
    : [];

  return {
    roomCode, roomData, playerId, isHost, error, loading, allReady,
    createRoom, joinRoom, startGame, submitAllocation,
    writeQuarterResult, advanceYear, leaveRoom,
    myPlayer: roomData?.players?.[playerId] || null,
    players,
  };
}
