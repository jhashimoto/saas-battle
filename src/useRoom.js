import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase.js";
import {
  ref, set, get, update, onValue, off, push, serverTimestamp
} from "firebase/database";

// 4桁のルームコード生成
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function useRoom() {
  const [roomCode, setRoomCode]     = useState(null);
  const [roomData, setRoomData]     = useState(null);
  const [playerId, setPlayerId]     = useState(null);
  const [isHost, setIsHost]         = useState(false);
  const [error, setError]           = useState(null);
  const [loading, setLoading]       = useState(false);

  // ルームのリアルタイム監視
  useEffect(() => {
    if (!roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    onValue(roomRef, (snap) => {
      if (snap.exists()) setRoomData(snap.val());
    });
    return () => off(roomRef);
  }, [roomCode]);

  // ルーム作成
  const createRoom = useCallback(async (playerName, marketId, playerType) => {
    setLoading(true);
    setError(null);
    try {
      let code;
      // コードの重複チェック
      for (let i = 0; i < 10; i++) {
        code = generateRoomCode();
        const snap = await get(ref(db, `rooms/${code}`));
        if (!snap.exists()) break;
      }
      const pid = `p_${Date.now()}`;
      await set(ref(db, `rooms/${code}`), {
        host: pid,
        status: "waiting",       // waiting | setup | playing | result | yearreview
        marketId,
        quarter: 1,
        createdAt: serverTimestamp(),
        players: {
          [pid]: {
            name: playerName,
            playerType,
            ready: false,
            isHost: true,
            joinedAt: serverTimestamp(),
          }
        }
      });
      setRoomCode(code);
      setPlayerId(pid);
      setIsHost(true);
    } catch (e) {
      setError("ルームの作成に失敗しました: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ルーム参加
  const joinRoom = useCallback(async (code, playerName, playerType) => {
    setLoading(true);
    setError(null);
    try {
      const snap = await get(ref(db, `rooms/${code}`));
      if (!snap.exists()) { setError("ルームが見つかりません"); setLoading(false); return; }
      const room = snap.val();
      if (room.status !== "waiting") { setError("このルームはすでにゲームが始まっています"); setLoading(false); return; }
      const players = room.players || {};
      if (Object.keys(players).length >= 3) { setError("ルームが満員です（最大3人）"); setLoading(false); return; }

      const pid = `p_${Date.now()}`;
      await update(ref(db, `rooms/${code}/players/${pid}`), {
        name: playerName,
        playerType,
        ready: false,
        isHost: false,
        joinedAt: serverTimestamp(),
      });
      setRoomCode(code);
      setPlayerId(pid);
      setIsHost(false);
    } catch (e) {
      setError("参加に失敗しました: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ゲーム開始（ホストのみ）
  const startGame = useCallback(async (initialStates) => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), {
      status: "playing",
      quarter: 1,
      gameState: initialStates, // { [playerId]: { bs, ops, usedSpecials, ... } }
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

  // Ready解除
  const unready = useCallback(async () => {
    if (!roomCode || !playerId) return;
    await update(ref(db, `rooms/${roomCode}/players/${playerId}`), {
      ready: false,
    });
  }, [roomCode, playerId]);

  // 全員のReady状態チェック
  const allReady = roomData?.players
    ? Object.values(roomData.players).every(p => p.ready)
    : false;

  // 四半期結果を書き込む（ホストのみ）
  const writeQuarterResult = useCallback(async (newQuarter, gameState, quarterLogs, status = "result") => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), {
      quarter: newQuarter,
      status,
      gameState,
      quarterLogs,
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
    await update(ref(db), updates);
  }, [isHost, roomCode, roomData]);

  // 年次レビュー→次年度への移行
  const advanceYear = useCallback(async () => {
    if (!isHost || !roomCode) return;
    await update(ref(db, `rooms/${roomCode}`), { status: "playing" });
  }, [isHost, roomCode]);

  return {
    roomCode, roomData, playerId, isHost, error, loading, allReady,
    createRoom, joinRoom, startGame, submitAllocation, unready,
    writeQuarterResult, advanceYear,
    myPlayer: roomData?.players?.[playerId] || null,
    players: roomData?.players ? Object.entries(roomData.players).map(([id, p]) => ({...p, id})) : [],
  };
}
