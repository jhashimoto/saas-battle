import liff from "@line/liff";

const LIFF_ID = import.meta.env.VITE_LIFF_ID;

// liff.getProfile()の結果をキャッシュ（初期化完了後に同期的に参照できるようにする）
export let lineProfile = null;

export async function initLiff() {
  if (!LIFF_ID) {
    console.warn("VITE_LIFF_ID が未設定のため、LIFF連携をスキップします（LINE外ブラウザとして動作）");
    return;
  }
  try {
    await liff.init({ liffId: LIFF_ID });
    // LINEアプリ内では自動的にログイン済みになる。外部ブラウザ（開発時など）でログインしていない場合は
    // 強制ログインさせず、プロフィール自動反映のみスキップして通常通り動作させる。
    if (liff.isLoggedIn()) {
      lineProfile = await liff.getProfile();
    }
  } catch (e) {
    console.warn("LIFF初期化に失敗しました。LINE外ブラウザとして動作します:", e);
  }
}

export function isInLineClient() {
  try { return liff.isInClient(); } catch (e) { return false; }
}

export { liff };
